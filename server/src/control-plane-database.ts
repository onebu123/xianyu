import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { format } from 'date-fns';

import { hashPassword } from './auth.js';
import type { MigrationRunner, TenantDatabaseResolver } from './database-provider.js';
import type {
  BootstrapAdminConfig,
  PlatformUserRecord,
  PlatformUserRole,
  PlatformUserStatus,
  RuntimeMode,
  SecretRefRecord,
  SystemUserRole,
  TenantMembershipRecord,
  TenantMembershipRole,
  TenantProvisioningJobRecord,
  TenantRecord,
  TenantStatus,
} from './types.js';

export interface ControlPlaneInitializeOptions {
  forceReseed?: boolean;
  runtimeMode?: RuntimeMode;
  bootstrapAdmin?: BootstrapAdminConfig | null;
  tenantResolver: TenantDatabaseResolver;
  migrationRunner: MigrationRunner;
  seedDemoData?: boolean;
}

export interface CreateTenantInput {
  tenantKey: string;
  tenantName: string;
  displayName?: string | null;
  ownerUserId?: number | null;
  ownerSystemRole?: SystemUserRole;
  bootstrapAdmin?: BootstrapAdminConfig | null;
  seedDemoData?: boolean;
}

export interface AssignTenantMembershipInput {
  tenantId: number;
  platformUserId: number;
  membershipRole: TenantMembershipRole;
  systemRole: SystemUserRole;
  status?: 'active' | 'disabled';
}

export interface AuditLogInput {
  action: string;
  targetType: string;
  targetId?: string | null;
  detail: string;
  result: 'success' | 'failure' | 'blocked' | 'warning';
  operatorUserId?: number | null;
  tenantId?: number | null;
  ipAddress?: string | null;
}

export class ControlPlaneDatabase {
  private db: Database.Database;

  constructor(private readonly dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
  }

  async initialize(options: ControlPlaneInitializeOptions) {
    const forceReseed = options.forceReseed ?? false;
    const runtimeMode = options.runtimeMode ?? 'demo';

    if (forceReseed) {
      this.db.close();
      if (fs.existsSync(this.dbPath)) {
        fs.rmSync(this.dbPath, { force: true });
      }
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
    }

    this.ensureSchema();
    this.ensureBootstrapPlatformAdmin(options.bootstrapAdmin, runtimeMode);

    if (runtimeMode === 'demo' && options.seedDemoData) {
      await this.ensureDemoTenant(options);
    }
  }

  close() {
    this.db.close();
  }

