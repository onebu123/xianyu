import { createHmac, randomBytes } from 'node:crypto';

import Database from 'better-sqlite3';
import { format } from 'date-fns';

import { decryptSecret } from './auth.js';
import type { QueryFilters } from './types.js';

type OpenPlatformAppStatus = 'active' | 'suspended' | 'draft';
type OpenPlatformCallStatus = 'success' | 'blocked' | 'failure';

interface SecureSettingRecord {
  key: string;
  description: string;
  maskedValue: string;
  updatedAt: string;
  updatedByName: string | null;
}

interface OpenPlatformRepositoryHelpers {
  secureConfigSecret: string;
  getDashboard: (filters: QueryFilters) => unknown;
  getOrdersOverview: (filters: QueryFilters) => unknown;
  upsertSecureSetting: (
    key: string,
    description: string,
    value: string,
    updatedByUserId: number | null,
  ) => SecureSettingRecord;
}

export function buildOpenPlatformSecretSettingKey(appKey: string) {
  return `open_platform.app_secret.${appKey}`;
}

function normalizeOpenPlatformScopes(scopesText: string) {
  return scopesText
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export class OpenPlatformRepository {
  constructor(
    private readonly getDbConnection: () => Database.Database,
    private readonly helpers: OpenPlatformRepositoryHelpers,
  ) {}

  private get db() {
    return this.getDbConnection();
  }

  private getOpenPlatformSettingsRow() {
    return this.db
      .prepare(
        `
          SELECT
            ops.webhook_base_url AS webhookBaseUrl,
            ops.notify_email AS notifyEmail,
            ops.published_version AS publishedVersion,
            ops.default_rate_limit_per_minute AS defaultRateLimitPerMinute,
            ops.signature_ttl_seconds AS signatureTtlSeconds,
            ops.whitelist_enforced AS whitelistEnforced,
            ops.updated_at AS updatedAt,
            u.display_name AS updatedByName
          FROM open_platform_settings ops
          LEFT JOIN users u ON u.id = ops.updated_by
          WHERE ops.id = 1
        `,
      )
      .get() as
      | {
          webhookBaseUrl: string;
          notifyEmail: string;
          publishedVersion: string;
          defaultRateLimitPerMinute: number;
          signatureTtlSeconds: number;
          whitelistEnforced: number;
          updatedAt: string;
          updatedByName: string | null;
        }
      | undefined;
  }

  private listOpenPlatformCallLogs(limit = 20) {
    return this.db
      .prepare(
        `
          SELECT
            id,
            app_key AS appKey,
            tenant_key AS tenantKey,
            trace_id AS traceId,
            http_method AS httpMethod,
            route_path AS routePath,
            request_ip AS requestIp,
            status_code AS statusCode,
            call_status AS callStatus,
            duration_ms AS durationMs,
            detail,
            created_at AS createdAt
          FROM open_platform_call_logs
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `,
      )
      .all(limit) as Array<{
      id: number;
      appKey: string;
      tenantKey: string | null;
      traceId: string;
      httpMethod: string;
      routePath: string;
      requestIp: string | null;
      statusCode: number;
      callStatus: OpenPlatformCallStatus;
      durationMs: number;
      detail: string;
      createdAt: string;
    }>;
  }

  private listOpenPlatformApps() {
    const rows = this.db
      .prepare(
        `
          SELECT
            app.id,
            app.app_key AS appKey,
            app.app_name AS appName,
            app.owner_name AS ownerName,
            app.contact_name AS contactName,
            app.callback_url AS callbackUrl,
            app.status,
            app.scopes_text AS scopesText,
            app.rate_limit_per_minute AS rateLimitPerMinute,
            app.last_called_at AS lastCalledAt,
            app.created_at AS createdAt,
            app.updated_at AS updatedAt,
            ss.value_masked AS secretMasked,
            COALESCE(stats.successCount, 0) AS successCount,
            COALESCE(stats.blockedCount, 0) AS blockedCount,
            COALESCE(stats.failureCount, 0) AS failureCount
          FROM open_platform_apps app
          LEFT JOIN secure_settings ss ON ss.key = app.secret_setting_key
          LEFT JOIN (
            SELECT
              app_key,
              SUM(CASE WHEN call_status = 'success' THEN 1 ELSE 0 END) AS successCount,
              SUM(CASE WHEN call_status = 'blocked' THEN 1 ELSE 0 END) AS blockedCount,
              SUM(CASE WHEN call_status = 'failure' THEN 1 ELSE 0 END) AS failureCount
            FROM open_platform_call_logs
            WHERE datetime(created_at) >= datetime('now', '-7 day')
            GROUP BY app_key
          ) stats ON stats.app_key = app.app_key
          ORDER BY app.updated_at DESC, app.id DESC
        `,
      )
      .all() as Array<{
      id: number;
      appKey: string;
      appName: string;
      ownerName: string;
      contactName: string;
      callbackUrl: string;
      status: OpenPlatformAppStatus;
      scopesText: string;
      rateLimitPerMinute: number;
      lastCalledAt: string | null;
      createdAt: string;
      updatedAt: string;
      secretMasked: string | null;
      successCount: number;
      blockedCount: number;
      failureCount: number;
    }>;

    return rows.map((row) => ({
      ...row,
      scopes: normalizeOpenPlatformScopes(row.scopesText),
      totalCallCount: Number(row.successCount ?? 0) + Number(row.blockedCount ?? 0) + Number(row.failureCount ?? 0),
      secretMasked: row.secretMasked ?? '未生成',
    }));
  }

  private listOpenPlatformDocs() {
    return this.db
      .prepare(
        `
          SELECT
            id,
            doc_key AS docKey,
            title,
            category,
            http_method AS httpMethod,
            route_path AS routePath,
            status,
            scope_text AS scopeText,
            version_tag AS versionTag,
            description,
            sample_payload AS samplePayload,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM open_platform_docs
          ORDER BY category ASC, id ASC
        `,
      )
      .all() as Array<{
      id: number;
      docKey: string;
      title: string;
      category: string;
      httpMethod: string;
      routePath: string;
      status: 'published' | 'draft';
      scopeText: string;
      versionTag: string;
      description: string;
      samplePayload: string | null;
      createdAt: string;
      updatedAt: string;
    }>;
  }

  private listOpenPlatformWhitelistRules() {
    return this.db
      .prepare(
        `
          SELECT
            rule.id AS id,
            rule.rule_type AS ruleType,
            rule.rule_value AS ruleValue,
            rule.description AS description,
            rule.enabled AS enabled,
            rule.hit_count AS hitCount,
            rule.last_hit_at AS lastHitAt,
            rule.created_at AS createdAt,
            rule.updated_at AS updatedAt,
            u.display_name AS updatedByName
          FROM open_platform_whitelist_rules rule
          LEFT JOIN users u ON u.id = rule.updated_by
          ORDER BY rule.enabled DESC, rule.updated_at DESC, rule.id DESC
        `,
      )
      .all() as Array<{
      id: number;
      ruleType: 'ip';
      ruleValue: string;
      description: string;
      enabled: number;
      hitCount: number;
      lastHitAt: string | null;
      createdAt: string;
      updatedAt: string;
      updatedByName: string | null;
    }>;
  }

  getOpenPlatformAppsDetail() {
    const apps = this.listOpenPlatformApps();
    const recentCalls = this.listOpenPlatformCallLogs(12);
    const settings = this.getOpenPlatformSettingsRow();

    return {
      kind: 'open-apps' as const,
      title: '开放应用',
      description: '管理第三方接入应用、签名密钥和最近 7 天的调用状态。',
      metrics: [
        { label: '应用总数', value: apps.length, unit: '个', helper: '当前租户录入的开放应用数量' },
        {
          label: '启用应用',
          value: apps.filter((row) => row.status === 'active').length,
          unit: '个',
          helper: '可以正常发起调用的应用',
        },
        {
          label: '近 7 天调用',
          value: recentCalls.length === 0 ? 0 : apps.reduce((total, row) => total + row.totalCallCount, 0),
          unit: '次',
          helper: '包含成功、拦截和失败调用',
        },
        {
          label: '默认限流',
          value: Number(settings?.defaultRateLimitPerMinute ?? 0),
          unit: '次/分钟',
          helper: '未单独配置时的默认速率限制',
        },
      ],
      apps,
      recentCalls,
    };
  }

  getOpenPlatformDocsDetail() {
    const docs = this.listOpenPlatformDocs();
    const settings = this.getOpenPlatformSettingsRow();

    return {
      kind: 'open-docs' as const,
      title: '开放文档',
      description: '统一维护公网 API 文档、发布版本和签名约定。',
      metrics: [
        { label: '文档数', value: docs.length, unit: '份', helper: '包含已发布和草稿文档' },
        {
          label: '已发布',
          value: docs.filter((row) => row.status === 'published').length,
          unit: '份',
          helper: '当前对外可用的文档',
        },
        {
          label: '当前版本',
          value: settings?.publishedVersion ?? 'v1',
          unit: '',
          helper: '对外发布的文档版本',
        },
        {
          label: '读取接口',
          value: docs.filter((row) => row.category === '读取接口').length,
          unit: '份',
          helper: '以查询和聚合为主的接口文档',
        },
      ],
      docs,
    };
  }

  getOpenPlatformSettingsDetail() {
    const settings = this.getOpenPlatformSettingsRow();
    const apps = this.listOpenPlatformApps();
    const rules = this.listOpenPlatformWhitelistRules();

    return {
      kind: 'open-settings' as const,
      title: '开放平台设置',
      description: '管理回调域名、默认速率限制、签名时效和白名单策略。',
      metrics: [
        {
          label: '已配置密钥',
          value: apps.filter((row) => row.secretMasked !== '未生成').length,
          unit: '个',
          helper: '开放应用签名密钥已脱敏存储',
        },
        {
          label: '启用白名单',
          value: rules.filter((row) => row.enabled).length,
          unit: '条',
          helper: '当前启用的来源控制规则',
        },
        {
          label: '签名有效期',
          value: Number(settings?.signatureTtlSeconds ?? 0),
          unit: '秒',
          helper: '请求允许的时间偏差',
        },
        {
          label: '默认回调域名',
          value: settings?.webhookBaseUrl || '未配置',
          unit: '',
          helper: '新应用默认使用的回调域名',
        },
      ],
      settings: settings
        ? {
            ...settings,
            whitelistEnforced: Boolean(settings.whitelistEnforced),
          }
        : null,
    };
  }

  getOpenPlatformWhitelistDetail() {
    const rules = this.listOpenPlatformWhitelistRules().map((row) => ({
      ...row,
      enabled: Boolean(row.enabled),
    }));
    const recentCalls = this.listOpenPlatformCallLogs(20);

    return {
      kind: 'open-whitelist' as const,
      title: '开放平台白名单',
      description: '按来源 IP 控制公网 API 可访问范围，并结合调用留痕做防护。',
      metrics: [
        { label: '规则总数', value: rules.length, unit: '条', helper: '当前租户的白名单规则数' },
        {
          label: '已启用',
          value: rules.filter((row) => row.enabled).length,
          unit: '条',
          helper: '当前参与校验的规则',
        },
        {
          label: '累计命中',
          value: rules.reduce((total, row) => total + Number(row.hitCount ?? 0), 0),
          unit: '次',
          helper: '白名单规则命中的累计次数',
        },
        {
          label: '近 7 天拦截',
          value: recentCalls.filter((row) => row.callStatus === 'blocked').length,
          unit: '次',
          helper: '白名单或签名校验拦截的请求',
        },
      ],
      rules,
    };
  }

  createOpenPlatformApp(input: {
    appName: string;
    ownerName: string;
    contactName?: string;
    callbackUrl?: string;
    scopes: string[];
    rateLimitPerMinute?: number;
    updatedByUserId: number | null;
  }) {
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const normalizedBase =
      input.appName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 24) || 'open-app';

    let appKey = normalizedBase;
    let suffix = 2;
    while (this.db.prepare('SELECT 1 FROM open_platform_apps WHERE app_key = ? LIMIT 1').get(appKey)) {
      appKey = `${normalizedBase}-${suffix}`;
      suffix += 1;
    }

    const secretSettingKey = buildOpenPlatformSecretSettingKey(appKey);
    const secretPlainText = randomBytes(24).toString('base64url');
    this.helpers.upsertSecureSetting(
      secretSettingKey,
      `开放平台应用 ${input.appName} 的签名密钥`,
      secretPlainText,
      input.updatedByUserId,
    );

    const insertResult = this.db
      .prepare(
        `
          INSERT INTO open_platform_apps (
            app_key,
            app_name,
            owner_name,
            contact_name,
            callback_url,
            status,
            scopes_text,
            secret_setting_key,
            rate_limit_per_minute,
            created_at,
            updated_at,
            updated_by
          ) VALUES (
            @appKey,
            @appName,
            @ownerName,
            @contactName,
            @callbackUrl,
            'active',
            @scopesText,
            @secretSettingKey,
            @rateLimitPerMinute,
            @createdAt,
            @updatedAt,
            @updatedBy
          )
        `,
      )
      .run({
        appKey,
        appName: input.appName.trim(),
        ownerName: input.ownerName.trim(),
        contactName: input.contactName?.trim() ?? '',
        callbackUrl: input.callbackUrl?.trim() ?? '',
        scopesText: input.scopes.join(','),
        secretSettingKey,
        rateLimitPerMinute: Math.max(input.rateLimitPerMinute ?? 120, 30),
        createdAt: now,
        updatedAt: now,
        updatedBy: input.updatedByUserId,
      });

    const created = this.db
      .prepare(
        `
          SELECT
            id,
            app_key AS appKey,
            app_name AS appName,
            owner_name AS ownerName,
            contact_name AS contactName,
            callback_url AS callbackUrl,
            status,
            scopes_text AS scopesText,
            rate_limit_per_minute AS rateLimitPerMinute,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM open_platform_apps
          WHERE id = ?
        `,
      )
      .get(Number(insertResult.lastInsertRowid)) as
      | {
          id: number;
          appKey: string;
          appName: string;
          ownerName: string;
          contactName: string;
          callbackUrl: string;
          status: OpenPlatformAppStatus;
          scopesText: string;
          rateLimitPerMinute: number;
          createdAt: string;
          updatedAt: string;
        }
      | undefined;

    return created
      ? {
          ...created,
          scopes: normalizeOpenPlatformScopes(created.scopesText),
          secretPlainText,
        }
      : null;
  }

  updateOpenPlatformAppStatus(appId: number, status: 'active' | 'suspended') {
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const result = this.db
      .prepare(
        `
          UPDATE open_platform_apps
          SET status = @status, updated_at = @updatedAt
          WHERE id = @id
        `,
      )
      .run({
        id: appId,
        status,
        updatedAt: now,
      });

    if (result.changes === 0) {
      return null;
    }

    return this.db
      .prepare(
        `
          SELECT
            id,
            app_key AS appKey,
            app_name AS appName,
            status,
            updated_at AS updatedAt
          FROM open_platform_apps
          WHERE id = ?
        `,
      )
      .get(appId) as
      | {
          id: number;
          appKey: string;
          appName: string;
          status: OpenPlatformAppStatus;
          updatedAt: string;
        }
      | undefined
      | null;
  }

  rotateOpenPlatformAppSecret(appId: number, updatedByUserId: number | null) {
    const app = this.db
      .prepare(
        `
          SELECT
            id,
            app_key AS appKey,
            app_name AS appName,
            secret_setting_key AS secretSettingKey
          FROM open_platform_apps
          WHERE id = ?
        `,
      )
      .get(appId) as
      | {
          id: number;
          appKey: string;
          appName: string;
          secretSettingKey: string;
        }
      | undefined;

    if (!app) {
      return null;
    }

    const secretPlainText = randomBytes(24).toString('base64url');
    const setting = this.helpers.upsertSecureSetting(
      app.secretSettingKey,
      `开放平台应用 ${app.appName} 的签名密钥`,
      secretPlainText,
      updatedByUserId,
    );
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    this.db.prepare('UPDATE open_platform_apps SET updated_at = ? WHERE id = ?').run(now, appId);

    return {
      ...app,
      secretPlainText,
      secretMasked: setting.maskedValue,
      updatedAt: now,
    };
  }

  updateOpenPlatformSettings(input: {
    webhookBaseUrl?: string;
    notifyEmail?: string;
    publishedVersion?: string;
    defaultRateLimitPerMinute?: number;
    signatureTtlSeconds?: number;
    whitelistEnforced?: boolean;
    updatedByUserId: number | null;
  }) {
    const current = this.getOpenPlatformSettingsRow();
    if (!current) {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    this.db
      .prepare(
        `
          UPDATE open_platform_settings
          SET
            webhook_base_url = @webhookBaseUrl,
            notify_email = @notifyEmail,
            published_version = @publishedVersion,
            default_rate_limit_per_minute = @defaultRateLimitPerMinute,
            signature_ttl_seconds = @signatureTtlSeconds,
            whitelist_enforced = @whitelistEnforced,
            updated_at = @updatedAt,
            updated_by = @updatedBy
          WHERE id = 1
        `,
      )
      .run({
        webhookBaseUrl: input.webhookBaseUrl?.trim() ?? current.webhookBaseUrl,
        notifyEmail: input.notifyEmail?.trim() ?? current.notifyEmail,
        publishedVersion: input.publishedVersion?.trim() ?? current.publishedVersion,
        defaultRateLimitPerMinute: Math.max(input.defaultRateLimitPerMinute ?? current.defaultRateLimitPerMinute, 30),
        signatureTtlSeconds: Math.max(input.signatureTtlSeconds ?? current.signatureTtlSeconds, 60),
        whitelistEnforced: input.whitelistEnforced ?? Boolean(current.whitelistEnforced) ? 1 : 0,
        updatedAt: now,
        updatedBy: input.updatedByUserId,
      });

    return this.getOpenPlatformSettingsDetail().settings;
  }

  createOpenPlatformWhitelistRule(input: {
    ruleType: 'ip';
    ruleValue: string;
    description?: string;
    enabled?: boolean;
    updatedByUserId: number | null;
  }) {
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const insertResult = this.db
      .prepare(
        `
          INSERT INTO open_platform_whitelist_rules (
            rule_type,
            rule_value,
            description,
            enabled,
            hit_count,
            created_at,
            updated_at,
            updated_by
          ) VALUES (
            @ruleType,
            @ruleValue,
            @description,
            @enabled,
            0,
            @createdAt,
            @updatedAt,
            @updatedBy
          )
        `,
      )
      .run({
        ruleType: input.ruleType,
        ruleValue: input.ruleValue.trim(),
        description: input.description?.trim() ?? '',
        enabled: input.enabled ?? true ? 1 : 0,
        createdAt: now,
        updatedAt: now,
        updatedBy: input.updatedByUserId,
      });

    return this.db
      .prepare(
        `
          SELECT
            id,
            rule_type AS ruleType,
            rule_value AS ruleValue,
            description,
            enabled,
            hit_count AS hitCount,
            last_hit_at AS lastHitAt,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM open_platform_whitelist_rules
          WHERE id = ?
        `,
      )
      .get(Number(insertResult.lastInsertRowid)) as
      | {
          id: number;
          ruleType: 'ip';
          ruleValue: string;
          description: string;
          enabled: number;
          hitCount: number;
          lastHitAt: string | null;
          createdAt: string;
          updatedAt: string;
        }
      | undefined
      | null;
  }

  updateOpenPlatformWhitelistRuleEnabled(ruleId: number, enabled: boolean, updatedByUserId: number | null) {
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const result = this.db
      .prepare(
        `
          UPDATE open_platform_whitelist_rules
          SET enabled = @enabled, updated_at = @updatedAt, updated_by = @updatedBy
          WHERE id = @id
        `,
      )
      .run({
        id: ruleId,
        enabled: enabled ? 1 : 0,
        updatedAt: now,
        updatedBy: updatedByUserId,
      });

    if (result.changes === 0) {
      return null;
    }

    return this.db
      .prepare(
        `
          SELECT
            id,
            rule_type AS ruleType,
            rule_value AS ruleValue,
            description,
            enabled,
            hit_count AS hitCount,
            last_hit_at AS lastHitAt,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM open_platform_whitelist_rules
          WHERE id = ?
        `,
      )
      .get(ruleId) as
      | {
          id: number;
          ruleType: 'ip';
          ruleValue: string;
          description: string;
          enabled: number;
          hitCount: number;
          lastHitAt: string | null;
          createdAt: string;
          updatedAt: string;
        }
      | undefined
      | null;
  }

  private matchOpenPlatformIpRule(ruleValue: string, ipAddress: string) {
    const escaped = ruleValue
      .trim()
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    const pattern = new RegExp(`^${escaped}$`);
    return pattern.test(ipAddress.trim());
  }

  private getOpenPlatformAppSecret(secretSettingKey: string) {
    const row = this.db
      .prepare(
        `
          SELECT value_encrypted AS valueEncrypted
          FROM secure_settings
          WHERE key = ?
          LIMIT 1
        `,
      )
      .get(secretSettingKey) as { valueEncrypted: string } | undefined;

    if (!row?.valueEncrypted) {
      return null;
    }

    return decryptSecret(row.valueEncrypted, this.helpers.secureConfigSecret);
  }

  verifyOpenPlatformRequest(input: {
    tenantKey: string;
    appKey: string;
    timestamp: string;
    signature: string;
    httpMethod: string;
    routePath: string;
    requestIp: string;
    requiredScope: string;
  }) {
    const app = this.db
      .prepare(
        `
          SELECT
            id,
            app_key AS appKey,
            app_name AS appName,
            status,
            scopes_text AS scopesText,
            secret_setting_key AS secretSettingKey,
            rate_limit_per_minute AS rateLimitPerMinute
          FROM open_platform_apps
          WHERE app_key = ?
          LIMIT 1
        `,
      )
      .get(input.appKey) as
      | {
          id: number;
          appKey: string;
          appName: string;
          status: OpenPlatformAppStatus;
          scopesText: string;
          secretSettingKey: string;
          rateLimitPerMinute: number;
        }
      | undefined;

    if (!app) {
      throw new Error('开放应用不存在');
    }
    if (app.status !== 'active') {
      throw new Error('开放应用已停用');
    }

    const scopes = normalizeOpenPlatformScopes(app.scopesText);
    if (!scopes.includes(input.requiredScope)) {
      throw new Error('开放应用未授权当前接口范围');
    }

    const settings = this.getOpenPlatformSettingsRow();
    const ttlSeconds = Math.max(Number(settings?.signatureTtlSeconds ?? 300), 60);
    const requestTime = Number(input.timestamp);
    if (!Number.isFinite(requestTime)) {
      throw new Error('签名时间戳无效');
    }
    if (Math.abs(Date.now() - requestTime) > ttlSeconds * 1000) {
      throw new Error('签名已过期');
    }

    const secret = this.getOpenPlatformAppSecret(app.secretSettingKey);
    if (!secret) {
      throw new Error('开放应用未配置签名密钥');
    }

    const expectedSignature = createHmac('sha256', secret)
      .update(`${app.appKey}.${input.timestamp}.${input.httpMethod.toUpperCase()}.${input.routePath}`)
      .digest('hex');
    if (expectedSignature !== input.signature.trim().toLowerCase()) {
      throw new Error('签名校验失败');
    }

    const rules = this.listOpenPlatformWhitelistRules().filter((row) => Boolean(row.enabled));
    const whitelistEnforced = Boolean(settings?.whitelistEnforced);
    if (
      whitelistEnforced &&
      rules.length > 0 &&
      !rules.some((rule) => this.matchOpenPlatformIpRule(rule.ruleValue, input.requestIp))
    ) {
      throw new Error('来源地址未命中白名单');
    }

    return {
      ...app,
      scopes,
    };
  }

  recordOpenPlatformCallLog(input: {
    appId: number | null;
    appKey: string;
    tenantKey: string;
    traceId: string;
    httpMethod: string;
    routePath: string;
    requestIp: string | null;
    statusCode: number;
    callStatus: OpenPlatformCallStatus;
    durationMs: number;
    detail: string;
  }) {
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    this.db
      .prepare(
        `
          INSERT INTO open_platform_call_logs (
            app_id,
            app_key,
            tenant_key,
            trace_id,
            http_method,
            route_path,
            request_ip,
            status_code,
            call_status,
            duration_ms,
            detail,
            created_at
          ) VALUES (
            @appId,
            @appKey,
            @tenantKey,
            @traceId,
            @httpMethod,
            @routePath,
            @requestIp,
            @statusCode,
            @callStatus,
            @durationMs,
            @detail,
            @createdAt
          )
        `,
      )
      .run({
        ...input,
        createdAt: now,
        durationMs: Math.max(Math.trunc(input.durationMs), 0),
      });

    if (input.appId) {
      this.db
        .prepare(
          `
            UPDATE open_platform_apps
            SET last_called_at = @lastCalledAt, updated_at = @updatedAt
            WHERE id = @id
          `,
        )
        .run({
          id: input.appId,
          lastCalledAt: now,
          updatedAt: now,
        });
    }
  }

  getOpenPlatformPublicDashboardSummary() {
    return this.helpers.getDashboard({ preset: 'last30Days' });
  }

  getOpenPlatformPublicOrdersOverview() {
    return this.helpers.getOrdersOverview({ preset: 'last30Days' });
  }
}
