import Database from 'better-sqlite3';
import { format } from 'date-fns';

import { decryptSecret } from './auth.js';
import { appConfig } from './config.js';
import { resolveStoreAuthProviderPlan } from './store-auth-providers.js';
import type { StoreAuthIntegrationMode } from './types.js';
import type { XianyuWebSocketAuthCache } from './xianyu-web-session.js';

type StorePlatform = 'xianyu' | 'taobao';
type StoreConnectionStatus = 'pending_activation' | 'active' | 'offline' | 'abnormal';
type StoreAuthStatus = 'authorized' | 'expired' | 'invalidated' | 'pending';
type StoreAuthSessionStatus = 'pending' | 'completed' | 'expired' | 'invalidated';
type StoreHealthStatus = 'healthy' | 'warning' | 'offline' | 'abnormal' | 'skipped';
type StoreCredentialRiskLevel = 'pending' | 'healthy' | 'warning' | 'offline' | 'abnormal';
type StoreCredentialEventType =
  | 'qr_login_started'
  | 'browser_qr_login_started'
  | 'browser_qr_login_accepted'
  | 'credential_captured'
  | 'profile_synced'
  | 'credential_verified'
  | 'browser_renewed'
  | 'manual_takeover_required';
type StoreCredentialEventStatus = 'info' | 'success' | 'warning' | 'error';
type StoreProfileSyncStatus = 'pending' | 'syncing' | 'success' | 'failed';
type StoreAuthSessionNextStep =
  | 'manual_complete'
  | 'wait_provider_callback'
  | 'sync_profile'
  | 'done'
  | 'expired'
  | 'invalidated';

interface ManagedStoreRecord {
  id: number;
  platform: StorePlatform;
  shopTypeLabel: string;
  shopName: string;
  sellerNo: string;
  nickname: string;
  statusText: string;
  activationStatus: string;
  packageText: string;
  publishLimitText: string;
  createdAt: string;
  updatedAt: string;
  ownerAccountId: number | null;
  ownerAccountName: string | null;
  ownerMobile: string | null;
  createdByUserId: number | null;
  createdByName: string | null;
  groupName: string;
  tagsText: string;
  remark: string;
  enabled: number;
  connectionStatus: StoreConnectionStatus;
  authStatus: StoreAuthStatus;
  authExpiresAt: string | null;
  lastSyncAt: string | null;
  healthStatus: StoreHealthStatus;
  lastHealthCheckAt: string | null;
  lastHealthCheckDetail: string | null;
  lastSessionId: string | null;
  lastReauthorizeAt: string | null;
  providerStoreId: string | null;
  providerUserId: string | null;
  credentialId: number | null;
  credentialType: string | null;
  credentialSource: string | null;
  credentialRiskLevel: StoreCredentialRiskLevel | null;
  credentialRiskReason: string | null;
  credentialVerificationUrl: string | null;
  lastCredentialRenewAt: string | null;
  lastCredentialRenewStatus: string | null;
  profileSyncStatus: StoreProfileSyncStatus;
  profileSyncError: string | null;
  lastProfileSyncAt: string | null;
  lastVerifiedAt: string | null;
}

interface ManagedStoreCredentialContext {
  storeId: number;
  platform: StorePlatform;
  shopName: string;
  enabled: number;
  connectionStatus: StoreConnectionStatus;
  providerUserId: string | null;
  credentialId: number | null;
  credentialType: string | null;
  accessTokenEncrypted: string | null;
}

interface StoreCredentialEventRecord {
  id: number;
  storeId: number | null;
  sessionId: string | null;
  credentialId: number | null;
  eventType: StoreCredentialEventType;
  status: StoreCredentialEventStatus;
  detail: string;
  source: string | null;
  riskLevel: StoreCredentialRiskLevel | null;
  verificationUrl: string | null;
  createdAt: string;
  operatorName: string | null;
}

interface StoreAuthSessionStepInfo {
  nextStepKey: StoreAuthSessionNextStep;
  nextStepText: string;
}

export class StoreAccessReadRepository {
  constructor(
    private readonly getDbConnection: () => Database.Database,
    private readonly secureConfigSecret: string,
  ) {}

  private get db() {
    return this.getDbConnection();
  }