  getPlatformUserByUsername(username: string) {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            username,
            display_name AS displayName,
            role,
            status,
            token_version AS tokenVersion,
            password_hash AS passwordHash,
            mfa_secret_ref_id AS mfaSecretRefId,
            password_changed_at AS passwordChangedAt,
            created_at AS createdAt,
            updated_at AS updatedAt,
            last_login_at AS lastLoginAt
          FROM platform_users
          WHERE username = ?
        `,
      )
      .get(username) as Record<string, unknown> | undefined;
    return row ? this.mapPlatformUser(row) : null;
  }

  listPlatformUsers() {
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            username,
            display_name AS displayName,
            role,
            status,
            token_version AS tokenVersion,
            password_hash AS passwordHash,
            mfa_secret_ref_id AS mfaSecretRefId,
            password_changed_at AS passwordChangedAt,
            created_at AS createdAt,
            updated_at AS updatedAt,
            last_login_at AS lastLoginAt
          FROM platform_users
          ORDER BY id ASC
        `,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapPlatformUser(row));
  }

  getPlatformUserById(userId: number) {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            username,
            display_name AS displayName,
            role,
            status,
            token_version AS tokenVersion,
            password_hash AS passwordHash,
            mfa_secret_ref_id AS mfaSecretRefId,
            password_changed_at AS passwordChangedAt,
            created_at AS createdAt,
            updated_at AS updatedAt,
            last_login_at AS lastLoginAt
          FROM platform_users
          WHERE id = ?
        `,
      )
      .get(userId) as Record<string, unknown> | undefined;
    return row ? this.mapPlatformUser(row) : null;
  }

  touchPlatformUserLastLogin(userId: number) {
    const now = this.now();
    this.db
      .prepare(
        `
          UPDATE platform_users
          SET last_login_at = @now, updated_at = @now
          WHERE id = @userId
        `,
      )
      .run({ now, userId });
    return this.getPlatformUserById(userId);
  }

  updatePlatformUserPasswordHash(userId: number, passwordHash: string) {
    const now = this.now();
    this.db
      .prepare(
        `
          UPDATE platform_users
          SET
            password_hash = @passwordHash,
            password_changed_at = @now,
            token_version = COALESCE(token_version, 0) + 1,
            updated_at = @now
          WHERE id = @userId
        `,
      )
      .run({ passwordHash, now, userId });
    return this.getPlatformUserById(userId);
  }

  bumpPlatformUserTokenVersion(userId: number) {
    const now = this.now();
    this.db
      .prepare(
        `
          UPDATE platform_users
          SET token_version = COALESCE(token_version, 0) + 1, updated_at = @now
          WHERE id = @userId
        `,
      )
      .run({ now, userId });
    return this.getPlatformUserById(userId);
  }

  listAccessibleTenantsForUser(userId: number) {
    const rows = this.db
      .prepare(
        `
          SELECT
            m.id,
            m.tenant_id AS tenantId,
            m.platform_user_id AS platformUserId,
            m.membership_role AS membershipRole,
            m.system_role AS systemRole,
            m.status,
            m.created_at AS createdAt,
            m.updated_at AS updatedAt,
            t.tenant_key AS tenantKey,
            t.tenant_name AS tenantName,
            t.display_name AS displayName,
            t.status AS tenantStatus,
            t.business_db_path AS businessDbPath,
            t.created_at AS tenantCreatedAt,
            t.updated_at AS tenantUpdatedAt,
            t.provisioned_at AS provisionedAt,
            t.suspended_at AS suspendedAt
          FROM tenant_memberships m
          INNER JOIN tenants t ON t.id = m.tenant_id
          WHERE m.platform_user_id = ? AND m.status = 'active'
          ORDER BY t.id ASC
        `,
      )
      .all(userId) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      membership: this.mapTenantMembership(row),
      tenant: this.mapTenant({
        id: row.tenantId,
        tenantKey: row.tenantKey,
        tenantName: row.tenantName,
        displayName: row.displayName,
        status: row.tenantStatus,
        businessDbPath: row.businessDbPath,
        createdAt: row.tenantCreatedAt,
        updatedAt: row.tenantUpdatedAt,
        provisionedAt: row.provisionedAt,
        suspendedAt: row.suspendedAt,
      }),
    }));
  }

  getTenantById(tenantId: number) {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            tenant_key AS tenantKey,
            tenant_name AS tenantName,
            display_name AS displayName,
            status,
            business_db_path AS businessDbPath,
            created_at AS createdAt,
            updated_at AS updatedAt,
            provisioned_at AS provisionedAt,
            suspended_at AS suspendedAt
          FROM tenants
          WHERE id = ?
        `,
      )
      .get(tenantId) as Record<string, unknown> | undefined;
    return row ? this.mapTenant(row) : null;
  }

  getTenantMembership(platformUserId: number, tenantId: number) {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            tenant_id AS tenantId,
            platform_user_id AS platformUserId,
            membership_role AS membershipRole,
            system_role AS systemRole,
            status,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM tenant_memberships
          WHERE platform_user_id = ? AND tenant_id = ?
        `,
      )
      .get(platformUserId, tenantId) as Record<string, unknown> | undefined;
    return row ? this.mapTenantMembership(row) : null;
  }

  listTenants() {
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            tenant_key AS tenantKey,
            tenant_name AS tenantName,
            display_name AS displayName,
            status,
            business_db_path AS businessDbPath,
            created_at AS createdAt,
            updated_at AS updatedAt,
            provisioned_at AS provisionedAt,
            suspended_at AS suspendedAt
          FROM tenants
          ORDER BY id ASC
        `,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapTenant(row));
  }

  listTenantMemberships(tenantId: number) {
    const rows = this.db
      .prepare(
        `
          SELECT
            m.id,
            m.tenant_id AS tenantId,
            m.platform_user_id AS platformUserId,
            m.membership_role AS membershipRole,
            m.system_role AS systemRole,
            m.status,
            m.created_at AS createdAt,
            m.updated_at AS updatedAt,
            u.username,
            u.display_name AS displayName
          FROM tenant_memberships m
          INNER JOIN platform_users u ON u.id = m.platform_user_id
          WHERE m.tenant_id = ?
          ORDER BY m.id ASC
        `,
      )
      .all(tenantId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      membership: this.mapTenantMembership(row),
      user: {
        id: Number(row.platformUserId),
        username: String(row.username ?? ''),
        displayName: String(row.displayName ?? ''),
      },
    }));
  }

  listProvisioningJobs(tenantId?: number) {
    const rows = tenantId
      ? (this.db
          .prepare(
            `
              SELECT
                id,
                tenant_id AS tenantId,
                job_type AS jobType,
                status,
                detail,
                created_at AS createdAt,
                updated_at AS updatedAt,
                finished_at AS finishedAt
              FROM tenant_provisioning_jobs
              WHERE tenant_id = ?
              ORDER BY id DESC
            `,
          )
          .all(tenantId) as Array<Record<string, unknown>>)
      : (this.db
          .prepare(
            `
              SELECT
                id,
                tenant_id AS tenantId,
                job_type AS jobType,
                status,
                detail,
                created_at AS createdAt,
                updated_at AS updatedAt,
                finished_at AS finishedAt
              FROM tenant_provisioning_jobs
              ORDER BY id DESC
            `,
          )
          .all() as Array<Record<string, unknown>>);
    return rows.map((row) => this.mapProvisioningJob(row));
  }

  async createTenant(input: CreateTenantInput, options: ControlPlaneInitializeOptions) {
    const tenantKey = this.normalizeTenantKey(input.tenantKey);
    if (!tenantKey) {
      throw new Error('租户标识不能为空。');
    }

    if (this.db.prepare('SELECT id FROM tenants WHERE tenant_key = ?').get(tenantKey)) {
      throw new Error('租户标识已存在。');
    }

    if (input.ownerUserId && !this.getPlatformUserById(input.ownerUserId)) {
      throw new Error('初始管理员账号不存在。');
    }

    const now = this.now();
    const businessDbPath = options.tenantResolver.resolveBusinessDbPath(tenantKey);
    const insertTenant = this.db.prepare(
      `
        INSERT INTO tenants (
          tenant_key,
          tenant_name,
          display_name,
          status,
          business_db_path,
          created_at,
          updated_at
        ) VALUES (
          @tenantKey,
          @tenantName,
          @displayName,
          'provisioning',
          @businessDbPath,
          @createdAt,
          @updatedAt
        )
      `,
    );
    const tenantResult = insertTenant.run({
      tenantKey,
      tenantName: input.tenantName.trim(),
      displayName: input.displayName?.trim() || input.tenantName.trim(),
      businessDbPath,
      createdAt: now,
      updatedAt: now,
    });
    const tenantId = Number(tenantResult.lastInsertRowid);

    const jobResult = this.db
      .prepare(
        `
          INSERT INTO tenant_provisioning_jobs (
            tenant_id,
            job_type,
            status,
            detail,
            created_at,
            updated_at
          ) VALUES (
            @tenantId,
            'tenant_bootstrap',
            'pending',
            NULL,
            @createdAt,
            @updatedAt
          )
        `,
      )
      .run({
        tenantId,
        createdAt: now,
        updatedAt: now,
      });
    const jobId = Number(jobResult.lastInsertRowid);

    if (input.ownerUserId) {
      this.assignTenantMembership({
        tenantId,
        platformUserId: input.ownerUserId,
        membershipRole: 'owner',
        systemRole: input.ownerSystemRole ?? 'admin',
        status: 'active',
      });
    }

    try {
      this.updateProvisioningJob(jobId, 'running', '租户业务库初始化中');
      const tenantDb = await options.migrationRunner.initializeBusinessDatabase(businessDbPath, {
        forceReseed: false,
        runtimeMode: options.runtimeMode,
        seedDemoData: input.seedDemoData ?? options.seedDemoData,
        bootstrapAdmin: input.bootstrapAdmin ?? options.bootstrapAdmin,
      }, {
        scope: 'tenant',
        tenantKey,
        tenantId,
      });
      await tenantDb.close();
      this.db
        .prepare(
          `
            UPDATE tenants
            SET
              status = 'active',
              provisioned_at = @provisionedAt,
              updated_at = @updatedAt
            WHERE id = @tenantId
          `,
        )
        .run({
          tenantId,
          provisionedAt: this.now(),
          updatedAt: this.now(),
        });
      this.updateProvisioningJob(jobId, 'succeeded', '租户业务库初始化完成');
    } catch (error) {
      this.updateProvisioningJob(
        jobId,
        'failed',
        error instanceof Error ? error.message : '租户开通失败',
      );
      throw error;
    }

    return {
      tenant: this.getTenantById(tenantId),
      job: this.listProvisioningJobs(tenantId).find((item) => item.id === jobId) ?? null,
    };
  }

  async retryProvisioningJob(jobId: number, options: ControlPlaneInitializeOptions) {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            tenant_id AS tenantId,
            job_type AS jobType,
            status,
            detail,
            created_at AS createdAt,
            updated_at AS updatedAt,
            finished_at AS finishedAt
          FROM tenant_provisioning_jobs
          WHERE id = ?
        `,
      )
      .get(jobId) as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    const job = this.mapProvisioningJob(row);
    const tenant = this.getTenantById(job.tenantId);
    if (!tenant) {
      throw new Error('租户不存在。');
    }

    const businessDbPath = tenant.businessDbPath;
    this.updateProvisioningJob(job.id, 'running', '重新执行租户业务库初始化');

    try {
      const tenantDb = await options.migrationRunner.initializeBusinessDatabase(businessDbPath, {
        forceReseed: false,
        runtimeMode: options.runtimeMode,
        seedDemoData: options.seedDemoData,
        bootstrapAdmin: options.bootstrapAdmin,
      }, {
        scope: 'tenant',
        tenantKey: tenant.tenantKey,
        tenantId: tenant.id,
      });
      await tenantDb.close();
      this.db
        .prepare(
          `
            UPDATE tenants
            SET
              status = 'active',
              provisioned_at = COALESCE(provisioned_at, @provisionedAt),
              updated_at = @updatedAt,
              suspended_at = NULL
            WHERE id = @tenantId
          `,
        )
        .run({
          tenantId: tenant.id,
          provisionedAt: this.now(),
          updatedAt: this.now(),
        });
      this.updateProvisioningJob(job.id, 'succeeded', '租户业务库重新初始化完成');
    } catch (error) {
      this.updateProvisioningJob(
        job.id,
        'failed',
        error instanceof Error ? error.message : '租户重新开通失败',
      );
      throw error;
    }

    return {
      tenant: this.getTenantById(tenant.id),
      job: this.listProvisioningJobs(tenant.id).find((item) => item.id === job.id) ?? null,
    };
  }

  updateTenantStatus(tenantId: number, status: TenantStatus) {
    const now = this.now();
    this.db
      .prepare(
        `
          UPDATE tenants
          SET
            status = @status,
            suspended_at = CASE WHEN @status = 'suspended' THEN @now ELSE NULL END,
            updated_at = @now
          WHERE id = @tenantId
        `,
      )
      .run({ tenantId, status, now });
    return this.getTenantById(tenantId);
  }

  assignTenantMembership(input: AssignTenantMembershipInput) {
    if (!this.getTenantById(input.tenantId) || !this.getPlatformUserById(input.platformUserId)) {
      return null;
    }

    const now = this.now();
    this.db
      .prepare(
        `
          INSERT INTO tenant_memberships (
            tenant_id,
            platform_user_id,
            membership_role,
            system_role,
            status,
            created_at,
            updated_at
          ) VALUES (
            @tenantId,
            @platformUserId,
            @membershipRole,
            @systemRole,
            @status,
            @createdAt,
            @updatedAt
          )
          ON CONFLICT(tenant_id, platform_user_id) DO UPDATE SET
            membership_role = excluded.membership_role,
            system_role = excluded.system_role,
            status = excluded.status,
            updated_at = excluded.updated_at
        `,
      )
      .run({
        tenantId: input.tenantId,
        platformUserId: input.platformUserId,
        membershipRole: input.membershipRole,
        systemRole: input.systemRole,
        status: input.status ?? 'active',
        createdAt: now,
        updatedAt: now,
      });
    return this.getTenantMembership(input.platformUserId, input.tenantId);
  }

  upsertSecretRef(input: Omit<SecretRefRecord, 'id' | 'createdAt' | 'updatedAt'>) {
    const now = this.now();
    this.db
      .prepare(
        `
          INSERT INTO secret_refs (
            provider,
            ref_key,
            cipher_text,
            description,
            created_at,
            updated_at
          ) VALUES (
            @provider,
            @refKey,
            @cipherText,
            @description,
            @createdAt,
            @updatedAt
          )
          ON CONFLICT(ref_key) DO UPDATE SET
            provider = excluded.provider,
            cipher_text = excluded.cipher_text,
            description = excluded.description,
            updated_at = excluded.updated_at
        `,
      )
      .run({
        provider: input.provider,
        refKey: input.refKey,
        cipherText: input.cipherText,
        description: input.description ?? null,
        createdAt: now,
        updatedAt: now,
      });
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            provider,
            ref_key AS refKey,
            cipher_text AS cipherText,
            description,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM secret_refs
          WHERE ref_key = ?
        `,
      )
      .get(input.refKey) as Record<string, unknown> | undefined;
    return row ? this.mapSecretRef(row) : null;
  }

  getSecretRefById(secretRefId: number) {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            provider,
            ref_key AS refKey,
            cipher_text AS cipherText,
            description,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM secret_refs
          WHERE id = ?
        `,
      )
      .get(secretRefId) as Record<string, unknown> | undefined;
    return row ? this.mapSecretRef(row) : null;
  }

  getSecretRefByRefKey(refKey: string) {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            provider,
            ref_key AS refKey,
            cipher_text AS cipherText,
            description,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM secret_refs
          WHERE ref_key = ?
        `,
      )
      .get(refKey) as Record<string, unknown> | undefined;
    return row ? this.mapSecretRef(row) : null;
  }

  updatePlatformUserMfaSecretRef(userId: number, secretRefId: number | null) {
    const now = this.now();
    this.db
      .prepare(
        `
          UPDATE platform_users
          SET mfa_secret_ref_id = @secretRefId, updated_at = @now
          WHERE id = @userId
        `,
      )
      .run({
        userId,
        secretRefId,
        now,
      });
    return this.getPlatformUserById(userId);
  }

  deleteSecretRef(secretRefId: number) {
    const result = this.db
      .prepare('DELETE FROM secret_refs WHERE id = ?')
      .run(secretRefId);
    return result.changes > 0;
  }

  recordAuditLog(input: AuditLogInput) {
    this.db
      .prepare(
        `
          INSERT INTO control_plane_audit_logs (
            action,
            target_type,
            target_id,
            detail,
            result,
            operator_user_id,
            tenant_id,
            ip_address,
            created_at
          ) VALUES (
            @action,
            @targetType,
            @targetId,
            @detail,
            @result,
            @operatorUserId,
            @tenantId,
            @ipAddress,
            @createdAt
          )
        `,
      )
      .run({
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        detail: input.detail,
        result: input.result,
        operatorUserId: input.operatorUserId ?? null,
        tenantId: input.tenantId ?? null,
        ipAddress: input.ipAddress ?? null,
        createdAt: this.now(),
      });
  }

  private async ensureDemoTenant(options: ControlPlaneInitializeOptions) {
    const hasTenant = this.db.prepare('SELECT id FROM tenants LIMIT 1').get() as
      | { id: number }
      | undefined;
    const admin = this.getPlatformUserByUsername('admin');
    if (hasTenant || !admin) {
      return;
    }

    await this.createTenant(
      {
        tenantKey: 'demo',
        tenantName: '演示租户',
        displayName: '演示租户',
        ownerUserId: admin.id,
        ownerSystemRole: 'admin',
        bootstrapAdmin: options.bootstrapAdmin,
        seedDemoData: true,
      },
      options,
    );
  }

  private ensureBootstrapPlatformAdmin(
    bootstrapAdmin: BootstrapAdminConfig | null | undefined,
    runtimeMode: RuntimeMode,
  ) {
    const userCount = this.db.prepare('SELECT COUNT(*) AS count FROM platform_users').get() as {
      count: number;
    };
    if (userCount.count > 0) {
      return;
    }

    const seedAdmin =
      bootstrapAdmin ??
      (runtimeMode === 'demo'
        ? {
            username: 'admin',
            password: 'Admin@123456',
            displayName: '平台管理员',
          }
        : null);
    if (!seedAdmin) {
      return;
    }

    const now = this.now();
    this.db
      .prepare(
        `
          INSERT INTO platform_users (
            username,
            display_name,
            role,
            status,
            token_version,
            password_hash,
            password_changed_at,
            created_at,
            updated_at,
            last_login_at
          ) VALUES (
            @username,
            @displayName,
            'platform_admin',
            'active',
            0,
            @passwordHash,
            @passwordChangedAt,
            @createdAt,
            @updatedAt,
            NULL
          )
        `,
      )
      .run({
        username: seedAdmin.username,
        displayName: seedAdmin.displayName,
        passwordHash: hashPassword(seedAdmin.password),
        passwordChangedAt: now,
        createdAt: now,
        updatedAt: now,
      });
  }

  private ensureSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS platform_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        token_version INTEGER NOT NULL DEFAULT 0,
        password_hash TEXT NOT NULL,
        mfa_secret_ref_id INTEGER NULL,
        password_changed_at TEXT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT NULL
      );

      CREATE TABLE IF NOT EXISTS tenants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_key TEXT NOT NULL UNIQUE,
        tenant_name TEXT NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL,
        business_db_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        provisioned_at TEXT NULL,
        suspended_at TEXT NULL
      );

      CREATE TABLE IF NOT EXISTS tenant_memberships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        platform_user_id INTEGER NOT NULL,
        membership_role TEXT NOT NULL,
        system_role TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(tenant_id, platform_user_id)
      );

      CREATE TABLE IF NOT EXISTS tenant_provisioning_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL,
        job_type TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT NULL
      );

      CREATE TABLE IF NOT EXISTS secret_refs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        ref_key TEXT NOT NULL UNIQUE,
        cipher_text TEXT NOT NULL,
        description TEXT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS control_plane_audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NULL,
        detail TEXT NOT NULL,
        result TEXT NOT NULL,
        operator_user_id INTEGER NULL,
        tenant_id INTEGER NULL,
        ip_address TEXT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  private updateProvisioningJob(
    jobId: number,
    status: TenantProvisioningJobRecord['status'],
    detail: string,
  ) {
    const now = this.now();
    this.db
      .prepare(
        `
          UPDATE tenant_provisioning_jobs
          SET
            status = @status,
            detail = @detail,
            updated_at = @updatedAt,
            finished_at = CASE
              WHEN @status IN ('succeeded', 'failed') THEN @updatedAt
              ELSE NULL
            END
          WHERE id = @jobId
        `,
      )
      .run({
        jobId,
        status,
        detail,
        updatedAt: now,
      });
  }

  private mapPlatformUser(row: Record<string, unknown>): PlatformUserRecord {
    return {
      id: Number(row.id),
      username: String(row.username ?? ''),
      displayName: String(row.displayName ?? ''),
      role: String(row.role ?? 'platform_operator') as PlatformUserRole,
      status: String(row.status ?? 'active') as PlatformUserStatus,
      tokenVersion: Number(row.tokenVersion ?? 0),
      passwordHash: typeof row.passwordHash === 'string' ? row.passwordHash : undefined,
      mfaSecretRefId: row.mfaSecretRefId == null ? null : Number(row.mfaSecretRefId),
      passwordChangedAt: row.passwordChangedAt == null ? null : String(row.passwordChangedAt),
      createdAt: String(row.createdAt ?? ''),
      updatedAt: String(row.updatedAt ?? ''),
      lastLoginAt: row.lastLoginAt == null ? null : String(row.lastLoginAt),
    };
  }

  private mapTenant(row: Record<string, unknown>): TenantRecord {
    return {
      id: Number(row.id),
      tenantKey: String(row.tenantKey ?? ''),
      tenantName: String(row.tenantName ?? ''),
      displayName: String(row.displayName ?? ''),
      status: String(row.status ?? 'provisioning') as TenantStatus,
      businessDbPath: String(row.businessDbPath ?? ''),
      createdAt: String(row.createdAt ?? ''),
      updatedAt: String(row.updatedAt ?? ''),
      provisionedAt: row.provisionedAt == null ? null : String(row.provisionedAt),
      suspendedAt: row.suspendedAt == null ? null : String(row.suspendedAt),
    };
  }

  private mapTenantMembership(row: Record<string, unknown>): TenantMembershipRecord {
    return {
      id: Number(row.id),
      tenantId: Number(row.tenantId),
      platformUserId: Number(row.platformUserId),
      membershipRole: String(row.membershipRole ?? 'member') as TenantMembershipRole,
      systemRole: String(row.systemRole ?? 'operator') as SystemUserRole,
      status: String(row.status ?? 'active') as 'active' | 'disabled',
      createdAt: String(row.createdAt ?? ''),
      updatedAt: String(row.updatedAt ?? ''),
    };
  }

  private mapProvisioningJob(row: Record<string, unknown>): TenantProvisioningJobRecord {
    return {
      id: Number(row.id),
      tenantId: Number(row.tenantId),
      jobType: 'tenant_bootstrap',
      status: String(row.status ?? 'pending') as TenantProvisioningJobRecord['status'],
      detail: row.detail == null ? null : String(row.detail),
      createdAt: String(row.createdAt ?? ''),
      updatedAt: String(row.updatedAt ?? ''),
      finishedAt: row.finishedAt == null ? null : String(row.finishedAt),
    };
  }

  private mapSecretRef(row: Record<string, unknown>): SecretRefRecord {
    return {
      id: Number(row.id),
      provider: String(row.provider ?? ''),
      refKey: String(row.refKey ?? ''),
      cipherText: String(row.cipherText ?? ''),
      description: row.description == null ? null : String(row.description),
      createdAt: String(row.createdAt ?? ''),
      updatedAt: String(row.updatedAt ?? ''),
    };
  }

  private normalizeTenantKey(value: string) {
    return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  }

  private now() {
    return format(new Date(), 'yyyy-MM-dd HH:mm:ss');
  }
}
