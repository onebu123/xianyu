import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { Pool } from 'pg';

import { StatisticsDatabase } from './database.js';
import type { BootstrapAdminConfig, DatabaseInitializeOptions } from './types.js';

interface SqliteMasterRow {
  name: string;
}

interface SqliteColumnRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

interface SqliteIndexRow {
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

interface SqliteIndexInfoRow {
  seqno: number;
  cid: number;
  name: string;
}

export interface SqliteToPostgresMigrationSummary {
  sourceDbPath: string;
  targetPostgresUrl: string;
  targetSchema: string;
  tableCount: number;
  tables: Array<{ table: string; rowCount: number; indexCount: number }>;
}

function quotePgIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function quoteSqliteIdentifier(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function mapSqliteTypeToPostgres(type: string, isPrimaryKey: boolean) {
  const normalized = type.trim().toUpperCase();

  if (normalized.includes('INT')) {
    return isPrimaryKey ? 'BIGSERIAL' : 'BIGINT';
  }
  if (
    normalized.includes('REAL') ||
    normalized.includes('FLOA') ||
    normalized.includes('DOUB')
  ) {
    return 'DOUBLE PRECISION';
  }
  if (
    normalized.includes('NUM') ||
    normalized.includes('DEC') ||
    normalized.includes('BOOL')
  ) {
    return 'NUMERIC';
  }
  if (normalized.includes('BLOB')) {
    return 'BYTEA';
  }
  if (normalized.includes('DATE') || normalized.includes('TIME')) {
    return 'TEXT';
  }
  return 'TEXT';
}

function normalizeDefaultValue(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }

  const raw = String(value).trim();
  if (!raw) {
    return null;
  }
  if (/^null$/i.test(raw)) {
    return null;
  }
  if (/^(current_timestamp|current_time|current_date)$/i.test(raw)) {
    return raw.toUpperCase();
  }
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    return raw;
  }
  if (
    (raw.startsWith("'") && raw.endsWith("'")) ||
    (raw.startsWith('"') && raw.endsWith('"'))
  ) {
    const text = raw.slice(1, -1).replace(/'/g, "''");
    return `'${text}'`;
  }

  return null;
}

export async function migrateSqliteBusinessDatabaseToPostgres(input: {
  sourceDbPath: string;
  targetPostgresUrl: string;
  targetSchema?: string;
  truncateBeforeLoad?: boolean;
}): Promise<SqliteToPostgresMigrationSummary> {
  const sourceDbPath = path.resolve(input.sourceDbPath);
  const targetSchema = input.targetSchema?.trim() || 'public';
  const truncateBeforeLoad = input.truncateBeforeLoad !== false;

  if (!fs.existsSync(sourceDbPath)) {
    throw new Error(`SQLite business database does not exist: ${sourceDbPath}`);
  }

  const sqlite = new Database(sourceDbPath, { readonly: true });
  const pool = new Pool({
    connectionString: input.targetPostgresUrl,
    max: 4,
  });

  const summary: SqliteToPostgresMigrationSummary['tables'] = [];

  try {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quotePgIdentifier(targetSchema)}`);

    const tables = sqlite
      .prepare(
        `
          SELECT name
          FROM sqlite_master
          WHERE type = 'table'
            AND name NOT LIKE 'sqlite_%'
          ORDER BY name ASC
        `,
      )
      .all() as SqliteMasterRow[];

    for (const table of tables) {
      const tableName = table.name;
      const quotedSqliteTable = quoteSqliteIdentifier(tableName);
      const quotedPgTable = `${quotePgIdentifier(targetSchema)}.${quotePgIdentifier(tableName)}`;

      const columns = sqlite
        .prepare(`PRAGMA table_info(${quotedSqliteTable})`)
        .all() as SqliteColumnRow[];

      if (columns.length === 0) {
        continue;
      }

      const primaryKeyColumns = [...columns]
        .filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk);
      const serialPrimaryKeyColumn =
        primaryKeyColumns.length === 1 &&
        primaryKeyColumns[0] &&
        primaryKeyColumns[0].type.trim().toUpperCase().includes('INT')
          ? primaryKeyColumns[0]
          : null;

      const columnDefinitions = columns.map((column) => {
        const defaultValue = normalizeDefaultValue(column.dflt_value);
        const isPrimaryKeyColumn =
          primaryKeyColumns.length === 1 && primaryKeyColumns[0]?.name === column.name;
        const postgresType = mapSqliteTypeToPostgres(column.type, isPrimaryKeyColumn);
        return [
          quotePgIdentifier(column.name),
          postgresType,
          column.notnull ? 'NOT NULL' : '',
          defaultValue && postgresType !== 'BIGSERIAL' ? `DEFAULT ${defaultValue}` : '',
          isPrimaryKeyColumn ? 'PRIMARY KEY' : '',
        ]
          .filter(Boolean)
          .join(' ');
      });

      if (primaryKeyColumns.length > 1) {
        columnDefinitions.push(
          `PRIMARY KEY (${primaryKeyColumns
            .map((column) => quotePgIdentifier(column.name))
            .join(', ')})`,
        );
      }

      await pool.query(`
        CREATE TABLE IF NOT EXISTS ${quotedPgTable} (
          ${columnDefinitions.join(',\n          ')}
        )
      `);

      if (truncateBeforeLoad) {
        await pool.query(`TRUNCATE TABLE ${quotedPgTable} RESTART IDENTITY CASCADE`);
      }

      const rows = sqlite
        .prepare(`SELECT * FROM ${quotedSqliteTable}`)
        .all() as Array<Record<string, unknown>>;
      if (rows.length > 0) {
        const columnNames = columns.map((column) => column.name);
        const batchSize = 200;
        for (let start = 0; start < rows.length; start += batchSize) {
          const batch = rows.slice(start, start + batchSize);
          const values: unknown[] = [];
          const rowPlaceholders = batch.map((row, rowIndex) => {
            const placeholders = columnNames.map((_columnName, columnIndex) => {
              values.push(row[columnNames[columnIndex]] ?? null);
              return `$${rowIndex * columnNames.length + columnIndex + 1}`;
            });
            return `(${placeholders.join(', ')})`;
          });

          await pool.query(
            `
              INSERT INTO ${quotedPgTable} (${columnNames
                .map((columnName) => quotePgIdentifier(columnName))
                .join(', ')})
              VALUES ${rowPlaceholders.join(', ')}
            `,
            values,
          );
        }
      }

      if (serialPrimaryKeyColumn) {
        const sequenceResult = await pool.query(
          `
            SELECT pg_get_serial_sequence($1, $2) AS "sequenceName"
          `,
          [`${targetSchema}.${tableName}`, serialPrimaryKeyColumn.name],
        );
        const sequenceName = sequenceResult.rows[0]?.sequenceName as string | undefined;
        if (sequenceName) {
          const maxIdResult = await pool.query(
            `
              SELECT COALESCE(MAX(${quotePgIdentifier(serialPrimaryKeyColumn.name)}), 0) AS "maxId"
              FROM ${quotedPgTable}
            `,
          );
          const maxId = Number(maxIdResult.rows[0]?.maxId ?? 0);
          await pool.query(`SELECT setval($1::regclass, $2, $3)`, [
            sequenceName,
            Math.max(maxId, 1),
            maxId > 0,
          ]);
        }
      }

      const indexes = sqlite
        .prepare(`PRAGMA index_list(${quotedSqliteTable})`)
        .all() as SqliteIndexRow[];

      let createdIndexCount = 0;
      for (const index of indexes) {
        if (index.origin === 'pk' || index.partial) {
          continue;
        }

        const indexColumns = sqlite
          .prepare(`PRAGMA index_info(${quoteSqliteIdentifier(index.name)})`)
          .all() as SqliteIndexInfoRow[];

        if (indexColumns.length === 0 || indexColumns.some((row) => !row.name)) {
          continue;
        }

        const safeIndexName = `${tableName}_${index.name}`.slice(0, 60);
        const quotedIndexName = quotePgIdentifier(safeIndexName);
        await pool.query(`
          CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${quotedIndexName}
          ON ${quotedPgTable} (${indexColumns
            .sort((left, right) => left.seqno - right.seqno)
            .map((row) => quotePgIdentifier(row.name))
            .join(', ')})
        `);
        createdIndexCount += 1;
      }

      summary.push({
        table: tableName,
        rowCount: rows.length,
        indexCount: createdIndexCount,
      });
    }

    return {
      sourceDbPath,
      targetPostgresUrl: input.targetPostgresUrl,
      targetSchema,
      tableCount: summary.length,
      tables: summary,
    };
  } finally {
    sqlite.close();
    await pool.end();
  }
}

export async function initializePostgresBusinessDatabaseFromSeed(input: {
  targetPostgresUrl: string;
  targetSchema?: string;
  initializeOptions: DatabaseInitializeOptions;
  tempRootPrefix?: string;
}) {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), input.tempRootPrefix ?? 'sale-compass-business-provision-'),
  );
  const tempSqlitePath = path.join(tempRoot, 'seed.db');

  try {
    const seedDb = new StatisticsDatabase(tempSqlitePath);
    seedDb.initialize(input.initializeOptions);
    seedDb.close();

    return await migrateSqliteBusinessDatabaseToPostgres({
      sourceDbPath: tempSqlitePath,
      targetPostgresUrl: input.targetPostgresUrl,
      targetSchema: input.targetSchema,
      truncateBeforeLoad: true,
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}
