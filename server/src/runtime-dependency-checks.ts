import { Redis } from 'ioredis';
import { Pool } from 'pg';

import type { ResolvedAppConfig } from './config.js';

export interface RuntimeDependencyIssue {
  name: string;
  message: string;
}

export interface RuntimeDependencyCheck {
  name:
    | 'redis'
    | 'control-plane-postgres'
    | 'business-postgres'
    | 'tenant-business-postgres-template';
  required: boolean;
  configured: boolean;
  reachable: boolean | null;
  checkedAt: string;
  message: string | null;
}

export interface RuntimeDependencyChecksResult {
  ok: boolean;
  checks: RuntimeDependencyCheck[];
  issues: RuntimeDependencyIssue[];
}

function buildCheck(
  name: RuntimeDependencyCheck['name'],
  required: boolean,
  configured: boolean,
): RuntimeDependencyCheck {
  return {
    name,
    required,
    configured,
    reachable: null,
    checkedAt: new Date().toISOString(),
    message: null,
  };
}

async function checkRedis(config: ResolvedAppConfig) {
  const check = buildCheck('redis', config.queueBackend === 'redis', Boolean(config.redisUrl));
  if (!check.required) {
    check.message = 'not_required';
    return { check, issue: null };
  }

  if (!config.redisUrl) {
    check.reachable = false;
    check.message = 'APP_REDIS_URL is not configured.';
    return { check, issue: { name: check.name, message: check.message } };
  }

  const redis = new Redis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });

  try {
    await redis.connect();
    await redis.ping();
    check.checkedAt = new Date().toISOString();
    check.reachable = true;
    return { check, issue: null };
  } catch (error) {
    check.checkedAt = new Date().toISOString();
    check.reachable = false;
    check.message = error instanceof Error ? error.message : 'unknown';
    return { check, issue: { name: check.name, message: check.message } };
  } finally {
    redis.disconnect();
  }
}

async function checkPostgres(
  name: Extract<RuntimeDependencyCheck['name'], 'control-plane-postgres' | 'business-postgres'>,
  required: boolean,
  connectionString: string | null,
) {
  const check = buildCheck(name, required, Boolean(connectionString));
  if (!check.required) {
    check.message = 'not_required';
    return { check, issue: null };
  }

  if (!connectionString) {
    check.reachable = false;
    check.message =
      name === 'control-plane-postgres'
        ? 'APP_CONTROL_PLANE_POSTGRES_URL is not configured.'
        : 'APP_BUSINESS_POSTGRES_URL is not configured.';
    return { check, issue: { name: check.name, message: check.message } };
  }

  const pool = new Pool({
    connectionString,
    max: 2,
  });

  try {
    await pool.query('SELECT 1');
    check.checkedAt = new Date().toISOString();
    check.reachable = true;
    return { check, issue: null };
  } catch (error) {
    check.checkedAt = new Date().toISOString();
    check.reachable = false;
    check.message = error instanceof Error ? error.message : 'unknown';
    return { check, issue: { name: check.name, message: check.message } };
  } finally {
    await pool.end();
  }
}

function checkTenantBusinessPostgresTemplate(config: ResolvedAppConfig) {
  const check = buildCheck(
    'tenant-business-postgres-template',
    config.deploymentMode === 'saas' && config.tenantBusinessDatabaseEngine === 'postgres',
    Boolean(config.tenantBusinessPostgresUrlTemplate),
  );

  if (!check.required) {
    check.message = 'not_required';
    return { check, issue: null };
  }

  if (!config.tenantBusinessPostgresUrlTemplate) {
    check.reachable = false;
    check.message = 'APP_TENANT_BUSINESS_POSTGRES_URL_TEMPLATE is not configured.';
    return { check, issue: { name: check.name, message: check.message } };
  }

  try {
    const resolved = config.tenantBusinessPostgresUrlTemplate
      .replace(/\{tenantKey\}/g, 'preflight')
      .replace(/\{tenantKeyNormalized\}/g, 'preflight')
      .replace(/\{tenantId\}/g, '1');
    const parsed = new URL(resolved);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
      throw new Error(`unsupported protocol: ${parsed.protocol}`);
    }
    check.message = 'template_valid';
    return { check, issue: null };
  } catch (error) {
    check.reachable = false;
    check.message =
      error instanceof Error ? error.message : 'Invalid tenant business PostgreSQL URL template.';
    return { check, issue: { name: check.name, message: check.message } };
  }
}

export async function getRuntimeDependencyChecks(
  config: ResolvedAppConfig,
): Promise<RuntimeDependencyChecksResult> {
  const checks: RuntimeDependencyCheck[] = [];
  const issues: RuntimeDependencyIssue[] = [];

  const redisResult = await checkRedis(config);
  checks.push(redisResult.check);
  if (redisResult.issue) {
    issues.push(redisResult.issue);
  }

  const controlPlanePostgresResult = await checkPostgres(
    'control-plane-postgres',
    config.deploymentMode === 'saas' && config.controlPlaneDatabaseEngine === 'postgres',
    config.controlPlanePostgresUrl,
  );
  checks.push(controlPlanePostgresResult.check);
  if (controlPlanePostgresResult.issue) {
    issues.push(controlPlanePostgresResult.issue);
  }

  const businessPostgresResult = await checkPostgres(
    'business-postgres',
    config.deploymentMode === 'private' && config.businessDatabaseEngine === 'postgres',
    config.businessPostgresUrl,
  );
  checks.push(businessPostgresResult.check);
  if (businessPostgresResult.issue) {
    issues.push(businessPostgresResult.issue);
  }

  const tenantTemplateResult = checkTenantBusinessPostgresTemplate(config);
  checks.push(tenantTemplateResult.check);
  if (tenantTemplateResult.issue) {
    issues.push(tenantTemplateResult.issue);
  }

  return {
    ok: issues.length === 0,
    checks,
    issues,
  };
}

export async function assertRuntimeDependencyReadiness(config: ResolvedAppConfig) {
  const result = await getRuntimeDependencyChecks(config);
  if (result.ok) {
    return result;
  }

  throw new Error(
    ['Runtime dependency checks failed:', ...result.issues.map((issue) => `- ${issue.name}: ${issue.message}`)].join(
      '\n',
    ),
  );
}
