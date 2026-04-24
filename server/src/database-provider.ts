import fs from 'node:fs';
import path from 'node:path';

import { initializePostgresBusinessDatabaseFromSeed } from './business-database-provisioning.js';
import { StatisticsDatabase } from './database.js';
import { PostgresBusinessReadAdapter } from './postgres-business-read-adapter.js';
import { getRequestContext } from './request-context.js';
import type {
  BootstrapAdminConfig,
  DatabaseEngine,
  DatabaseInitializeOptions,
  TenantRecord,
} from './types.js';

function normalizeTenantKey(tenantKey: string) {
  return tenantKey.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
}

export interface BusinessDatabaseRuntimeDescriptor {
  configuredEngine: DatabaseEngine;
  runtimeEngine: 'sqlite' | 'hybrid' | 'postgres';
  sqlitePath: string | null;
  postgresConfigured: boolean;
  runtimeReady: boolean;
  runtimeBlockedReason: string | null;
  readyCapabilities: string[];
  pendingCapabilities: string[];
}

export interface DatabaseProviderRuntimeSummary {
  privateDatabase: BusinessDatabaseRuntimeDescriptor;
  tenantDatabase: Omit<BusinessDatabaseRuntimeDescriptor, 'sqlitePath'> & {
    sqliteRootPath: string;
    postgresTemplateConfigured: boolean;
  };
}

export interface BusinessDatabaseProvisionTarget {
  scope: 'private' | 'tenant';
  tenantKey?: string;
  tenantId?: number;
}

export interface BusinessDatabaseHandle {
  close(): void | Promise<void>;
}

export class TenantDatabaseResolver {
  constructor(
    private readonly tenantDatabaseRoot: string,
    private readonly postgresUrlTemplate: string | null = null,
  ) {
    fs.mkdirSync(this.tenantDatabaseRoot, { recursive: true });
  }

  resolveBusinessDbPath(tenantKey: string, tenantId?: number) {
    const normalizedKey = normalizeTenantKey(tenantKey);
    const fileName = tenantId
      ? `tenant-${tenantId}-${normalizedKey || 'default'}.db`
      : `tenant-${normalizedKey || 'default'}.db`;
    return path.join(this.tenantDatabaseRoot, fileName);
  }

  resolveBusinessPostgresUrl(tenantKey: string, tenantId?: number) {
    if (!this.postgresUrlTemplate?.trim()) {
      return null;
    }

    const normalizedKey = normalizeTenantKey(tenantKey) || 'default';
    return this.postgresUrlTemplate
      .replace(/\{tenantKey\}/g, tenantKey.trim())
      .replace(/\{tenantKeyNormalized\}/g, normalizedKey)
      .replace(/\{tenantId\}/g, tenantId ? String(tenantId) : '');
  }
}

export class MigrationRunner {
  constructor(
    private readonly input: {
      businessDatabaseEngine: DatabaseEngine;
      businessPostgresUrl: string | null;
      tenantBusinessDatabaseEngine: DatabaseEngine;
      tenantResolver: TenantDatabaseResolver;
    },
  ) {}

  async initializeBusinessDatabase(
    dbPath: string,
    options: DatabaseInitializeOptions,
    target: BusinessDatabaseProvisionTarget = { scope: 'private' },
  ): Promise<BusinessDatabaseHandle> {
    if (target.scope === 'tenant') {
      if (this.input.tenantBusinessDatabaseEngine === 'postgres') {
        if (!target.tenantKey) {
          throw new Error('Tenant PostgreSQL provisioning requires tenantKey.');
        }
        const targetPostgresUrl = this.input.tenantResolver.resolveBusinessPostgresUrl(
          target.tenantKey,
          target.tenantId,
        );
        if (!targetPostgresUrl) {
          throw new Error('Tenant business PostgreSQL URL template is not configured.');
        }

        await initializePostgresBusinessDatabaseFromSeed({
          targetPostgresUrl,
          initializeOptions: options,
          tempRootPrefix: 'sale-compass-tenant-business-provision-',
        });
        return {
          async close() {},
        };
      }
    } else if (this.input.businessDatabaseEngine === 'postgres') {
      if (!this.input.businessPostgresUrl) {
        throw new Error('Business PostgreSQL URL is not configured.');
      }

      await initializePostgresBusinessDatabaseFromSeed({
        targetPostgresUrl: this.input.businessPostgresUrl,
        initializeOptions: options,
        tempRootPrefix: 'sale-compass-private-business-provision-',
      });
      return {
        async close() {},
      };
    }

    const db = new StatisticsDatabase(dbPath);
    db.initialize(options);
    return db;
  }
}

