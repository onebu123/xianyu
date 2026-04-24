import { Pool } from 'pg';
import { format } from 'date-fns';

import { hashPassword } from './auth.js';
import {
  ControlPlaneDatabase,
  type AssignTenantMembershipInput,
  type AuditLogInput,
  type ControlPlaneInitializeOptions,
  type CreateTenantInput,
} from './control-plane-database.js';
import type {
  DatabaseEngine,
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

type SqlRow = Record<string, unknown>;

export interface ControlPlaneStore {
  initialize(options: ControlPlaneInitializeOptions): Promise<void>;
  close(): Promise<void>;
  getPlatformUserByUsername(username: string): Promise<PlatformUserRecord | null>;
  listPlatformUsers(): Promise<PlatformUserRecord[]>;
  getPlatformUserById(userId: number): Promise<PlatformUserRecord | null>;
  touchPlatformUserLastLogin(userId: number): Promise<PlatformUserRecord | null>;
  updatePlatformUserPasswordHash(userId: number, passwordHash: string): Promise<PlatformUserRecord | null>;
  bumpPlatformUserTokenVersion(userId: number): Promise<PlatformUserRecord | null>;
  listAccessibleTenantsForUser(userId: number): Promise<
    Array<{
      membership: TenantMembershipRecord;
      tenant: TenantRecord;
    }>
  >;
  getTenantById(tenantId: number): Promise<TenantRecord | null>;
  getTenantMembership(platformUserId: number, tenantId: number): Promise<TenantMembershipRecord | null>;
  listTenants(): Promise<TenantRecord[]>;
  listTenantMemberships(tenantId: number): Promise<
    Array<{
      membership: TenantMembershipRecord;
      user: { id: number; username: string; displayName: string };
    }>
  >;
  listProvisioningJobs(tenantId?: number): Promise<TenantProvisioningJobRecord[]>;
  createTenant(
    input: CreateTenantInput,
    options: ControlPlaneInitializeOptions,
  ): Promise<{ tenant: TenantRecord | null; job: TenantProvisioningJobRecord | null }>;
  retryProvisioningJob(
    jobId: number,
    options: ControlPlaneInitializeOptions,
  ): Promise<{ tenant: TenantRecord | null; job: TenantProvisioningJobRecord | null } | null>;
  updateTenantStatus(tenantId: number, status: TenantStatus): Promise<TenantRecord | null>;
  assignTenantMembership(input: AssignTenantMembershipInput): Promise<TenantMembershipRecord | null>;
  upsertSecretRef(input: Omit<SecretRefRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<SecretRefRecord | null>;
  getSecretRefById(secretRefId: number): Promise<SecretRefRecord | null>;
  getSecretRefByRefKey(refKey: string): Promise<SecretRefRecord | null>;
  updatePlatformUserMfaSecretRef(userId: number, secretRefId: number | null): Promise<PlatformUserRecord | null>;
  deleteSecretRef(secretRefId: number): Promise<boolean>;
  recordAuditLog(input: AuditLogInput): Promise<void>;
}

class SqliteControlPlaneStore implements ControlPlaneStore {
  constructor(private readonly database: ControlPlaneDatabase) {}

  async initialize(options: ControlPlaneInitializeOptions) {
    this.database.initialize(options);
  }

  async close() {
    this.database.close();
  }

  async getPlatformUserByUsername(username: string) {
    return this.database.getPlatformUserByUsername(username);
  }

  async listPlatformUsers() {
    return this.database.listPlatformUsers();
  }

  async getPlatformUserById(userId: number) {
    return this.database.getPlatformUserById(userId);
  }

  async touchPlatformUserLastLogin(userId: number) {
    return this.database.touchPlatformUserLastLogin(userId);
  }

  async updatePlatformUserPasswordHash(userId: number, passwordHash: string) {
    return this.database.updatePlatformUserPasswordHash(userId, passwordHash);
  }

  async bumpPlatformUserTokenVersion(userId: number) {
    return this.database.bumpPlatformUserTokenVersion(userId);
  }

  async listAccessibleTenantsForUser(userId: number) {
    return this.database.listAccessibleTenantsForUser(userId);
  }

  async getTenantById(tenantId: number) {
    return this.database.getTenantById(tenantId);
  }

  async getTenantMembership(platformUserId: number, tenantId: number) {
    return this.database.getTenantMembership(platformUserId, tenantId);
  }

  async listTenants() {
    return this.database.listTenants();
  }

  async listTenantMemberships(tenantId: number) {
    return this.database.listTenantMemberships(tenantId);
  }

  async listProvisioningJobs(tenantId?: number) {
    return this.database.listProvisioningJobs(tenantId);
  }

  async createTenant(input: CreateTenantInput, options: ControlPlaneInitializeOptions) {
    return this.database.createTenant(input, options);
  }

  async retryProvisioningJob(jobId: number, options: ControlPlaneInitializeOptions) {
    return this.database.retryProvisioningJob(jobId, options);
  }

  async updateTenantStatus(tenantId: number, status: TenantStatus) {
    return this.database.updateTenantStatus(tenantId, status);
  }

  async assignTenantMembership(input: AssignTenantMembershipInput) {
    return this.database.assignTenantMembership(input);
  }

  async upsertSecretRef(input: Omit<SecretRefRecord, 'id' | 'createdAt' | 'updatedAt'>) {
    return this.database.upsertSecretRef(input);
  }

  async getSecretRefById(secretRefId: number) {
    return this.database.getSecretRefById(secretRefId);
  }

  async getSecretRefByRefKey(refKey: string) {
    return this.database.getSecretRefByRefKey(refKey);
  }

  async updatePlatformUserMfaSecretRef(userId: number, secretRefId: number | null) {
    return this.database.updatePlatformUserMfaSecretRef(userId, secretRefId);
  }

  async deleteSecretRef(secretRefId: number) {
    return this.database.deleteSecretRef(secretRefId);
  }

  async recordAuditLog(input: AuditLogInput) {
    this.database.recordAuditLog(input);
  }
}

class PostgresControlPlaneStore implements ControlPlaneStore {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 8,
    });
  }

  async initialize(options: ControlPlaneInitializeOptions) {
    await this.ensureSchema();
    await this.ensureBootstrapPlatformAdmin(options.bootstrapAdmin, options.runtimeMode ?? 'demo');

    if ((options.runtimeMode ?? 'demo') === 'demo' && options.seedDemoData) {
      await this.ensureDemoTenant(options);
    }
  }

  async close() {
    await this.pool.end();
  }

  async getPlatformUserByUsername(username: string) {
    const row = await this.queryOne(
      `
        SELECT
          id,
          username,
          display_name AS "displayName",
          role,
          status,
          token_version AS "tokenVersion",
          password_hash AS "passwordHash",
          mfa_secret_ref_id AS "mfaSecretRefId",
          password_changed_at AS "passwordChangedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          last_login_at AS "lastLoginAt"
        FROM platform_users
        WHERE username = $1
      `,
      [username],
    );
    return row ? this.mapPlatformUser(row) : null;
  }

  async listPlatformUsers() {
    const rows = await this.queryRows(
      `
        SELECT
          id,
          username,
          display_name AS "displayName",
          role,
          status,
          token_version AS "tokenVersion",
          password_hash AS "passwordHash",
          mfa_secret_ref_id AS "mfaSecretRefId",
          password_changed_at AS "passwordChangedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          last_login_at AS "lastLoginAt"
        FROM platform_users
        ORDER BY id ASC
      `,
    );
    return rows.map((row) => this.mapPlatformUser(row));
  }

  async getPlatformUserById(userId: number) {
    const row = await this.queryOne(
      `
        SELECT
          id,
          username,
          display_name AS "displayName",
          role,
          status,
          token_version AS "tokenVersion",
          password_hash AS "passwordHash",
          mfa_secret_ref_id AS "mfaSecretRefId",
          password_changed_at AS "passwordChangedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          last_login_at AS "lastLoginAt"
        FROM platform_users
        WHERE id = $1
      `,
      [userId],
    );
    return row ? this.mapPlatformUser(row) : null;
  }

  async touchPlatformUserLastLogin(userId: number) {
    const now = this.now();
    await this.query(
      `
        UPDATE platform_users
        SET last_login_at = $2, updated_at = $2
        WHERE id = $1
      `,
      [userId, now],
    );
    return this.getPlatformUserById(userId);
  }

  async updatePlatformUserPasswordHash(userId: number, passwordHash: string) {
    const now = this.now();
    await this.query(
      `
        UPDATE platform_users
        SET
          password_hash = $2,
          password_changed_at = $3,
          token_version = COALESCE(token_version, 0) + 1,
          updated_at = $3
        WHERE id = $1
      `,
      [userId, passwordHash, now],
    );
    return this.getPlatformUserById(userId);
  }

  async bumpPlatformUserTokenVersion(userId: number) {
    const now = this.now();
    await this.query(
      `
        UPDATE platform_users
        SET token_version = COALESCE(token_version, 0) + 1, updated_at = $2
        WHERE id = $1
      `,
      [userId, now],
    );
    return this.getPlatformUserById(userId);
  }

  async listAccessibleTenantsForUser(userId: number) {
    const rows = await this.queryRows(
      `
        SELECT
          m.id,
          m.tenant_id AS "tenantId",
          m.platform_user_id AS "platformUserId",
          m.membership_role AS "membershipRole",
          m.system_role AS "systemRole",
          m.status,
          m.created_at AS "createdAt",
          m.updated_at AS "updatedAt",
          t.tenant_key AS "tenantKey",
          t.tenant_name AS "tenantName",
          t.display_name AS "displayName",
          t.status AS "tenantStatus",
          t.business_db_path AS "businessDbPath",
          t.created_at AS "tenantCreatedAt",
          t.updated_at AS "tenantUpdatedAt",
          t.provisioned_at AS "provisionedAt",
          t.suspended_at AS "suspendedAt"
        FROM tenant_memberships m
        INNER JOIN tenants t ON t.id = m.tenant_id
        WHERE m.platform_user_id = $1 AND m.status = 'active'
        ORDER BY t.id ASC
      `,
      [userId],
    );

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

  async getTenantById(tenantId: number) {
    const row = await this.queryOne(
      `
        SELECT
          id,
          tenant_key AS "tenantKey",
          tenant_name AS "tenantName",
          display_name AS "displayName",
          status,
          business_db_path AS "businessDbPath",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          provisioned_at AS "provisionedAt",
          suspended_at AS "suspendedAt"
        FROM tenants
        WHERE id = $1
      `,
      [tenantId],
    );
    return row ? this.mapTenant(row) : null;
  }

  async getTenantMembership(platformUserId: number, tenantId: number) {
    const row = await this.queryOne(
      `
        SELECT
          id,
          tenant_id AS "tenantId",
          platform_user_id AS "platformUserId",
          membership_role AS "membershipRole",
          system_role AS "systemRole",
          status,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM tenant_memberships
        WHERE platform_user_id = $1 AND tenant_id = $2
      `,
      [platformUserId, tenantId],
    );
    return row ? this.mapTenantMembership(row) : null;
  }

  async listTenants() {
    const rows = await this.queryRows(
      `
        SELECT
          id,
          tenant_key AS "tenantKey",
          tenant_name AS "tenantName",
          display_name AS "displayName",
          status,
          business_db_path AS "businessDbPath",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          provisioned_at AS "provisionedAt",
          suspended_at AS "suspendedAt"
        FROM tenants
        ORDER BY id ASC
      `,
    );
    return rows.map((row) => this.mapTenant(row));
  }

  async listTenantMemberships(tenantId: number) {
    const rows = await this.queryRows(
      `
        SELECT
          m.id,
          m.tenant_id AS "tenantId",
          m.platform_user_id AS "platformUserId",
          m.membership_role AS "membershipRole",
          m.system_role AS "systemRole",
          m.status,
          m.created_at AS "createdAt",
          m.updated_at AS "updatedAt",
          u.username,
          u.display_name AS "displayName"
        FROM tenant_memberships m
        INNER JOIN platform_users u ON u.id = m.platform_user_id
        WHERE m.tenant_id = $1
        ORDER BY m.id ASC
      `,
      [tenantId],
    );

    return rows.map((row) => ({
      membership: this.mapTenantMembership(row),
      user: {
        id: Number(row.platformUserId),
        username: String(row.username ?? ''),
        displayName: String(row.displayName ?? ''),
      },
    }));
  }

  async listProvisioningJobs(tenantId?: number) {
    const rows = tenantId
      ? await this.queryRows(
          `
            SELECT
              id,
              tenant_id AS "tenantId",
              job_type AS "jobType",
              status,
              detail,
              created_at AS "createdAt",
              updated_at AS "updatedAt",
              finished_at AS "finishedAt"
            FROM tenant_provisioning_jobs
            WHERE tenant_id = $1
            ORDER BY id DESC
          `,
          [tenantId],
        )
      : await this.queryRows(
          `
            SELECT
              id,
              tenant_id AS "tenantId",
              job_type AS "jobType",
              status,
              detail,
              created_at AS "createdAt",
              updated_at AS "updatedAt",
              finished_at AS "finishedAt"
            FROM tenant_provisioning_jobs
            ORDER BY id DESC
          `,
        );
    return rows.map((row) => this.mapProvisioningJob(row));
  }

  async createTenant(input: CreateTenantInput, options: ControlPlaneInitializeOptions) {
    const tenantKey = this.normalizeTenantKey(input.tenantKey);
    if (!tenantKey) {
      throw new Error('租户标识不能为空。');
    }

    const existingTenant = await this.queryOne('SELECT id FROM tenants WHERE tenant_key = $1', [tenantKey]);
    if (existingTenant) {
      throw new Error('租户标识已存在。');
    }

    if (input.ownerUserId) {
      const owner = await this.getPlatformUserById(input.ownerUserId);
      if (!owner) {
        throw new Error('初始管理员账号不存在。');
      }
    }

    const now = this.now();
    const businessDbPath = options.tenantResolver.resolveBusinessDbPath(tenantKey);
    const tenantResult = await this.queryOne(
      `
        INSERT INTO tenants (
          tenant_key,
          tenant_name,
          display_name,
          status,
          business_db_path,
          created_at,
          updated_at
        ) VALUES ($1, $2, $3, 'provisioning', $4, $5, $5)
        RETURNING id
      `,
      [tenantKey, input.tenantName.trim(), input.displayName?.trim() || input.tenantName.trim(), businessDbPath, now],
    );
    const tenantId = Number(tenantResult?.id ?? 0);

    const jobResult = await this.queryOne(
      `
        INSERT INTO tenant_provisioning_jobs (
          tenant_id,
          job_type,
          status,
          detail,
          created_at,
          updated_at
        ) VALUES ($1, 'tenant_bootstrap', 'pending', NULL, $2, $2)
        RETURNING id
      `,
      [tenantId, now],
    );
    const jobId = Number(jobResult?.id ?? 0);

    if (input.ownerUserId) {
      await this.assignTenantMembership({
        tenantId,
        platformUserId: input.ownerUserId,
        membershipRole: 'owner',
        systemRole: input.ownerSystemRole ?? 'admin',
        status: 'active',
      });
    }

    try {
      await this.updateProvisioningJob(jobId, 'running', '租户业务库初始化中');
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
      await this.query(
        `
          UPDATE tenants
          SET
            status = 'active',
            provisioned_at = $2,
            updated_at = $2
          WHERE id = $1
        `,
        [tenantId, this.now()],
      );
      await this.updateProvisioningJob(jobId, 'succeeded', '租户业务库初始化完成');
    } catch (error) {
      await this.updateProvisioningJob(
        jobId,
        'failed',
        error instanceof Error ? error.message : '租户开通失败',
      );
      throw error;
    }

    return {
      tenant: await this.getTenantById(tenantId),
      job: (await this.listProvisioningJobs(tenantId)).find((item) => item.id === jobId) ?? null,
    };
  }

  async retryProvisioningJob(jobId: number, options: ControlPlaneInitializeOptions) {
    const row = await this.queryOne(
      `
        SELECT
          id,
          tenant_id AS "tenantId",
          job_type AS "jobType",
          status,
          detail,
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          finished_at AS "finishedAt"
        FROM tenant_provisioning_jobs
        WHERE id = $1
      `,
      [jobId],
    );

    if (!row) {
      return null;
    }

    const job = this.mapProvisioningJob(row);
    const tenant = await this.getTenantById(job.tenantId);
    if (!tenant) {
      throw new Error('租户不存在。');
    }

    await this.updateProvisioningJob(job.id, 'running', '重新执行租户业务库初始化');

    try {
      const tenantDb = await options.migrationRunner.initializeBusinessDatabase(tenant.businessDbPath, {
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
      await this.query(
        `
          UPDATE tenants
          SET
            status = 'active',
            provisioned_at = COALESCE(provisioned_at, $2),
            updated_at = $2,
            suspended_at = NULL
          WHERE id = $1
        `,
        [tenant.id, this.now()],
      );
      await this.updateProvisioningJob(job.id, 'succeeded', '租户业务库重新初始化完成');
    } catch (error) {
      await this.updateProvisioningJob(
        job.id,
        'failed',
        error instanceof Error ? error.message : '租户重新开通失败',
      );
      throw error;
    }

    return {
      tenant: await this.getTenantById(tenant.id),
      job: (await this.listProvisioningJobs(tenant.id)).find((item) => item.id === job.id) ?? null,
    };
  }

  async updateTenantStatus(tenantId: number, status: TenantStatus) {
    const now = this.now();
    await this.query(
      `
        UPDATE tenants
        SET
          status = $2,
          suspended_at = CASE WHEN $2 = 'suspended' THEN $3 ELSE NULL END,
          updated_at = $3
        WHERE id = $1
      `,
      [tenantId, status, now],
    );
    return this.getTenantById(tenantId);
  }

  async assignTenantMembership(input: AssignTenantMembershipInput) {
    const [tenant, platformUser] = await Promise.all([
      this.getTenantById(input.tenantId),
      this.getPlatformUserById(input.platformUserId),
    ]);
    if (!tenant || !platformUser) {
      return null;
    }

    const now = this.now();
    await this.query(
      `
        INSERT INTO tenant_memberships (
          tenant_id,
          platform_user_id,
          membership_role,
          system_role,
          status,
          created_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $6)
        ON CONFLICT (tenant_id, platform_user_id) DO UPDATE SET
          membership_role = EXCLUDED.membership_role,
          system_role = EXCLUDED.system_role,
          status = EXCLUDED.status,
          updated_at = EXCLUDED.updated_at
      `,
      [
        input.tenantId,
        input.platformUserId,
        input.membershipRole,
        input.systemRole,
        input.status ?? 'active',
        now,
      ],
    );
    return this.getTenantMembership(input.platformUserId, input.tenantId);
  }

  async upsertSecretRef(input: Omit<SecretRefRecord, 'id' | 'createdAt' | 'updatedAt'>) {
    const now = this.now();
    const row = await this.queryOne(
      `
        INSERT INTO secret_refs (
          provider,
          ref_key,
          cipher_text,
          description,
          created_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $5)
        ON CONFLICT (ref_key) DO UPDATE SET
          provider = EXCLUDED.provider,
          cipher_text = EXCLUDED.cipher_text,
          description = EXCLUDED.description,
          updated_at = EXCLUDED.updated_at
        RETURNING
          id,
          provider,
          ref_key AS "refKey",
          cipher_text AS "cipherText",
          description,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
      [input.provider, input.refKey, input.cipherText, input.description ?? null, now],
    );
    return row ? this.mapSecretRef(row) : null;
  }

  async getSecretRefById(secretRefId: number) {
    const row = await this.queryOne(
      `
        SELECT
          id,
          provider,
          ref_key AS "refKey",
          cipher_text AS "cipherText",
          description,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM secret_refs
        WHERE id = $1
      `,
      [secretRefId],
    );
    return row ? this.mapSecretRef(row) : null;
  }

  async getSecretRefByRefKey(refKey: string) {
    const row = await this.queryOne(
      `
        SELECT
          id,
          provider,
          ref_key AS "refKey",
          cipher_text AS "cipherText",
          description,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM secret_refs
        WHERE ref_key = $1
      `,
      [refKey],
    );
    return row ? this.mapSecretRef(row) : null;
  }

  async updatePlatformUserMfaSecretRef(userId: number, secretRefId: number | null) {
    await this.query(
      `
        UPDATE platform_users
        SET mfa_secret_ref_id = $2, updated_at = $3
        WHERE id = $1
      `,
      [userId, secretRefId, this.now()],
    );
    return this.getPlatformUserById(userId);
  }

  async deleteSecretRef(secretRefId: number) {
    const result = await this.query(
      `
        DELETE FROM secret_refs
        WHERE id = $1
      `,
      [secretRefId],
    );
    return Number(result.rowCount ?? 0) > 0;
  }

  async recordAuditLog(input: AuditLogInput) {
    await this.query(
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
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        input.action,
        input.targetType,
        input.targetId ?? null,
        input.detail,
        input.result,
        input.operatorUserId ?? null,
        input.tenantId ?? null,
        input.ipAddress ?? null,
        this.now(),
      ],
    );
  }

  private async ensureDemoTenant(options: ControlPlaneInitializeOptions) {
    const hasTenant = await this.queryOne('SELECT id FROM tenants LIMIT 1');
    const admin = await this.getPlatformUserByUsername('admin');
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

  private async ensureBootstrapPlatformAdmin(
    bootstrapAdmin: ControlPlaneInitializeOptions['bootstrapAdmin'],
    runtimeMode: RuntimeMode,
  ) {
    const row = await this.queryOne('SELECT COUNT(*)::int AS count FROM platform_users');
    if (Number(row?.count ?? 0) > 0) {
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
    await this.query(
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
        ) VALUES ($1, $2, 'platform_admin', 'active', 0, $3, $4, $4, $4, NULL)
      `,
      [seedAdmin.username, seedAdmin.displayName, hashPassword(seedAdmin.password), now],
    );
  }

  private async ensureSchema() {
    const statements = [
      `
        CREATE TABLE IF NOT EXISTS platform_users (
          id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
        )
      `,
      `
        CREATE TABLE IF NOT EXISTS tenants (
          id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          tenant_key TEXT NOT NULL UNIQUE,
          tenant_name TEXT NOT NULL,
          display_name TEXT NOT NULL,
          status TEXT NOT NULL,
          business_db_path TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          provisioned_at TEXT NULL,
          suspended_at TEXT NULL
        )
      `,
      `
        CREATE TABLE IF NOT EXISTS tenant_memberships (
          id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          tenant_id INTEGER NOT NULL,
          platform_user_id INTEGER NOT NULL,
          membership_role TEXT NOT NULL,
          system_role TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (tenant_id, platform_user_id)
        )
      `,
      `
        CREATE TABLE IF NOT EXISTS tenant_provisioning_jobs (
          id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          tenant_id INTEGER NOT NULL,
          job_type TEXT NOT NULL,
          status TEXT NOT NULL,
          detail TEXT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          finished_at TEXT NULL
        )
      `,
      `
        CREATE TABLE IF NOT EXISTS secret_refs (
          id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          provider TEXT NOT NULL,
          ref_key TEXT NOT NULL UNIQUE,
          cipher_text TEXT NOT NULL,
          description TEXT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `,
      `
        CREATE TABLE IF NOT EXISTS control_plane_audit_logs (
          id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          action TEXT NOT NULL,
          target_type TEXT NOT NULL,
          target_id TEXT NULL,
          detail TEXT NOT NULL,
          result TEXT NOT NULL,
          operator_user_id INTEGER NULL,
          tenant_id INTEGER NULL,
          ip_address TEXT NULL,
          created_at TEXT NOT NULL
        )
      `,
    ];

    for (const statement of statements) {
      await this.query(statement);
    }
  }

  private async updateProvisioningJob(
    jobId: number,
    status: TenantProvisioningJobRecord['status'],
    detail: string,
  ) {
    const now = this.now();
    await this.query(
      `
        UPDATE tenant_provisioning_jobs
        SET
          status = $2,
          detail = $3,
          updated_at = $4,
          finished_at = CASE
            WHEN $2 IN ('succeeded', 'failed') THEN $4
            ELSE NULL
          END
        WHERE id = $1
      `,
      [jobId, status, detail, now],
    );
  }

  private async query(text: string, params: unknown[] = []) {
    return this.pool.query(text, params);
  }

  private async queryRows(text: string, params: unknown[] = []) {
    const result = await this.pool.query<SqlRow>(text, params);
    return result.rows;
  }

  private async queryOne(text: string, params: unknown[] = []) {
    const rows = await this.queryRows(text, params);
    return rows[0] ?? null;
  }

  private mapPlatformUser(row: SqlRow): PlatformUserRecord {
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

  private mapTenant(row: SqlRow): TenantRecord {
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

  private mapTenantMembership(row: SqlRow): TenantMembershipRecord {
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

  private mapProvisioningJob(row: SqlRow): TenantProvisioningJobRecord {
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

  private mapSecretRef(row: SqlRow): SecretRefRecord {
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

export interface CreateControlPlaneStoreOptions {
  engine: DatabaseEngine;
  sqliteDbPath: string;
  postgresUrl?: string | null;
}

export async function createControlPlaneStore(
  options: CreateControlPlaneStoreOptions,
): Promise<ControlPlaneStore> {
  if (options.engine === 'postgres') {
    if (!options.postgresUrl?.trim()) {
      throw new Error('控制面数据库已切换为 PostgreSQL，但缺少连接地址。');
    }
    return new PostgresControlPlaneStore(options.postgresUrl);
  }

  return new SqliteControlPlaneStore(new ControlPlaneDatabase(options.sqliteDbPath));
}