  private parseStoreTags(tagsText: string) {
    return tagsText
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private getStoreConnectionStatusText(status: StoreConnectionStatus) {
    return (
      {
        pending_activation: '待激活',
        active: '已激活',
        offline: '掉线',
        abnormal: '异常',
      }[status] ?? status
    );
  }

  private getStoreAuthStatusText(status: StoreAuthStatus | StoreAuthSessionStatus) {
    return (
      {
        authorized: '已授权',
        pending: '待完成',
        completed: '已完成',
        expired: '已过期',
        invalidated: '已失效',
      }[status] ?? status
    );
  }

  private getStoreHealthStatusText(status: StoreHealthStatus) {
    return (
      {
        healthy: '健康',
        warning: '待处理',
        offline: '掉线',
        abnormal: '异常',
        skipped: '已跳过',
      }[status] ?? status
    );
  }

  private getStoreProfileSyncStatusText(status: StoreProfileSyncStatus) {
    return (
      {
        pending: '待同步',
        syncing: '同步中',
        success: '已同步',
        failed: '同步失败',
      }[status] ?? status
    );
  }

  private getStoreCredentialEventTypeText(type: StoreCredentialEventType) {
    return (
      {
        qr_login_started: '扫码登录',
        browser_qr_login_started: '浏览器扫码',
        browser_qr_login_accepted: '浏览器扫码接收',
        credential_captured: '登录态入库',
        profile_synced: '资料同步',
        credential_verified: '登录态校验',
        browser_renewed: '浏览器续登',
        manual_takeover_required: '人工接管',
      }[type] ?? type
    );
  }

  private getStoreCredentialEventStatusText(status: StoreCredentialEventStatus) {
    return (
      {
        info: '已记录',
        success: '成功',
        warning: '待处理',
        error: '失败',
      }[status] ?? status
    );
  }

  private normalizeStoreAuthSessionNextStep(
    value: string | null | undefined,
  ): StoreAuthSessionNextStep | null {
    if (
      value === 'manual_complete' ||
      value === 'wait_provider_callback' ||
      value === 'sync_profile' ||
      value === 'done' ||
      value === 'expired' ||
      value === 'invalidated'
    ) {
      return value;
    }

    return null;
  }

  private getManagedStoreStatusText(status: StoreConnectionStatus, enabled: boolean) {
    if (!enabled) {
      return '已停用';
    }

    return (
      {
        pending_activation: '未激活',
        active: '基础',
        offline: '掉线',
        abnormal: '异常',
      }[status] ?? status
    );
  }

  private getStoreAuthSessionStepInfo(input: {
    status: StoreAuthSessionStatus;
    integrationMode: StoreAuthIntegrationMode;
    nextStep?: string | null;
    profileSyncStatus?: StoreProfileSyncStatus | null;
    profileSyncError?: string | null;
    providerAccessTokenReceivedAt?: string | null;
    invalidReason?: string | null;
  }): StoreAuthSessionStepInfo {
    if (input.status === 'completed') {
      return {
        nextStepKey: 'done',
        nextStepText: '已完成资料补齐与绑店。',
      };
    }

    if (input.status === 'expired') {
      return {
        nextStepKey: 'expired',
        nextStepText: '授权会话已过期，需要重新发起授权。',
      };
    }

    if (input.status === 'invalidated') {
      return {
        nextStepKey: 'invalidated',
        nextStepText: input.invalidReason?.trim() || '授权会话已失效。',
      };
    }

    const explicitNextStep = this.normalizeStoreAuthSessionNextStep(input.nextStep);
    if (explicitNextStep === 'sync_profile') {
      if (input.profileSyncStatus === 'failed' && input.profileSyncError?.trim()) {
        return {
          nextStepKey: 'sync_profile',
          nextStepText: `资料同步失败：${input.profileSyncError.trim()}`,
        };
      }

      if (input.profileSyncStatus === 'syncing') {
        return {
          nextStepKey: 'sync_profile',
          nextStepText: '正在同步卖家与店铺资料，请稍后刷新。',
        };
      }

      return {
        nextStepKey: 'sync_profile',
        nextStepText: '已接收官方回调，待换取店铺资料并完成绑店。',
      };
    }

    if (explicitNextStep) {
      return this.getStoreAuthSessionStepInfo({
        ...input,
        nextStep: null,
        status:
          explicitNextStep === 'done'
            ? 'completed'
            : explicitNextStep === 'expired'
              ? 'expired'
              : explicitNextStep === 'invalidated'
                ? 'invalidated'
                : input.status,
      });
    }

    if (input.integrationMode === 'xianyu_browser_oauth') {
      if (input.providerAccessTokenReceivedAt) {
        return {
          nextStepKey: 'sync_profile',
          nextStepText: '已接收官方回调，待换取店铺资料并完成绑店。',
        };
      }

      return {
        nextStepKey: 'wait_provider_callback',
        nextStepText: '等待跳转到闲鱼授权页面并接收官方回调。',
      };
    }

    if (input.integrationMode === 'xianyu_web_session') {
      if (input.providerAccessTokenReceivedAt) {
        return {
          nextStepKey: 'sync_profile',
          nextStepText: '已录入网页登录态，待补齐卖家与店铺资料。',
        };
      }

      return {
        nextStepKey: 'manual_complete',
        nextStepText: '等待录入网页登录态与店铺资料，并完成绑店。',
      };
    }

    return {
      nextStepKey: 'manual_complete',
      nextStepText: '等待站内补全账号资料并完成建店。',
    };
  }

  private listManagedStores() {
    const rows = this.db
      .prepare(
        `
          SELECT
            ms.id,
            ms.platform,
            ms.shop_type_label AS shopTypeLabel,
            ms.shop_name AS shopName,
            ms.seller_no AS sellerNo,
            ms.nickname,
            ms.status_text AS statusText,
            ms.activation_status AS activationStatus,
            ms.package_text AS packageText,
            ms.publish_limit_text AS publishLimitText,
            ms.created_at AS createdAt,
            ms.updated_at AS updatedAt,
            ms.owner_account_id AS ownerAccountId,
            oa.owner_name AS ownerAccountName,
            oa.mobile AS ownerMobile,
            ms.created_by_user_id AS createdByUserId,
            u.display_name AS createdByName,
            ms.group_name AS groupName,
            ms.tags_text AS tagsText,
            ms.remark,
            ms.enabled,
            ms.connection_status AS connectionStatus,
            ms.auth_status AS authStatus,
            ms.auth_expires_at AS authExpiresAt,
            ms.last_sync_at AS lastSyncAt,
            ms.health_status AS healthStatus,
            ms.last_health_check_at AS lastHealthCheckAt,
            ms.last_health_check_detail AS lastHealthCheckDetail,
            ms.last_session_id AS lastSessionId,
            ms.last_reauthorize_at AS lastReauthorizeAt,
            ms.provider_store_id AS providerStoreId,
            ms.provider_user_id AS providerUserId,
            ms.credential_id AS credentialId,
            spc.credential_type AS credentialType,
            spc.credential_source AS credentialSource,
            spc.risk_level AS credentialRiskLevel,
            spc.risk_reason AS credentialRiskReason,
            spc.verification_url AS credentialVerificationUrl,
            spc.last_renewed_at AS lastCredentialRenewAt,
            spc.last_renew_status AS lastCredentialRenewStatus,
            ms.profile_sync_status AS profileSyncStatus,
            ms.profile_sync_error AS profileSyncError,
            ms.last_profile_sync_at AS lastProfileSyncAt,
            ms.last_verified_at AS lastVerifiedAt
          FROM managed_stores ms
          LEFT JOIN store_owner_accounts oa ON oa.id = ms.owner_account_id
          LEFT JOIN users u ON u.id = ms.created_by_user_id
          LEFT JOIN store_platform_credentials spc ON spc.id = ms.credential_id
          ORDER BY ms.updated_at DESC, ms.id DESC
        `,
      )
      .all() as ManagedStoreRecord[];

    return rows.map((row) => {
      const enabled = Boolean(row.enabled);
      const connectionStatus = row.connectionStatus;
      const authStatus = row.authStatus;
      const healthStatus = row.healthStatus;

      return {
        ...row,
        enabled,
        scheduleStatus: enabled ? ('running' as const) : ('paused' as const),
        connectionStatus,
        connectionStatusText: this.getStoreConnectionStatusText(connectionStatus),
        authStatus,
        authStatusText: this.getStoreAuthStatusText(authStatus),
        healthStatus,
        healthStatusText: this.getStoreHealthStatusText(healthStatus),
        profileSyncStatusText: this.getStoreProfileSyncStatusText(row.profileSyncStatus),
        statusText: this.getManagedStoreStatusText(connectionStatus, enabled),
        activationStatus: connectionStatus,
        tags: this.parseStoreTags(row.tagsText),
        activationHint:
          connectionStatus === 'pending_activation' ? '授权已完成，激活后才会进入正式调度。' : null,
      };
    });
  }

  private listStoreAuthSessions(limit = 24) {
    const rows = this.db
      .prepare(
        `
          SELECT
            sas.session_id AS sessionId,
            sas.platform,
            sas.source,
            sas.auth_type AS authType,
            sas.status,
            sas.integration_mode AS integrationMode,
            sas.provider_label AS providerLabel,
            sas.next_step AS nextStep,
            sas.profile_sync_status AS profileSyncStatus,
            sas.profile_sync_error AS profileSyncError,
            sas.created_at AS createdAt,
            sas.expires_at AS expiresAt,
            sas.completed_at AS completedAt,
            sas.invalid_reason AS invalidReason,
            sas.provider_access_token_received_at AS providerAccessTokenReceivedAt,
            sas.store_id AS storeId,
            sas.owner_account_id AS ownerAccountId,
            sas.mobile,
            sas.nickname,
            sas.reauthorize,
            ms.shop_name AS storeName,
            oa.owner_name AS ownerAccountName,
            u.display_name AS createdByName
          FROM store_auth_sessions sas
          LEFT JOIN managed_stores ms ON ms.id = sas.store_id
          LEFT JOIN store_owner_accounts oa ON oa.id = sas.owner_account_id
          LEFT JOIN users u ON u.id = sas.created_by_user_id
          ORDER BY sas.created_at DESC, sas.session_id DESC
          LIMIT ?
        `,
      )
      .all(limit) as Array<{
      sessionId: string;
      platform: StorePlatform;
      source: string;
      authType: number;
      status: StoreAuthSessionStatus;
      integrationMode: StoreAuthIntegrationMode;
      providerLabel: string | null;
      nextStep: string | null;
      profileSyncStatus: StoreProfileSyncStatus;
      profileSyncError: string | null;
      createdAt: string;
      expiresAt: string | null;
      completedAt: string | null;
      invalidReason: string | null;
      providerAccessTokenReceivedAt: string | null;
      storeId: number | null;
      ownerAccountId: number | null;
      mobile: string | null;
      nickname: string | null;
      reauthorize: number;
      storeName: string | null;
      ownerAccountName: string | null;
      createdByName: string | null;
    }>;

    return rows.map((row) => ({
      ...row,
      reauthorize: Boolean(row.reauthorize),
      statusText: this.getStoreAuthStatusText(row.status),
      tokenReceived: Boolean(row.providerAccessTokenReceivedAt),
      ...this.getStoreAuthSessionStepInfo({
        status: row.status,
        integrationMode: row.integrationMode,
        nextStep: row.nextStep,
        profileSyncStatus: row.profileSyncStatus,
        profileSyncError: row.profileSyncError,
        providerAccessTokenReceivedAt: row.providerAccessTokenReceivedAt,
        invalidReason: row.invalidReason,
      }),
    }));
  }

  private listStoreHealthChecks(limit = 24) {
    const rows = this.db
      .prepare(
        `
          SELECT
            shc.id,
            shc.store_id AS storeId,
            ms.shop_name AS storeName,
            shc.status,
            shc.detail,
            shc.checked_at AS checkedAt,
            shc.trigger_mode AS triggerMode,
            u.display_name AS triggeredByName
          FROM store_health_checks shc
          LEFT JOIN managed_stores ms ON ms.id = shc.store_id
          LEFT JOIN users u ON u.id = shc.triggered_by_user_id
          ORDER BY shc.checked_at DESC, shc.id DESC
          LIMIT ?
        `,
      )
      .all(limit) as Array<{
      id: number;
      storeId: number;
      storeName: string | null;
      status: StoreHealthStatus;
      detail: string;
      checkedAt: string;
      triggerMode: string;
      triggeredByName: string | null;
    }>;

    return rows.map((row) => ({
      ...row,
      statusText: this.getStoreHealthStatusText(row.status),
    }));
  }

  getStoreManagementOverview() {
    const profile = this.db
      .prepare(
        `
          SELECT
            display_name AS displayName,
            mobile,
            updated_at AS updatedAt
          FROM store_operator_profile
          ORDER BY id
          LIMIT 1
        `,
      )
      .get() as { displayName: string; mobile: string; updatedAt: string } | undefined;
    const fallbackAdmin = this.db
      .prepare(
        `
          SELECT display_name AS displayName
          FROM users
          WHERE role = 'admin'
          ORDER BY id
          LIMIT 1
        `,
      )
      .get() as { displayName: string } | undefined;

    const stores = this.listManagedStores();
    const xianyuStores = stores.filter((store) => store.platform === 'xianyu');
    const taobaoStores = stores.filter((store) => store.platform === 'taobao');
    const authSessions = this.listStoreAuthSessions();
    const healthChecks = this.listStoreHealthChecks();
    const groups = Array.from(
      stores.reduce((accumulator, store) => {
        const count = accumulator.get(store.groupName) ?? 0;
        accumulator.set(store.groupName, count + 1);
        return accumulator;
      }, new Map<string, number>()),
    )
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, 'zh-CN'));