export interface DatabaseProviderOptions {
  privateDbPath: string;
  tenantDatabaseRoot: string;
  businessDatabaseEngine: DatabaseEngine;
  businessPostgresUrl: string | null;
  tenantBusinessDatabaseEngine: DatabaseEngine;
  tenantBusinessPostgresUrlTemplate: string | null;
  forceReseed?: boolean;
  runtimeMode?: DatabaseInitializeOptions['runtimeMode'];
  seedDemoData?: boolean;
  bootstrapAdmin?: BootstrapAdminConfig | null;
}

type DatabaseProviderRuntimeSummaryInput = Pick<
  DatabaseProviderOptions,
  | 'privateDbPath'
  | 'tenantDatabaseRoot'
  | 'businessDatabaseEngine'
  | 'businessPostgresUrl'
  | 'tenantBusinessDatabaseEngine'
  | 'tenantBusinessPostgresUrlTemplate'
>;

const PRIVATE_POSTGRES_READY_CAPABILITIES: string[] = [];
const PRIVATE_POSTGRES_PENDING_CAPABILITIES = [
  'private business runtime replacement for StatisticsDatabase',
];

const TENANT_POSTGRES_READY_CAPABILITIES = [
  'filter options',
  'dashboard',
  'orders overview',
  'orders list',
  'order detail',
  'orders export',
  'order fulfillment workbench',
  'after-sales workbench/list/detail',
  'reports read/export',
  'products',
  'customers',
  'metrics snapshot',
  'workspace overview',
  'workspace action/rule/task writes',
  'system-monitoring writes',
  'workspace-fund writes',
  'ai-service detail',
  'ai-service reply/takeover/manual-reply writes',
  'open-platform management reads',
  'open-platform management writes',
  'open-platform public verify/call log',
  'store auth session reads',
  'store auth session live-stream reads',
  'store auth session writes',
  'managed store activation/meta/enablement writes',
  'xianyu product/order sync writes',
  'fulfillment config writes',
  'fulfillment supply-source sync/order execution writes',
  'fulfillment direct-charge/card worker queue writes',
];

const TENANT_POSTGRES_PENDING_CAPABILITIES = [
  'ai-service auto-sync runtime wiring',
  'ai-bargain auto-sync runtime wiring',
];

function cloneCapabilities(capabilities: readonly string[]) {
  return [...capabilities];
}

function buildHybridRuntimeReason(params: {
  scope: 'private' | 'tenant';
  readyCapabilities: string[];
  pendingCapabilities: string[];
  postgresConfigured: boolean;
}) {
  const { scope, readyCapabilities, pendingCapabilities, postgresConfigured } = params;
  if (!postgresConfigured) {
    return scope === 'tenant'
      ? 'Tenant business PostgreSQL runtime target is enabled, but the tenant PostgreSQL URL template is not configured yet.'
      : 'Business PostgreSQL runtime target is enabled, but the PostgreSQL URL is not configured yet.';
  }

  if (pendingCapabilities.length === 0) {
    return null;
  }

  const readyPreview = readyCapabilities.slice(0, 6).join(', ');
  const extraReadyCount = Math.max(readyCapabilities.length - 6, 0);
  const readySuffix = extraReadyCount > 0 ? `, plus ${extraReadyCount} more migrated capabilities` : '';
  const scopeLabel = scope === 'tenant' ? 'Tenant business PostgreSQL runtime' : 'Business PostgreSQL runtime';
  return `${scopeLabel} is still hybrid. Remaining SQLite-primary capabilities: ${pendingCapabilities.join(', ')}. PostgreSQL-first coverage already includes ${readyPreview}${readySuffix}.`;
}