    return {
      profile: profile ?? {
        displayName: fallbackAdmin?.displayName ?? '系统管理员',
        mobile: '未配置',
        updatedAt: format(new Date(), 'yyyy-MM-dd HH:mm:ss'),
      },
      actions: [
        { key: 'xianyu', label: '创建闲鱼店铺', description: '发起新的闲鱼官方授权会话。' },
        { key: 'taobao', label: '创建淘宝店铺', description: '发起新的淘宝授权会话。' },
        { key: 'reauthorize', label: '重新授权', description: '针对掉线、过期、异常店铺重新建立授权。' },
        { key: 'batch-health-check', label: '批量体检', description: '对已启用店铺执行健康检查。' },
      ],
      stores,
      xianyuStores,
      taobaoStores,
      authSessions,
      healthChecks,
      groups,
      summaries: {
        totalStoreCount: stores.length,
        xianyuStoreCount: xianyuStores.length,
        taobaoStoreCount: taobaoStores.length,
        enabledStoreCount: stores.filter((store) => store.enabled).length,
        disabledStoreCount: stores.filter((store) => !store.enabled).length,
        pendingActivationCount: xianyuStores.filter(
          (item) => item.connectionStatus === 'pending_activation',
        ).length,
        activeStoreCount: stores.filter((item) => item.connectionStatus === 'active').length,
        offlineStoreCount: stores.filter((item) => item.connectionStatus === 'offline').length,
        abnormalStoreCount: stores.filter((item) => item.connectionStatus === 'abnormal').length,
        pendingSessionCount: authSessions.filter((session) => session.status === 'pending').length,
        expiredSessionCount: authSessions.filter((session) => session.status === 'expired').length,
        invalidatedSessionCount: authSessions.filter((session) => session.status === 'invalidated')
          .length,
      },
      serviceCards: [
        {
          key: 'sessions',
          title: '授权会话',
          actionLabel: '查看记录',
          description: '支持待完成、已完成、已过期、已失效四类授权状态和重新授权链路。',
        },
        {
          key: 'health',
          title: '健康检查',
          actionLabel: '执行体检',
          description: '支持单店与批量健康检查，掉线和异常状态单独区分。',
        },
        {
          key: 'batch',
          title: '批量管理',
          actionLabel: '批量操作',
          description: '支持批量启用、停用和批量体检，停用店铺会暂停调度。',
        },
      ],
    };
  }

  private getStoreAuthCallbackSigningSecret() {
    const row = this.db
      .prepare(
        `
          SELECT value_encrypted AS valueEncrypted
          FROM secure_settings
          WHERE key = 'xianyu_callback_secret'
          LIMIT 1
        `,
      )
      .get() as { valueEncrypted: string } | undefined;

    if (!row?.valueEncrypted) {
      return appConfig.secureConfigSecret;
    }

    try {
      return decryptSecret(row.valueEncrypted, appConfig.secureConfigSecret);
    } catch {
      return appConfig.secureConfigSecret;
    }
  }

  getStoreAuthSessionDetail(sessionId: string) {
    const session = this.db
      .prepare(
        `
          SELECT
            sas.session_id AS sessionId,
            sas.platform,
            sas.source,
            sas.auth_type AS authType,
            sas.status,
            sas.created_at AS createdAt,
            sas.expires_at AS expiresAt,
            sas.completed_at AS completedAt,
            sas.invalid_reason AS invalidReason,
            sas.store_id AS storeId,
            sas.owner_account_id AS ownerAccountId,
            sas.created_by_user_id AS createdByUserId,
            sas.reauthorize,
            sas.integration_mode AS integrationMode,
            sas.provider_key AS providerKey,
            sas.provider_label AS providerLabel,
            sas.provider_state AS providerState,
            sas.provider_auth_url AS providerAuthUrl,
            sas.callback_url AS callbackUrl,
            sas.provider_access_token_masked AS providerAccessTokenMasked,
            sas.provider_access_token_received_at AS providerAccessTokenReceivedAt,
            sas.next_step AS nextStep,
            sas.callback_received_at AS callbackReceivedAt,
            sas.profile_sync_status AS profileSyncStatus,
            sas.profile_sync_error AS profileSyncError,
            sas.profile_synced_at AS profileSyncedAt,
            sas.mobile,
            sas.nickname,
            spc.provider_user_id AS providerUserId,
            spc.provider_shop_id AS providerShopId,
            spc.provider_shop_name AS providerShopName,
            spc.scope_text AS scopeText
          FROM store_auth_sessions sas
          LEFT JOIN store_platform_credentials spc ON spc.session_id = sas.session_id
          WHERE sas.session_id = ?
        `,
      )
      .get(sessionId) as
      | {
          sessionId: string;
          platform: StorePlatform;
          source: string;
          authType: number;
          status: StoreAuthSessionStatus;
          createdAt: string;
          expiresAt: string | null;
          completedAt: string | null;
          invalidReason: string | null;
          storeId: number | null;
          ownerAccountId: number | null;
          createdByUserId: number | null;
          reauthorize: number;
          integrationMode: StoreAuthIntegrationMode;
          providerKey: string | null;
          providerLabel: string | null;
          providerState: string | null;
          providerAuthUrl: string | null;
          callbackUrl: string | null;
          providerAccessTokenMasked: string | null;
          providerAccessTokenReceivedAt: string | null;
          nextStep: string | null;
          callbackReceivedAt: string | null;
          profileSyncStatus: StoreProfileSyncStatus;
          profileSyncError: string | null;
          profileSyncedAt: string | null;
          mobile: string | null;
          nickname: string | null;
          providerUserId: string | null;
          providerShopId: string | null;
          providerShopName: string | null;
          scopeText: string | null;
        }
      | undefined;

    if (!session) {
      return null;
    }

    const providerPlan = resolveStoreAuthProviderPlan(appConfig, {
      platform: session.platform,
      sessionId: session.sessionId,
      reauthorize: Boolean(session.reauthorize),
      providerState: session.providerState,
      signingSecret: this.getStoreAuthCallbackSigningSecret(),
    });
    const stepInfo = this.getStoreAuthSessionStepInfo({
      status: session.status,
      integrationMode: session.integrationMode,
      nextStep: session.nextStep,
      profileSyncStatus: session.profileSyncStatus,
      profileSyncError: session.profileSyncError,
      providerAccessTokenReceivedAt: session.providerAccessTokenReceivedAt,
      invalidReason: session.invalidReason,
    });

    return {
      ...session,
      reauthorize: Boolean(session.reauthorize),
      providerConfigured: providerPlan.providerConfigured,
      authorizeUrl: session.providerAuthUrl ?? providerPlan.authorizeUrl,
      callbackPath: providerPlan.callbackPath,
      callbackUrl: session.callbackUrl ?? providerPlan.callbackUrl,
      requiresBrowserCallback: providerPlan.requiresBrowserCallback,
      instructions: providerPlan.instructions,
      tokenReceived: Boolean(session.providerAccessTokenReceivedAt),
      profileSyncStatusText: this.getStoreProfileSyncStatusText(session.profileSyncStatus),
      ...stepInfo,
    };
  }

  getStoreCredentialEvents(storeId: number, limit = 40) {
    const store = this.db
      .prepare('SELECT id, shop_name AS shopName FROM managed_stores WHERE id = ?')
      .get(storeId) as { id: number; shopName: string } | undefined;

    if (!store) {
      return null;
    }

    const rows = this.db
      .prepare(
        `
          SELECT
            sce.id,
            sce.store_id AS storeId,
            sce.session_id AS sessionId,
            sce.credential_id AS credentialId,
            sce.event_type AS eventType,
            sce.status,
            sce.detail,
            sce.source,
            sce.risk_level AS riskLevel,
            sce.verification_url AS verificationUrl,
            sce.created_at AS createdAt,
            u.display_name AS operatorName
          FROM store_credential_events sce
          LEFT JOIN users u ON u.id = sce.operator_user_id
          WHERE sce.store_id = ?
          ORDER BY sce.created_at DESC, sce.id DESC
          LIMIT ?
        `,
      )
      .all(storeId, limit) as StoreCredentialEventRecord[];

    return {
      storeId,
      shopName: store.shopName,
      events: rows.map((row) => ({
        ...row,
        eventTypeText: this.getStoreCredentialEventTypeText(row.eventType),
        statusText: this.getStoreCredentialEventStatusText(row.status),
      })),
    };
  }

  getStoreCredentialEventsBySession(sessionId: string, limit = 40) {
    const session = this.db
      .prepare(
        `
          SELECT
            sas.session_id AS sessionId,
            sas.store_id AS storeId,
            ms.shop_name AS storeName
          FROM store_auth_sessions sas
          LEFT JOIN managed_stores ms ON ms.id = sas.store_id
          WHERE sas.session_id = ?
          LIMIT 1
        `,
      )
      .get(sessionId) as { sessionId: string; storeId: number | null; storeName: string | null } | undefined;

    if (!session) {
      return null;
    }

    const rows = this.db
      .prepare(
        `
          SELECT
            sce.id,
            sce.store_id AS storeId,
            sce.session_id AS sessionId,
            sce.credential_id AS credentialId,
            sce.event_type AS eventType,
            sce.status,
            sce.detail,
            sce.source,
            sce.risk_level AS riskLevel,
            sce.verification_url AS verificationUrl,
            sce.created_at AS createdAt,
            u.display_name AS operatorName
          FROM store_credential_events sce
          LEFT JOIN users u ON u.id = sce.operator_user_id
          WHERE sce.session_id = ?
          ORDER BY sce.created_at DESC, sce.id DESC
          LIMIT ?
        `,
      )
      .all(sessionId, limit) as StoreCredentialEventRecord[];

    return {
      sessionId: session.sessionId,
      storeId: session.storeId,
      storeName: session.storeName,
      events: rows.map((row) => ({
        ...row,
        eventTypeText: this.getStoreCredentialEventTypeText(row.eventType),
        statusText: this.getStoreCredentialEventStatusText(row.status),
      })),
    };
  }

  private getManagedStoreCredentialContext(storeId: number) {
    return this.db
      .prepare(
        `
          SELECT
            ms.id AS storeId,
            ms.platform,
            ms.shop_name AS shopName,
            ms.enabled,
            ms.connection_status AS connectionStatus,
            COALESCE(spc.provider_user_id, ms.provider_user_id) AS providerUserId,
            ms.credential_id AS credentialId,
            spc.credential_type AS credentialType,
            spc.access_token_encrypted AS accessTokenEncrypted
          FROM managed_stores ms
          LEFT JOIN store_platform_credentials spc ON spc.id = ms.credential_id
          WHERE ms.id = ?
        `,
      )
      .get(storeId) as ManagedStoreCredentialContext | undefined;
  }

  getStoreAuthSessionWebSessionCredential(sessionId: string) {
    const context = this.db
      .prepare(
        `
          SELECT
            sas.session_id AS sessionId,
            sas.platform,
            sas.store_id AS storeId,
            spc.id AS credentialId,
            spc.credential_type AS credentialType,
            spc.access_token_encrypted AS accessTokenEncrypted
          FROM store_auth_sessions sas
          LEFT JOIN store_platform_credentials spc ON spc.session_id = sas.session_id
          WHERE sas.session_id = ?
          ORDER BY spc.id DESC
          LIMIT 1
        `,
      )
      .get(sessionId) as
      | {
          sessionId: string;
          platform: StorePlatform;
          storeId: number | null;
          credentialId: number | null;
          credentialType: string | null;
          accessTokenEncrypted: string | null;
        }
      | undefined;

    if (!context) {
      return null;
    }

    if (context.credentialType !== 'web_session' || !context.credentialId || !context.accessTokenEncrypted) {
      const error = new Error('当前授权会话未托管可用的网页登录态。');
      (error as Error & { statusCode?: number }).statusCode = 409;
      throw error;
    }

    return {
      ...context,
      cookieText: decryptSecret(context.accessTokenEncrypted, this.secureConfigSecret),
    };
  }

  getManagedStoreWebSessionCredential(storeId: number) {
    const context = this.getManagedStoreCredentialContext(storeId);
    if (!context) {
      return null;
    }

    if (context.credentialType !== 'web_session' || !context.credentialId || !context.accessTokenEncrypted) {
      const error = new Error('当前店铺未托管可用的网页登录态。');
      (error as Error & { statusCode?: number }).statusCode = 409;
      throw error;
    }

    return {
      ...context,
      cookieText: decryptSecret(context.accessTokenEncrypted, this.secureConfigSecret),
    };
  }

  private parseXianyuWebSocketAuthCache(payloadText: string | null) {
    if (!payloadText?.trim()) {
      return null;
    }

    try {
      const parsed = JSON.parse(
        decryptSecret(payloadText, this.secureConfigSecret),
      ) as Partial<XianyuWebSocketAuthCache>;
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        typeof parsed.appKey !== 'string' ||
        typeof parsed.cacheHeader !== 'string' ||
        typeof parsed.token !== 'string' ||
        typeof parsed.ua !== 'string' ||
        typeof parsed.dt !== 'string' ||
        typeof parsed.wv !== 'string' ||
        typeof parsed.sync !== 'string' ||
        typeof parsed.did !== 'string' ||
        typeof parsed.capturedAt !== 'string' ||
        typeof parsed.expiresAt !== 'string'
      ) {
        return null;
      }

      return {
        appKey: parsed.appKey,
        cacheHeader: parsed.cacheHeader,
        token: parsed.token,
        ua: parsed.ua,
        dt: parsed.dt,
        wv: parsed.wv,
        sync: parsed.sync,
        did: parsed.did,
        capturedAt: parsed.capturedAt,
        expiresAt: parsed.expiresAt,
      } satisfies XianyuWebSocketAuthCache;
    } catch {
      return null;
    }
  }

  listManagedStoreProductSyncTargets(storeIds?: number[]) {
    const clauses = [
      "ms.platform = 'xianyu'",
      'ms.enabled = 1',
      "spc.credential_type = 'web_session'",
      'spc.access_token_encrypted IS NOT NULL',
      "TRIM(COALESCE(spc.provider_user_id, ms.provider_user_id, '')) <> ''",
    ];
    const params: Record<string, string | number> = {};

    if (storeIds && storeIds.length > 0) {
      const placeholders = storeIds.map((value, index) => {
        const key = `storeId${index}`;
        params[key] = value;
        return `@${key}`;
      });
      clauses.push(`ms.id IN (${placeholders.join(', ')})`);
    }

    const rows = this.db
      .prepare(
        `
          SELECT
            ms.id AS storeId,
            ms.shop_name AS shopName,
            ms.provider_user_id AS managedProviderUserId,
            oa.owner_name AS ownerName,
            spc.provider_user_id AS credentialProviderUserId,
            spc.access_token_encrypted AS accessTokenEncrypted
          FROM managed_stores ms
          INNER JOIN store_platform_credentials spc ON spc.id = ms.credential_id
          LEFT JOIN store_owner_accounts oa ON oa.id = ms.owner_account_id
          WHERE ${clauses.join(' AND ')}
          ORDER BY ms.id ASC
        `,
      )
      .all(params) as Array<{
      storeId: number;
      shopName: string;
      managedProviderUserId: string | null;
      ownerName: string | null;
      credentialProviderUserId: string | null;
      accessTokenEncrypted: string;
    }>;

    return rows.map((row) => ({
      storeId: row.storeId,
      shopName: row.shopName,
      ownerName: row.ownerName?.trim() || row.shopName,
      providerUserId:
        row.credentialProviderUserId?.trim() || row.managedProviderUserId?.trim() || '',
      cookieText: decryptSecret(row.accessTokenEncrypted, this.secureConfigSecret),
    }));
  }

  listManagedStoreOrderSyncTargets(storeIds?: number[]) {
    return this.listManagedStoreProductSyncTargets(storeIds);
  }

  listManagedStoreAiBargainSyncTargets(storeIds?: number[]) {
    const clauses = [
      "ms.platform = 'xianyu'",
      'ms.enabled = 1',
      "spc.credential_type = 'web_session'",
      'spc.access_token_encrypted IS NOT NULL',
      "TRIM(COALESCE(spc.provider_user_id, ms.provider_user_id, '')) <> ''",
    ];
    const params: Record<string, string | number> = {};

    if (storeIds && storeIds.length > 0) {
      const placeholders = storeIds.map((value, index) => {
        const key = `storeId${index}`;
        params[key] = value;
        return `@${key}`;
      });
      clauses.push(`ms.id IN (${placeholders.join(', ')})`);
    }

    const rows = this.db
      .prepare(
        `
          SELECT
            ms.id AS storeId,
            ms.shop_name AS shopName,
            ms.provider_user_id AS managedProviderUserId,
            oa.owner_name AS ownerName,
            spc.provider_user_id AS credentialProviderUserId,
            spc.access_token_encrypted AS accessTokenEncrypted,
            xisc.auth_snapshot_encrypted AS authSnapshotEncrypted
          FROM managed_stores ms
          INNER JOIN store_platform_credentials spc ON spc.id = ms.credential_id
          LEFT JOIN store_owner_accounts oa ON oa.id = ms.owner_account_id
          LEFT JOIN xianyu_im_session_auth_cache xisc ON xisc.store_id = ms.id
          WHERE ${clauses.join(' AND ')}
          ORDER BY ms.id ASC
        `,
      )
      .all(params) as Array<{
      storeId: number;
      shopName: string;
      managedProviderUserId: string | null;
      ownerName: string | null;
      credentialProviderUserId: string | null;
      accessTokenEncrypted: string;
      authSnapshotEncrypted: string | null;
    }>;

    return rows.map((row) => ({
      storeId: row.storeId,
      shopName: row.shopName,
      ownerName: row.ownerName?.trim() || row.shopName,
      providerUserId:
        row.credentialProviderUserId?.trim() || row.managedProviderUserId?.trim() || '',
      cookieText: decryptSecret(row.accessTokenEncrypted, this.secureConfigSecret),
      cachedSocketAuth: this.parseXianyuWebSocketAuthCache(row.authSnapshotEncrypted),
    }));
  }

  getManagedStoreXianyuImSyncTarget(storeId: number) {
    return this.listManagedStoreAiBargainSyncTargets([storeId])[0] ?? null;
  }
}