export function createDatabaseProviderRuntimeSummary(
  input: DatabaseProviderRuntimeSummaryInput,
): DatabaseProviderRuntimeSummary {
  const privatePostgresConfigured = Boolean(input.businessPostgresUrl);
  const privatePendingCapabilities =
    input.businessDatabaseEngine === 'postgres'
      ? cloneCapabilities(PRIVATE_POSTGRES_PENDING_CAPABILITIES)
      : [];
  const privateReadyCapabilities =
    input.businessDatabaseEngine === 'postgres'
      ? cloneCapabilities(PRIVATE_POSTGRES_READY_CAPABILITIES)
      : [];
  const tenantPostgresConfigured = Boolean(input.tenantBusinessPostgresUrlTemplate);
  const tenantReadyCapabilities =
    input.tenantBusinessDatabaseEngine === 'postgres'
      ? cloneCapabilities(TENANT_POSTGRES_READY_CAPABILITIES)
      : [];
  const tenantPendingCapabilities =
    input.tenantBusinessDatabaseEngine === 'postgres'
      ? cloneCapabilities(TENANT_POSTGRES_PENDING_CAPABILITIES)
      : [];

  return {
    privateDatabase: {
      configuredEngine: input.businessDatabaseEngine,
      runtimeEngine:
        input.businessDatabaseEngine === 'postgres' && privatePendingCapabilities.length === 0
          ? 'postgres'
          : 'sqlite',
      sqlitePath: input.privateDbPath,
      postgresConfigured: privatePostgresConfigured,
      runtimeReady:
        input.businessDatabaseEngine === 'sqlite' ||
        (privatePostgresConfigured && privatePendingCapabilities.length === 0),
      runtimeBlockedReason:
        input.businessDatabaseEngine === 'sqlite'
          ? null
          : buildHybridRuntimeReason({
              scope: 'private',
              readyCapabilities: privateReadyCapabilities,
              pendingCapabilities: privatePendingCapabilities,
              postgresConfigured: privatePostgresConfigured,
            }),
      readyCapabilities: privateReadyCapabilities,
      pendingCapabilities: privatePendingCapabilities,
    },
    tenantDatabase: {
      configuredEngine: input.tenantBusinessDatabaseEngine,
      runtimeEngine:
        input.tenantBusinessDatabaseEngine === 'postgres'
          ? tenantPendingCapabilities.length === 0
            ? 'postgres'
            : 'hybrid'
          : 'sqlite',
      sqliteRootPath: input.tenantDatabaseRoot,
      postgresTemplateConfigured: tenantPostgresConfigured,
      postgresConfigured: tenantPostgresConfigured,
      runtimeReady:
        input.tenantBusinessDatabaseEngine === 'sqlite' ||
        (tenantPostgresConfigured && tenantPendingCapabilities.length === 0),
      runtimeBlockedReason:
        input.tenantBusinessDatabaseEngine === 'sqlite'
          ? null
          : buildHybridRuntimeReason({
              scope: 'tenant',
              readyCapabilities: tenantReadyCapabilities,
              pendingCapabilities: tenantPendingCapabilities,
              postgresConfigured: tenantPostgresConfigured,
            }),
      readyCapabilities: tenantReadyCapabilities,
      pendingCapabilities: tenantPendingCapabilities,
    },
  };
}

export class DatabaseProvider {
  private readonly privateDb: StatisticsDatabase;
  private readonly tenantResolver: TenantDatabaseResolver;
  private readonly migrationRunner: MigrationRunner;
  private readonly tenantDatabases = new Map<number, StatisticsDatabase>();
  private readonly tenantPostgresReaders = new Map<number, PostgresBusinessReadAdapter>();

  constructor(private readonly options: DatabaseProviderOptions) {
    this.privateDb = new StatisticsDatabase(options.privateDbPath);
    this.tenantResolver = new TenantDatabaseResolver(
      options.tenantDatabaseRoot,
      options.tenantBusinessPostgresUrlTemplate,
    );
    this.migrationRunner = new MigrationRunner({
      businessDatabaseEngine: options.businessDatabaseEngine,
      businessPostgresUrl: options.businessPostgresUrl,
      tenantBusinessDatabaseEngine: options.tenantBusinessDatabaseEngine,
      tenantResolver: this.tenantResolver,
    });
  }

  initializePrivateDatabase() {
    this.privateDb.initialize({
      forceReseed: this.options.forceReseed,
      runtimeMode: this.options.runtimeMode,
      seedDemoData: this.options.seedDemoData,
      bootstrapAdmin: this.options.bootstrapAdmin,
    });
  }

  getPrivateDatabase() {
    return this.privateDb;
  }

  getTenantResolver() {
    return this.tenantResolver;
  }

  getMigrationRunner() {
    return this.migrationRunner;
  }

  getRuntimeSummary(): DatabaseProviderRuntimeSummary {
    return createDatabaseProviderRuntimeSummary(this.options);
  }

  isTenantBusinessPostgresEnabled() {
    return this.options.tenantBusinessDatabaseEngine === 'postgres';
  }

  getTenantBusinessReadAdapter(tenant: Pick<TenantRecord, 'id' | 'tenantKey'>) {
    if (!this.isTenantBusinessPostgresEnabled()) {
      return null;
    }

    const cached = this.tenantPostgresReaders.get(tenant.id);
    if (cached) {
      return cached;
    }

    const postgresUrl = this.tenantResolver.resolveBusinessPostgresUrl(tenant.tenantKey, tenant.id);
    if (!postgresUrl) {
      throw new Error('Tenant business PostgreSQL URL template is not configured.');
    }

    const adapter = new PostgresBusinessReadAdapter(postgresUrl);
    this.tenantPostgresReaders.set(tenant.id, adapter);
    return adapter;
  }

  ensureTenantDatabase(
    tenant: Pick<TenantRecord, 'id' | 'tenantKey' | 'businessDbPath'>,
    options: {
      forceReseed?: boolean;
      bootstrapAdmin?: BootstrapAdminConfig | null;
      seedDemoData?: boolean;
    } = {},
  ) {
    const cached = this.tenantDatabases.get(tenant.id);
    if (cached) {
      return cached;
    }

    const dbPath =
      tenant.businessDbPath?.trim() ||
      this.tenantResolver.resolveBusinessDbPath(tenant.tenantKey, tenant.id);
    const db = new StatisticsDatabase(dbPath);
    db.initialize({
      forceReseed: options.forceReseed ?? false,
      runtimeMode: this.options.runtimeMode,
      seedDemoData: options.seedDemoData ?? this.options.seedDemoData,
      bootstrapAdmin: options.bootstrapAdmin ?? this.options.bootstrapAdmin,
    });
    this.tenantDatabases.set(tenant.id, db);
    return db;
  }

  resolveBusinessDatabase() {
    const context = getRequestContext();
    return context?.businessDb ?? this.privateDb;
  }

  async closeAll() {
    this.privateDb.close();
    for (const db of this.tenantDatabases.values()) {
      db.close();
    }
    this.tenantDatabases.clear();
    for (const adapter of this.tenantPostgresReaders.values()) {
      await adapter.close();
    }
    this.tenantPostgresReaders.clear();
  }
}

export function createDatabaseFacade(provider: DatabaseProvider) {
  return new Proxy(provider.getPrivateDatabase(), {
    get(_target, property, receiver) {
      const activeDatabase = provider.resolveBusinessDatabase();
      const value = Reflect.get(activeDatabase, property, receiver);
      if (typeof value === 'function') {
        return value.bind(activeDatabase);
      }
      return value;
    },
  }) as StatisticsDatabase;
}
