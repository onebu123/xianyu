import { createHash, randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';
import { format } from 'date-fns';

import { encryptSecret, decryptSecret, maskSecret } from './auth.js';
import { appConfig } from './config.js';
import {
  parseStoreAuthSessionIdFromState,
  resolveStoreAuthProviderPlan,
  validateStoreAuthProviderState,
} from './store-auth-providers.js';
import type { StoreAuthIntegrationMode } from './types.js';

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

interface StoreAuthSessionStepInfo {
  nextStepKey: StoreAuthSessionNextStep;
  nextStepText: string;
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

export class StoreAccessWriteRepository {
  constructor(
    private readonly getDbConnection: () => Database.Database,
    private readonly secureConfigSecret: string,
  ) {}

  private get db() {
    return this.getDbConnection();
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

  private isLegacyStoreAuthProviderState(state: string, expectedSessionId: string) {
    const segments = state.split('.');
    return segments.length === 2 && parseStoreAuthSessionIdFromState(state) === expectedSessionId;
  }

  private redactStoreAuthPayloadText(rawText: string | null | undefined) {
    const trimmed = rawText?.trim() ?? '';
    if (!trimmed) {
      return null;
    }

    return {
      rawLength: trimmed.length,
      rawSha256: createHash('sha256').update(trimmed).digest('hex').slice(0, 24),
    };
  }

  private buildStoreAuthPayloadSummary(input: {
    payloadType: 'provider_callback' | 'web_session_capture';
    capturedAt: string;
    maskedValue?: string | null;
    rawText?: string | null;
    tokenType?: string | null;
    expiresAt?: string | null;
    credentialSource?: string | null;
    riskLevel?: StoreCredentialRiskLevel | null;
    verificationUrl?: string | null;
    note?: string | null;
  }) {
    const summary: Record<string, string | number> = {
      payloadType: input.payloadType,
      capturedAt: input.capturedAt,
    };

    if (input.maskedValue?.trim()) {
      summary.maskedValue = input.maskedValue.trim();
    }
    if (input.tokenType?.trim()) {
      summary.tokenType = input.tokenType.trim();
    }
    if (input.expiresAt?.trim()) {
      summary.expiresAt = input.expiresAt.trim();
    }
    if (input.credentialSource?.trim()) {
      summary.credentialSource = input.credentialSource.trim();
    }
    if (input.riskLevel?.trim()) {
      summary.riskLevel = input.riskLevel.trim();
    }
    if (input.verificationUrl?.trim()) {
      summary.verificationUrl = input.verificationUrl.trim();
    }
    if (input.note?.trim()) {
      summary.note = input.note.trim();
    }

    const redactedPayload = this.redactStoreAuthPayloadText(input.rawText);
    if (redactedPayload) {
      summary.rawLength = redactedPayload.rawLength;
      summary.rawSha256 = redactedPayload.rawSha256;
    }

    return JSON.stringify(summary, null, 2);
  }

  private deleteScopedStoreCredential(input: {
    sessionId: string;
    platform: StorePlatform;
    providerKey: string;
    credentialType: 'access_token' | 'web_session';
    storeId: number | null;
    ownerAccountId: number | null;
    keepCredentialId?: number | null;
  }) {
    if (input.keepCredentialId !== null && input.keepCredentialId !== undefined) {
      this.db
        .prepare(
          `
            DELETE FROM store_platform_credentials
            WHERE platform = @platform
              AND provider_key = @providerKey
              AND credential_type = @credentialType
              AND session_id = @sessionId
              AND id <> @keepCredentialId
          `,
        )
        .run({
          sessionId: input.sessionId,
          platform: input.platform,
          providerKey: input.providerKey,
          credentialType: input.credentialType,
          keepCredentialId: input.keepCredentialId,
        });
    } else {
      this.db
        .prepare(
          `
            DELETE FROM store_platform_credentials
            WHERE platform = @platform
              AND provider_key = @providerKey
              AND credential_type = @credentialType
              AND session_id = @sessionId
          `,
        )
        .run({
          sessionId: input.sessionId,
          platform: input.platform,
          providerKey: input.providerKey,
          credentialType: input.credentialType,
        });
    }

    if (input.storeId !== null) {
      this.db
        .prepare(
          `
            DELETE FROM store_platform_credentials
            WHERE platform = @platform
              AND provider_key = @providerKey
              AND credential_type = @credentialType
              AND store_id = @storeId
              AND (session_id IS NULL OR session_id <> @sessionId)
              AND (@keepCredentialId IS NULL OR id <> @keepCredentialId)
          `,
        )
        .run({
          sessionId: input.sessionId,
          platform: input.platform,
          providerKey: input.providerKey,
          credentialType: input.credentialType,
          storeId: input.storeId,
          keepCredentialId: input.keepCredentialId ?? null,
        });
      return;
    }

    if (input.ownerAccountId !== null) {
      this.db
        .prepare(
          `
            DELETE FROM store_platform_credentials
            WHERE platform = @platform
              AND provider_key = @providerKey
              AND credential_type = @credentialType
              AND store_id IS NULL
              AND owner_account_id = @ownerAccountId
              AND (session_id IS NULL OR session_id <> @sessionId)
              AND (@keepCredentialId IS NULL OR id <> @keepCredentialId)
          `,
        )
        .run({
          sessionId: input.sessionId,
          platform: input.platform,
          providerKey: input.providerKey,
          credentialType: input.credentialType,
          ownerAccountId: input.ownerAccountId,
          keepCredentialId: input.keepCredentialId ?? null,
        });
    }
  }

  private normalizeStoreAuthSessionNextStep(nextStep?: string | null): StoreAuthSessionNextStep | null {
    switch (nextStep?.trim()) {
      case 'manual_complete':
      case 'wait_provider_callback':
      case 'sync_profile':
      case 'done':
      case 'expired':
      case 'invalidated':
        return nextStep.trim() as StoreAuthSessionNextStep;
      default:
        return null;
    }
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

  private getStoreCredentialBySessionId(sessionId: string) {
    return this.db
      .prepare(
        `
          SELECT
            id,
            platform,
            store_id AS storeId,
            owner_account_id AS ownerAccountId,
            provider_key AS providerKey,
            credential_type AS credentialType,
            access_token_masked AS accessTokenMasked,
            expires_at AS expiresAt,
            provider_user_id AS providerUserId,
            provider_shop_id AS providerShopId,
            provider_shop_name AS providerShopName,
            scope_text AS scopeText
          FROM store_platform_credentials
          WHERE session_id = ?
          ORDER BY id DESC
          LIMIT 1
        `,
      )
      .get(sessionId) as
      | {
          id: number;
          platform: StorePlatform;
          storeId: number | null;
          ownerAccountId: number | null;
          providerKey: string;
          credentialType: string;
          accessTokenMasked: string | null;
          expiresAt: string | null;
          providerUserId: string | null;
          providerShopId: string | null;
          providerShopName: string | null;
          scopeText: string | null;
        }
      | undefined;
  }

  private recordStoreCredentialEvent(input: {
    storeId?: number | null;
    sessionId?: string | null;
    credentialId?: number | null;
    eventType: StoreCredentialEventType;
    status: StoreCredentialEventStatus;
    detail: string;
    source?: string | null;
    riskLevel?: StoreCredentialRiskLevel | null;
    verificationUrl?: string | null;
    operatorUserId?: number | null;
  }) {
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    this.db
      .prepare(
        `
          INSERT INTO store_credential_events (
            store_id,
            session_id,
            credential_id,
            event_type,
            status,
            detail,
            source,
            risk_level,
            verification_url,
            operator_user_id,
            created_at
          ) VALUES (
            @storeId,
            @sessionId,
            @credentialId,
            @eventType,
            @status,
            @detail,
            @source,
            @riskLevel,
            @verificationUrl,
            @operatorUserId,
            @createdAt
          )
        `,
      )
      .run({
        storeId: input.storeId ?? null,
        sessionId: input.sessionId ?? null,
        credentialId: input.credentialId ?? null,
        eventType: input.eventType,
        status: input.status,
        detail: input.detail.trim(),
        source: input.source?.trim() || null,
        riskLevel: input.riskLevel ?? null,
        verificationUrl: input.verificationUrl?.trim() || null,
        operatorUserId: input.operatorUserId ?? null,
        createdAt: now,
      });

    return {
      eventType: input.eventType,
      status: input.status,
      detail: input.detail.trim(),
      createdAt: now,
    };
  }

  private clearManagedStoreXianyuImAuthCache(storeId: number) {
    this.db.prepare('DELETE FROM xianyu_im_session_auth_cache WHERE store_id = ?').run(storeId);
  }

  private normalizeStoreTags(tags: string[] | string | null | undefined) {
    const raw = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(',') : [];
    return Array.from(new Set(raw.map((item) => item.trim()).filter(Boolean))).join(',');
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

  private upsertStoreOwnerAccount(input: {
    accountId?: number | null;
    platform: StorePlatform;
    ownerName: string;
    mobile: string;
    loginMode: 'sms' | 'password' | 'oauth' | 'cookie';
    authorizedByUserId: number | null;
  }) {
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const existingById = input.accountId
      ? (this.db
          .prepare('SELECT id FROM store_owner_accounts WHERE id = ?')
          .get(input.accountId) as { id: number } | undefined)
      : undefined;
    const existingByMobile = !existingById
      ? (this.db
          .prepare(
            `
              SELECT id
              FROM store_owner_accounts
              WHERE platform = ? AND mobile = ?
              ORDER BY id DESC
              LIMIT 1
            `,
          )
          .get(input.platform, input.mobile) as { id: number } | undefined)
      : undefined;

    const accountId = existingById?.id ?? existingByMobile?.id;
    if (accountId) {
      this.db
        .prepare(
          `
            UPDATE store_owner_accounts
            SET
              owner_name = @ownerName,
              mobile = @mobile,
              login_mode = @loginMode,
              account_status = 'active',
              last_authorized_at = @lastAuthorizedAt,
              last_authorized_by = @lastAuthorizedBy,
              updated_at = @updatedAt
            WHERE id = @id
          `,
        )
        .run({
          id: accountId,
          ownerName: input.ownerName,
          mobile: input.mobile,
          loginMode: input.loginMode,
          lastAuthorizedAt: now,
          lastAuthorizedBy: input.authorizedByUserId,
          updatedAt: now,
        });

      return accountId;
    }

    const result = this.db
      .prepare(
        `
          INSERT INTO store_owner_accounts (
            platform,
            owner_name,
            mobile,
            login_mode,
            account_status,
            last_authorized_at,
            last_authorized_by,
            created_at,
            updated_at
          ) VALUES (
            @platform,
            @ownerName,
            @mobile,
            @loginMode,
            'active',
            @lastAuthorizedAt,
            @lastAuthorizedBy,
            @createdAt,
            @updatedAt
          )
        `,
      )
      .run({
        platform: input.platform,
        ownerName: input.ownerName,
        mobile: input.mobile,
        loginMode: input.loginMode,
        lastAuthorizedAt: now,
        lastAuthorizedBy: input.authorizedByUserId,
        createdAt: now,
        updatedAt: now,
      });

    return Number(result.lastInsertRowid);
  }

  private bindStoreCredentialEventsToStore(
    sessionId: string,
    input: { storeId: number; credentialId?: number | null },
  ) {
    this.db
      .prepare(
        `
          UPDATE store_credential_events
          SET
            store_id = @storeId,
            credential_id = COALESCE(credential_id, @credentialId)
          WHERE session_id = @sessionId
        `,
      )
      .run({
        sessionId,
        storeId: input.storeId,
        credentialId: input.credentialId ?? null,
      });
  }

  private findManagedStoreByProviderShopId(platform: StorePlatform, providerShopId: string) {
    return this.db
      .prepare(
        `
          SELECT
            id,
            seller_no AS sellerNo,
            connection_status AS connectionStatus,
            enabled
          FROM managed_stores
          WHERE platform = ? AND provider_store_id = ?
          LIMIT 1
        `,
      )
      .get(platform, providerShopId) as
      | {
          id: number;
          sellerNo: string;
          connectionStatus: StoreConnectionStatus;
          enabled: number;
        }
      | undefined;
  }

  private buildSellerNo(platform: StorePlatform) {
    const prefix = platform === 'xianyu' ? 'xy' : 'tb';
    const latest = this.db
      .prepare(
        `
          SELECT seller_no AS sellerNo
          FROM managed_stores
          WHERE platform = ?
          ORDER BY id DESC
          LIMIT 1
        `,
      )
      .get(platform) as { sellerNo: string } | undefined;

    const baseNumber = latest
      ? Number(latest.sellerNo.replace(/\D/g, '').slice(-12))
      : platform === 'xianyu'
        ? 560104526732
        : 839104223301;

    return `${prefix}${String(baseNumber + 108244).padStart(12, '0')}`;
  }

  private getStoreAuthPermissions(platform: StorePlatform) {
    if (platform === 'xianyu') {
      return [
        '获取您的登录及用户信息',
        '读取或更新您店铺的商品数据',
        '读取商品所参与活动的限制规则信息',
      ];
    }

    return ['获取您的登录及用户信息', '读取淘宝店铺商品数据', '读取卖家所需的订单与库存信息'];
  }

  createStoreAuthSession(input: {
    platform: StorePlatform;
    source: string;
    authType: number;
    storeId?: number | null;
    createdByUserId?: number | null;
    seed?: {
      sessionId: string;
      createdAt: string;
      expiresAt: string;
      providerState?: string | null;
    };
  }) {
    let targetStore:
      | {
          id: number;
          platform: StorePlatform;
          shopName: string;
          ownerAccountId: number | null;
        }
      | undefined;

    if (input.storeId) {
      targetStore = this.db
        .prepare(
          `
            SELECT
              id,
              platform,
              shop_name AS shopName,
              owner_account_id AS ownerAccountId
            FROM managed_stores
            WHERE id = ?
          `,
        )
        .get(input.storeId) as
        | {
            id: number;
            platform: StorePlatform;
            shopName: string;
            ownerAccountId: number | null;
          }
        | undefined;

      if (!targetStore) {
        throw new Error('目标店铺不存在。');
      }

      if (targetStore.platform !== input.platform) {
        throw new Error('重新授权的平台与店铺平台不一致。');
      }

      this.db
        .prepare(
          `
            UPDATE store_auth_sessions
            SET
              status = 'invalidated',
              invalid_reason = '已发起新的重新授权会话'
            WHERE store_id = @storeId
              AND status = 'pending'
          `,
        )
        .run({ storeId: input.storeId });
    }

    const sessionId = input.seed?.sessionId ?? randomUUID();
    const createdAt =
      input.seed?.createdAt ?? format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const expiresAt =
      input.seed?.expiresAt ??
      format(new Date(Date.now() + 15 * 60 * 1000), 'yyyy-MM-dd HH:mm:ss');
    const signingSecret = this.getStoreAuthCallbackSigningSecret();
    const providerPlan = resolveStoreAuthProviderPlan(appConfig, {
      platform: input.platform,
      sessionId,
      reauthorize: Boolean(input.storeId),
      signingSecret,
      providerState: input.seed?.providerState ?? null,
    });

    this.db
      .prepare(
        `
          INSERT INTO store_auth_sessions (
            session_id,
            platform,
            source,
            auth_type,
            status,
            created_at,
            expires_at,
            store_id,
            owner_account_id,
            created_by_user_id,
            reauthorize,
            integration_mode,
            provider_key,
            provider_label,
            provider_state,
            provider_auth_url,
            callback_url,
            next_step,
            profile_sync_status
          ) VALUES (
            @sessionId,
            @platform,
            @source,
            @authType,
            'pending',
            @createdAt,
            @expiresAt,
            @storeId,
            @ownerAccountId,
            @createdByUserId,
            @reauthorize,
            @integrationMode,
            @providerKey,
            @providerLabel,
            @providerState,
            @providerAuthUrl,
            @callbackUrl,
            @nextStep,
            'pending'
          )
        `,
      )
      .run({
        sessionId,
        platform: input.platform,
        source: input.source,
        authType: input.authType,
        createdAt,
        expiresAt,
        storeId: input.storeId ?? null,
        ownerAccountId: targetStore?.ownerAccountId ?? null,
        createdByUserId: input.createdByUserId ?? null,
        reauthorize: input.storeId ? 1 : 0,
        integrationMode: providerPlan.integrationMode,
        providerKey: providerPlan.providerKey,
        providerLabel: providerPlan.providerLabel,
        providerState: providerPlan.providerState,
        providerAuthUrl: providerPlan.authorizeUrl,
        callbackUrl: providerPlan.callbackUrl,
        nextStep:
          providerPlan.integrationMode === 'xianyu_browser_oauth'
            ? 'wait_provider_callback'
            : 'manual_complete',
      });

    return {
      sessionId,
      platform: input.platform,
      source: input.source,
      authType: input.authType,
      createdAt,
      expiresAt,
      reauthorize: Boolean(input.storeId),
      storeId: input.storeId ?? null,
      storeName: targetStore?.shopName ?? null,
      integrationMode: providerPlan.integrationMode,
      providerKey: providerPlan.providerKey,
      providerLabel: providerPlan.providerLabel,
      providerConfigured: providerPlan.providerConfigured,
      authorizeUrl: providerPlan.authorizeUrl,
      callbackPath: providerPlan.callbackPath,
      callbackUrl: providerPlan.callbackUrl,
      requiresBrowserCallback: providerPlan.requiresBrowserCallback,
      instructions: providerPlan.instructions,
      permissions: this.getStoreAuthPermissions(input.platform),
    };
  }

  refreshStoreAuthSessionWindow(
    sessionId: string,
    input?: {
      minutes?: number;
      reviveExpiredWebSession?: boolean;
    },
  ) {
    const session = this.db
      .prepare(
        `
          SELECT
            session_id AS sessionId,
            status,
            integration_mode AS integrationMode,
            provider_access_token_received_at AS providerAccessTokenReceivedAt
          FROM store_auth_sessions
          WHERE session_id = ?
        `,
      )
      .get(sessionId) as
      | {
          sessionId: string;
          status: StoreAuthSessionStatus;
          integrationMode: StoreAuthIntegrationMode;
          providerAccessTokenReceivedAt: string | null;
        }
      | undefined;

    if (!session) {
      return null;
    }

    const minutes = Math.max(1, Math.trunc(input?.minutes ?? 15));
    const revived =
      Boolean(input?.reviveExpiredWebSession) &&
      session.status === 'expired' &&
      session.integrationMode === 'xianyu_web_session';

    if (session.status === 'invalidated' || session.status === 'completed') {
      return {
        sessionId: session.sessionId,
        refreshed: false,
        revived: false,
        status: session.status,
        expiresAt: null,
      };
    }

    if (session.status === 'expired' && !revived) {
      return {
        sessionId: session.sessionId,
        refreshed: false,
        revived: false,
        status: session.status,
        expiresAt: null,
      };
    }

    const expiresAt = format(new Date(Date.now() + minutes * 60 * 1000), 'yyyy-MM-dd HH:mm:ss');
    const nextStatus: StoreAuthSessionStatus = revived ? 'pending' : session.status;
    const nextStep =
      session.integrationMode === 'xianyu_web_session'
        ? session.providerAccessTokenReceivedAt
          ? 'sync_profile'
          : 'manual_complete'
        : null;

    this.db
      .prepare(
        `
          UPDATE store_auth_sessions
          SET
            expires_at = @expiresAt,
            status = @status,
            invalid_reason = CASE WHEN @revived = 1 THEN NULL ELSE invalid_reason END,
            next_step = CASE
              WHEN @revived = 1 AND integration_mode = 'xianyu_web_session' THEN @nextStep
              ELSE next_step
            END
          WHERE session_id = @sessionId
        `,
      )
      .run({
        sessionId: session.sessionId,
        expiresAt,
        status: nextStatus,
        revived: revived ? 1 : 0,
        nextStep,
      });

    return {
      sessionId: session.sessionId,
      refreshed: true,
      revived,
      status: nextStatus,
      expiresAt,
    };
  }

  receiveStoreAuthProviderCallback(input: {
    sessionId: string;
    accessToken: string;
    tokenType?: string | null;
    expiresInSeconds?: number | null;
    state: string;
    rawCallback?: string | null;
  }) {
    const session = this.db
      .prepare(
        `
          SELECT
            session_id AS sessionId,
            platform,
            status,
            store_id AS storeId,
            owner_account_id AS ownerAccountId,
            integration_mode AS integrationMode,
            provider_key AS providerKey,
            provider_state AS providerState
          FROM store_auth_sessions
          WHERE session_id = ?
        `,
      )
      .get(input.sessionId) as
      | {
          sessionId: string;
          platform: StorePlatform;
          status: StoreAuthSessionStatus;
          storeId: number | null;
          ownerAccountId: number | null;
          integrationMode: StoreAuthIntegrationMode;
          providerKey: string | null;
          providerState: string | null;
        }
      | undefined;

    if (!session) {
      return {
        accepted: false,
        statusCode: 404,
        message: '授权会话不存在。',
      };
    }

    if (session.status !== 'pending') {
      return {
        accepted: false,
        statusCode: 409,
        message: '授权会话已结束，不能重复接收回调。',
      };
    }

    if (session.integrationMode !== 'xianyu_browser_oauth') {
      return {
        accepted: false,
        statusCode: 409,
        message: '当前授权会话不是闲鱼真实授权模式。',
      };
    }

    if (!session.providerState || session.providerState !== input.state) {
      return {
        accepted: false,
        statusCode: 400,
        message: '授权回调 state 校验失败。',
      };
    }

    if (parseStoreAuthSessionIdFromState(input.state) !== input.sessionId) {
      return {
        accepted: false,
        statusCode: 400,
        message: '授权回调 session 标识不匹配。',
      };
    }

    const signingSecret = this.getStoreAuthCallbackSigningSecret();
    const stateValid =
      validateStoreAuthProviderState(input.state, signingSecret, input.sessionId) ||
      this.isLegacyStoreAuthProviderState(input.state, input.sessionId);
    if (!stateValid) {
      return {
        accepted: false,
        statusCode: 400,
        message: '授权回调签名校验失败。',
      };
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const expiresAt =
      typeof input.expiresInSeconds === 'number' && input.expiresInSeconds > 0
        ? format(new Date(Date.now() + input.expiresInSeconds * 1000), 'yyyy-MM-dd HH:mm:ss')
        : null;
    const providerKey = session.providerKey ?? 'xianyu-browser-oauth';
    const accessTokenMasked = maskSecret(input.accessToken);

    this.deleteScopedStoreCredential({
      sessionId: session.sessionId,
      platform: session.platform,
      providerKey,
      credentialType: 'access_token',
      storeId: session.storeId,
      ownerAccountId: session.ownerAccountId,
    });

    this.db
      .prepare(
        `
          INSERT INTO store_platform_credentials (
            session_id,
            platform,
            store_id,
            owner_account_id,
            provider_key,
            credential_type,
            access_token_encrypted,
            access_token_masked,
            expires_at,
            last_sync_status,
            created_at,
            updated_at
          ) VALUES (
            @sessionId,
            @platform,
            @storeId,
            @ownerAccountId,
            @providerKey,
            'access_token',
            @accessTokenEncrypted,
            @accessTokenMasked,
            @expiresAt,
            'pending_profile_sync',
            @createdAt,
            @updatedAt
          )
        `,
      )
      .run({
        sessionId: session.sessionId,
        platform: session.platform,
        storeId: session.storeId,
        ownerAccountId: session.ownerAccountId,
        providerKey,
        accessTokenEncrypted: encryptSecret(input.accessToken, this.secureConfigSecret),
        accessTokenMasked,
        expiresAt,
        createdAt: now,
        updatedAt: now,
      });

    this.db
      .prepare(
        `
          UPDATE store_auth_sessions
          SET
            provider_access_token_masked = @providerAccessTokenMasked,
            provider_access_token_received_at = @providerAccessTokenReceivedAt,
            provider_payload_text = @providerPayloadText,
            invalid_reason = NULL,
            next_step = 'sync_profile',
            callback_received_at = @providerAccessTokenReceivedAt,
            profile_sync_status = 'pending',
            profile_sync_error = NULL,
            provider_error_code = NULL,
            provider_error_message = NULL
          WHERE session_id = @sessionId
        `,
      )
      .run({
        sessionId: session.sessionId,
        providerAccessTokenMasked: accessTokenMasked,
        providerAccessTokenReceivedAt: now,
        providerPayloadText: this.buildStoreAuthPayloadSummary({
          payloadType: 'provider_callback',
          capturedAt: now,
          maskedValue: accessTokenMasked,
          rawText: input.rawCallback,
          tokenType: input.tokenType ?? null,
          expiresAt,
        }),
      });

    return {
      accepted: true,
      statusCode: 200,
      sessionId: session.sessionId,
      integrationMode: session.integrationMode,
      providerKey,
      accessTokenMasked,
      accessTokenReceivedAt: now,
      nextStep: 'sync_profile' as const,
      nextStepText: '已接收官方回调，待换取店铺资料并完成绑店。',
      message: '已接收闲鱼授权回调，access token 已安全保存，等待后续资料换取与绑店。',
    };
  }

  receiveStoreAuthSessionWebCredential(
    sessionId: string,
    input: {
      cookieText: string;
      source?: 'manual' | 'qr_login' | 'browser_qr_login' | 'browser_renew';
      rawPayloadText?: string | null;
      riskLevel?: StoreCredentialRiskLevel;
      riskReason?: string | null;
      verificationUrl?: string | null;
    },
  ) {
    const session = this.db
      .prepare(
        `
          SELECT
            session_id AS sessionId,
            platform,
            status,
            store_id AS storeId,
            owner_account_id AS ownerAccountId,
            integration_mode AS integrationMode,
            provider_key AS providerKey
          FROM store_auth_sessions
          WHERE session_id = ?
        `,
      )
      .get(sessionId) as
      | {
          sessionId: string;
          platform: StorePlatform;
          status: StoreAuthSessionStatus;
          storeId: number | null;
          ownerAccountId: number | null;
          integrationMode: StoreAuthIntegrationMode;
          providerKey: string | null;
        }
      | undefined;

    if (!session) {
      return null;
    }

    if (session.status === 'invalidated' || session.status === 'completed') {
      const error = new Error('授权会话已失效，请重新发起接入。');
      (error as Error & { statusCode?: number }).statusCode = 409;
      throw error;
    }

    if (session.integrationMode !== 'xianyu_web_session') {
      const error = new Error('当前授权会话不是闲鱼网页登录态接入模式。');
      (error as Error & { statusCode?: number }).statusCode = 409;
      throw error;
    }

    const cookieText = input.cookieText.trim();
    if (cookieText.length < 10) {
      const error = new Error('请输入完整的网页登录态或 Cookie 串。');
      (error as Error & { statusCode?: number }).statusCode = 400;
      throw error;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const authExpiresAt = format(new Date(Date.now() + 15 * 60 * 1000), 'yyyy-MM-dd HH:mm:ss');
    const providerKey = session.providerKey ?? 'xianyu-web-session';
    const credentialSource = input.source ?? 'manual';
    const cookieMasked = maskSecret(cookieText);
    const effectiveStatus: StoreAuthSessionStatus = session.status === 'expired' ? 'pending' : session.status;
    const existingCredential = this.getStoreCredentialBySessionId(session.sessionId);
    const reuseCredentialId =
      existingCredential?.credentialType === 'web_session' && existingCredential.providerKey === providerKey
        ? existingCredential.id
        : null;

    this.deleteScopedStoreCredential({
      sessionId: session.sessionId,
      platform: session.platform,
      providerKey,
      credentialType: 'web_session',
      storeId: session.storeId,
      ownerAccountId: session.ownerAccountId,
      keepCredentialId: reuseCredentialId,
    });

    const encryptedCookieText = encryptSecret(cookieText, this.secureConfigSecret);
    const credentialId =
      reuseCredentialId !== null
        ? reuseCredentialId
        : Number(
            this.db
              .prepare(
                `
                  INSERT INTO store_platform_credentials (
                    session_id,
                    platform,
                    store_id,
                    owner_account_id,
                    provider_key,
                    credential_type,
                    access_token_encrypted,
                    access_token_masked,
                    expires_at,
                    last_sync_status,
                    credential_source,
                    risk_level,
                    risk_reason,
                    verification_url,
                    created_at,
                    updated_at
                  ) VALUES (
                    @sessionId,
                    @platform,
                    @storeId,
                    @ownerAccountId,
                    @providerKey,
                    'web_session',
                    @accessTokenEncrypted,
                    @accessTokenMasked,
                    NULL,
                    'pending_profile_sync',
                    @credentialSource,
                    @riskLevel,
                    @riskReason,
                    @verificationUrl,
                    @createdAt,
                    @updatedAt
                  )
                `,
              )
              .run({
                sessionId: session.sessionId,
                platform: session.platform,
                storeId: session.storeId,
                ownerAccountId: session.ownerAccountId,
                providerKey,
                accessTokenEncrypted: encryptedCookieText,
                accessTokenMasked: cookieMasked,
                credentialSource,
                riskLevel: input.riskLevel ?? 'pending',
                riskReason: input.riskReason?.trim() ?? '',
                verificationUrl: input.verificationUrl?.trim() || null,
                createdAt: now,
                updatedAt: now,
              }).lastInsertRowid,
          );

    if (reuseCredentialId !== null) {
      this.db
        .prepare(
          `
            UPDATE store_platform_credentials
            SET
              store_id = @storeId,
              owner_account_id = @ownerAccountId,
              access_token_encrypted = @accessTokenEncrypted,
              access_token_masked = @accessTokenMasked,
              expires_at = NULL,
              last_sync_status = 'pending_profile_sync',
              credential_source = @credentialSource,
              risk_level = @riskLevel,
              risk_reason = @riskReason,
              verification_url = @verificationUrl,
              updated_at = @updatedAt
            WHERE id = @id
          `,
        )
        .run({
          id: reuseCredentialId,
          storeId: session.storeId,
          ownerAccountId: session.ownerAccountId,
          accessTokenEncrypted: encryptedCookieText,
          accessTokenMasked: cookieMasked,
          credentialSource,
          riskLevel: input.riskLevel ?? 'pending',
          riskReason: input.riskReason?.trim() ?? '',
          verificationUrl: input.verificationUrl?.trim() || null,
          updatedAt: now,
        });
    }

    if (session.storeId) {
      this.clearManagedStoreXianyuImAuthCache(session.storeId);
    }

    this.db
      .prepare(
        `
          UPDATE store_auth_sessions
          SET
            status = @status,
            expires_at = @expiresAt,
            provider_access_token_masked = @providerAccessTokenMasked,
            provider_access_token_received_at = @providerAccessTokenReceivedAt,
            provider_payload_text = @providerPayloadText,
            invalid_reason = NULL,
            next_step = 'sync_profile',
            callback_received_at = @providerAccessTokenReceivedAt,
            profile_sync_status = 'pending',
            profile_sync_error = NULL,
            provider_error_code = NULL,
            provider_error_message = NULL
          WHERE session_id = @sessionId
        `,
      )
      .run({
        sessionId: session.sessionId,
        status: effectiveStatus,
        expiresAt: authExpiresAt,
        providerAccessTokenMasked: cookieMasked,
        providerAccessTokenReceivedAt: now,
        providerPayloadText: this.buildStoreAuthPayloadSummary({
          payloadType: 'web_session_capture',
          capturedAt: now,
          maskedValue: cookieMasked,
          rawText: input.rawPayloadText ?? null,
          credentialSource,
          riskLevel: input.riskLevel ?? 'pending',
          verificationUrl: input.verificationUrl ?? null,
        }),
      });

    const stepInfo = this.getStoreAuthSessionStepInfo({
      status: effectiveStatus,
      integrationMode: session.integrationMode,
      nextStep: 'sync_profile',
      providerAccessTokenReceivedAt: now,
    });

    this.recordStoreCredentialEvent({
      storeId: session.storeId,
      sessionId: session.sessionId,
      credentialId,
      eventType: 'credential_captured',
      status:
        input.riskLevel === 'warning' || input.riskLevel === 'offline' || input.riskLevel === 'abnormal'
          ? 'warning'
          : 'success',
      detail:
        credentialSource === 'qr_login'
          ? '已接收扫码登录态并写入凭据仓。'
          : credentialSource === 'browser_qr_login'
            ? '已通过浏览器扫码接收网页登录态，并写入凭据仓。'
            : credentialSource === 'browser_renew'
              ? '已写入浏览器续登后的最新登录态。'
              : '已录入网页登录态并写入凭据仓。',
      source: credentialSource,
      riskLevel: input.riskLevel ?? 'pending',
      verificationUrl: input.verificationUrl ?? null,
    });
    if (
      input.verificationUrl?.trim() ||
      input.riskLevel === 'warning' ||
      input.riskLevel === 'offline' ||
      input.riskLevel === 'abnormal'
    ) {
      this.recordStoreCredentialEvent({
        storeId: session.storeId,
        sessionId: session.sessionId,
        credentialId,
        eventType: 'manual_takeover_required',
        status: 'warning',
        detail: input.riskReason?.trim() || '登录态已入库，但仍需人工处理风控或验证码。',
        source: credentialSource,
        riskLevel: input.riskLevel ?? 'warning',
        verificationUrl: input.verificationUrl ?? null,
      });
    }

    return {
      accepted: true,
      sessionId: session.sessionId,
      integrationMode: session.integrationMode,
      providerKey,
      accessTokenMasked: cookieMasked,
      accessTokenReceivedAt: now,
      nextStep: stepInfo.nextStepKey,
      nextStepText: stepInfo.nextStepText,
      source: credentialSource,
      message:
        credentialSource === 'qr_login'
          ? '已接收扫码登录态，等待补齐卖家与店铺资料。'
          : credentialSource === 'browser_qr_login'
            ? '已通过浏览器扫码接收网页登录态，等待补齐卖家与店铺资料。'
            : credentialSource === 'browser_renew'
              ? '已更新网页登录态，等待继续校验与同步。'
              : '已保存网页登录态，等待补齐卖家与店铺资料。',
    };
  }
  syncStoreAuthSessionWebSession(
    sessionId: string,
    input: {
      cookieText?: string | null;
      providerUserId: string;
      providerShopId: string;
      providerShopName: string;
      mobile: string;
      nickname?: string | null;
      scopeText?: string | null;
      refreshToken?: string | null;
    },
    syncedByUserId: number,
  ) {
    const nextCookieText = input.cookieText?.trim() ?? '';
    if (nextCookieText) {
      this.receiveStoreAuthSessionWebCredential(sessionId, {
        cookieText: nextCookieText,
        source: 'manual',
      });
    } else {
      const existingCredential = this.getStoreCredentialBySessionId(sessionId);
      if (!existingCredential || existingCredential.credentialType !== 'web_session') {
        const error = new Error('请先录入网页登录态，或先完成扫码接收登录态。');
        (error as Error & { statusCode?: number }).statusCode = 400;
        throw error;
      }
    }

    return this.syncStoreAuthSessionProfile(
      sessionId,
      {
        providerUserId: input.providerUserId,
        providerShopId: input.providerShopId,
        providerShopName: input.providerShopName,
        mobile: input.mobile,
        nickname: input.nickname,
        scopeText: input.scopeText,
        refreshToken: input.refreshToken,
      },
      syncedByUserId,
    );
  }

  syncStoreAuthSessionProfile(
    sessionId: string,
    input: {
      providerUserId: string;
      providerShopId: string;
      providerShopName: string;
      mobile: string;
      nickname?: string | null;
      scopeText?: string | null;
      refreshToken?: string | null;
    },
    syncedByUserId: number | null,
  ) {
    const session = this.db
      .prepare(
        `
          SELECT
            session_id AS sessionId,
            platform,
            source,
            status,
            store_id AS storeId,
            owner_account_id AS ownerAccountId,
            created_by_user_id AS createdByUserId,
            reauthorize,
            integration_mode AS integrationMode,
            provider_access_token_received_at AS providerAccessTokenReceivedAt
          FROM store_auth_sessions
          WHERE session_id = ?
        `,
      )
      .get(sessionId) as
      | {
          sessionId: string;
          platform: StorePlatform;
          source: string;
          status: StoreAuthSessionStatus;
          storeId: number | null;
          ownerAccountId: number | null;
          createdByUserId: number | null;
          reauthorize: number;
          integrationMode: StoreAuthIntegrationMode;
          providerAccessTokenReceivedAt: string | null;
        }
      | undefined;

    if (!session) {
      return null;
    }

    if (session.status === 'invalidated' || session.status === 'completed') {
      const error = new Error('授权会话已失效，请重新发起授权。');
      (error as Error & { statusCode?: number }).statusCode = 409;
      throw error;
    }

    if (session.status === 'expired' && session.integrationMode === 'xianyu_web_session') {
      this.refreshStoreAuthSessionWindow(sessionId, {
        minutes: 15,
        reviveExpiredWebSession: true,
      });
    }

    if (
      session.integrationMode !== 'xianyu_browser_oauth' &&
      session.integrationMode !== 'xianyu_web_session'
    ) {
      const error = new Error('当前授权会话不是可同步资料的闲鱼接入模式。');
      (error as Error & { statusCode?: number }).statusCode = 409;
      throw error;
    }

    if (!session.providerAccessTokenReceivedAt) {
      const error =
        session.integrationMode === 'xianyu_web_session'
          ? new Error('尚未录入网页登录态或 Cookie，暂不能同步资料。')
          : new Error('尚未接收闲鱼官方回调，暂不能同步资料。');
      (error as Error & { statusCode?: number }).statusCode = 409;
      throw error;
    }

    const credential = this.getStoreCredentialBySessionId(sessionId);
    if (!credential) {
      const error = new Error('授权凭据不存在，请重新发起授权。');
      (error as Error & { statusCode?: number }).statusCode = 404;
      throw error;
    }

    const providerUserId = input.providerUserId.trim();
    const providerShopId = input.providerShopId.trim();
    const providerShopName = input.providerShopName.trim();
    const mobile = input.mobile.trim();
    const nickname = input.nickname?.trim() || providerShopName;
    const scopeText = input.scopeText?.trim() ?? credential.scopeText ?? '';
    const refreshToken = input.refreshToken?.trim() || null;

    if (!providerUserId || !providerShopId || !providerShopName || !mobile) {
      const error = new Error('请补齐卖家 ID、店铺 ID、店铺名称和手机号。');
      (error as Error & { statusCode?: number }).statusCode = 400;
      throw error;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    this.db
      .prepare(
        `
          UPDATE store_auth_sessions
          SET
            next_step = 'sync_profile',
            profile_sync_status = 'syncing',
            profile_sync_error = NULL,
            provider_error_code = NULL,
            provider_error_message = NULL
          WHERE session_id = ?
        `,
      )
      .run(sessionId);

    const ownerAccountId = this.upsertStoreOwnerAccount({
      accountId: session.ownerAccountId ?? credential.ownerAccountId ?? null,
      platform: session.platform,
      ownerName: nickname,
      mobile,
      loginMode: session.integrationMode === 'xianyu_web_session' ? 'cookie' : 'oauth',
      authorizedByUserId: syncedByUserId,
    });

    let storeId =
      session.storeId ?? this.findManagedStoreByProviderShopId(session.platform, providerShopId)?.id ?? null;
    let sellerNo = providerShopId || this.buildSellerNo(session.platform);
    let activationStatus: StoreConnectionStatus =
      session.platform === 'xianyu' ? 'pending_activation' : 'active';

    if (storeId) {
      const currentStore = this.db
        .prepare(
          `
            SELECT
              id,
              seller_no AS sellerNo,
              connection_status AS connectionStatus,
              enabled
            FROM managed_stores
            WHERE id = ?
          `,
        )
        .get(storeId) as
        | {
            id: number;
            sellerNo: string;
            connectionStatus: StoreConnectionStatus;
            enabled: number;
          }
        | undefined;

      if (!currentStore) {
        return null;
      }

      sellerNo = currentStore.sellerNo || sellerNo;
      activationStatus =
        currentStore.connectionStatus === 'pending_activation' ? 'pending_activation' : 'active';

      this.db
        .prepare(
          `
            UPDATE managed_stores
            SET
              shop_name = @shopName,
              seller_no = @sellerNo,
              nickname = @nickname,
              owner_account_id = @ownerAccountId,
              auth_status = 'authorized',
              auth_expires_at = @authExpiresAt,
              last_session_id = @lastSessionId,
              last_reauthorize_at = @lastReauthorizeAt,
              last_sync_at = CASE
                WHEN @activationStatus = 'active' THEN @lastSyncAt
                ELSE last_sync_at
              END,
              health_status = @healthStatus,
              last_health_check_detail = @lastHealthCheckDetail,
              connection_status = @activationStatus,
              activation_status = @activationStatus,
              status_text = @statusText,
              provider_store_id = @providerStoreId,
              provider_user_id = @providerUserId,
              credential_id = @credentialId,
              profile_sync_status = 'success',
              profile_sync_error = NULL,
              last_profile_sync_at = @lastProfileSyncAt,
              updated_at = @updatedAt
            WHERE id = @id
          `,
        )
        .run({
          id: storeId,
          shopName: providerShopName,
          sellerNo,
          nickname,
          ownerAccountId,
          authExpiresAt: credential.expiresAt,
          lastSessionId: sessionId,
          lastReauthorizeAt: now,
          lastSyncAt: activationStatus === 'active' ? now : null,
          healthStatus: activationStatus === 'active' ? 'healthy' : 'warning',
          lastHealthCheckDetail:
            activationStatus === 'active'
              ? session.integrationMode === 'xianyu_web_session'
                ? '网页登录态与店铺资料已同步，连接保持正常。'
                : '真实授权资料已同步，连接保持正常。'
              : session.integrationMode === 'xianyu_web_session'
                ? '网页登录态与店铺资料已同步，等待手动激活后进入正式调度。'
                : '真实授权资料已同步，等待手动激活后进入正式调度。',
          activationStatus,
          statusText: this.getManagedStoreStatusText(
            activationStatus,
            Boolean(currentStore.enabled),
          ),
          providerStoreId: providerShopId,
          providerUserId,
          credentialId: credential.id,
          lastProfileSyncAt: now,
          updatedAt: now,
        });
    } else {
      const insertResult = this.db
        .prepare(
          `
            INSERT INTO managed_stores (
              platform,
              shop_type_label,
              shop_name,
              seller_no,
              nickname,
              status_text,
              activation_status,
              package_text,
              publish_limit_text,
              owner_account_id,
              created_by_user_id,
              group_name,
              tags_text,
              remark,
              enabled,
              connection_status,
              auth_status,
              auth_expires_at,
              last_sync_at,
              health_status,
              last_health_check_at,
              last_health_check_detail,
              last_session_id,
              last_reauthorize_at,
              provider_store_id,
              provider_user_id,
              credential_id,
              profile_sync_status,
              profile_sync_error,
              last_profile_sync_at,
              last_verified_at,
              created_at,
              updated_at
            ) VALUES (
              @platform,
              @shopTypeLabel,
              @shopName,
              @sellerNo,
              @nickname,
              @statusText,
              @activationStatus,
              @packageText,
              @publishLimitText,
              @ownerAccountId,
              @createdByUserId,
              @groupName,
              @tagsText,
              @remark,
              1,
              @connectionStatus,
              'authorized',
              @authExpiresAt,
              @lastSyncAt,
              @healthStatus,
              NULL,
              @lastHealthCheckDetail,
              @lastSessionId,
              @lastReauthorizeAt,
              @providerStoreId,
              @providerUserId,
              @credentialId,
              'success',
              NULL,
              @lastProfileSyncAt,
              @lastVerifiedAt,
              @createdAt,
              @updatedAt
            )
          `,
        )
        .run({
          platform: session.platform,
          shopTypeLabel: session.platform === 'xianyu' ? '闲鱼店铺' : '淘宝店铺',
          shopName: providerShopName,
          sellerNo,
          nickname,
          statusText: this.getManagedStoreStatusText(activationStatus, true),
          activationStatus,
          packageText:
            session.platform === 'xianyu'
              ? session.integrationMode === 'xianyu_web_session'
                ? '网页登录态接入'
                : '开通提效包'
              : '极速搬家',
          publishLimitText:
            session.platform === 'xianyu'
              ? session.integrationMode === 'xianyu_web_session'
                ? '已录入网页登录态，待后续探活校验'
                : '已接入真实授权骨架'
              : '已准备同步商品与库存',
          ownerAccountId,
          createdByUserId: session.createdByUserId ?? syncedByUserId,
          groupName: session.platform === 'xianyu' ? '闲鱼主店' : '淘宝搬家',
          tagsText:
            session.platform === 'xianyu'
              ? this.normalizeStoreTags([
                  '闲鱼',
                  session.integrationMode === 'xianyu_web_session' ? '网页登录态接入' : '真实接入',
                ])
              : this.normalizeStoreTags(['淘宝', '真实接入']),
          remark:
            session.integrationMode === 'xianyu_web_session'
              ? '通过网页登录态与店铺资料同步完成首轮绑店。'
              : '通过真实授权资料同步完成首轮绑店。',
          connectionStatus: activationStatus,
          authExpiresAt: credential.expiresAt,
          lastSyncAt: activationStatus === 'active' ? now : null,
          healthStatus: activationStatus === 'active' ? 'healthy' : 'warning',
          lastHealthCheckDetail:
            activationStatus === 'active'
              ? session.integrationMode === 'xianyu_web_session'
                ? '网页登录态与店铺资料已同步，连接保持正常。'
                : '真实授权资料已同步，连接保持正常。'
              : session.integrationMode === 'xianyu_web_session'
                ? '网页登录态与店铺资料已同步，等待手动激活后进入正式调度。'
                : '真实授权资料已同步，等待手动激活后进入正式调度。',
          lastSessionId: sessionId,
          lastReauthorizeAt: now,
          providerStoreId: providerShopId,
          providerUserId,
          credentialId: credential.id,
          lastProfileSyncAt: now,
          lastVerifiedAt: now,
          createdAt: now,
          updatedAt: now,
        });

      storeId = Number(insertResult.lastInsertRowid);
    }

    this.db
      .prepare(
        `
          UPDATE store_platform_credentials
          SET
            store_id = @storeId,
            owner_account_id = @ownerAccountId,
            refresh_token_encrypted = @refreshTokenEncrypted,
            scope_text = @scopeText,
            provider_user_id = @providerUserId,
            provider_shop_id = @providerShopId,
            provider_shop_name = @providerShopName,
            last_verified_at = @lastVerifiedAt,
            last_sync_status = 'profile_synced',
            updated_at = @updatedAt
          WHERE id = @id
        `,
      )
      .run({
        id: credential.id,
        storeId,
        ownerAccountId,
        refreshTokenEncrypted: refreshToken
          ? encryptSecret(refreshToken, this.secureConfigSecret)
          : null,
        scopeText,
        providerUserId,
        providerShopId,
        providerShopName,
        lastVerifiedAt: now,
        updatedAt: now,
      });

    this.db
      .prepare(
        `
          UPDATE store_auth_sessions
          SET
            status = 'completed',
            completed_at = @completedAt,
            invalid_reason = NULL,
            store_id = @storeId,
            owner_account_id = @ownerAccountId,
            mobile = @mobile,
            nickname = @nickname,
            next_step = 'done',
            profile_sync_status = 'success',
            profile_sync_error = NULL,
            profile_synced_at = @profileSyncedAt,
            provider_error_code = NULL,
            provider_error_message = NULL
          WHERE session_id = @sessionId
        `,
      )
      .run({
        sessionId,
        completedAt: now,
        storeId,
        ownerAccountId,
        mobile,
        nickname,
        profileSyncedAt: now,
      });

    this.bindStoreCredentialEventsToStore(sessionId, {
      storeId,
      credentialId: credential.id,
    });
    this.recordStoreCredentialEvent({
      storeId,
      sessionId,
      credentialId: credential.id,
      eventType: 'profile_synced',
      status: 'success',
      detail:
        session.integrationMode === 'xianyu_web_session'
          ? '卖家资料、店铺资料与网页登录态已完成绑定。'
          : '卖家资料、店铺资料与授权凭据已完成绑定。',
      source: session.integrationMode,
      operatorUserId: syncedByUserId,
    });

    return {
      storeId,
      platform: session.platform,
      activationStatus,
      statusText:
        activationStatus === 'pending_activation'
          ? '资料已同步，待激活'
          : '资料已同步，已接入',
      shopName: providerShopName,
      sellerNo,
      source: session.source,
      reauthorized: Boolean(session.storeId),
      providerUserId,
      providerShopId,
      providerShopName,
      profileSyncedAt: now,
    };
  }

  completeStoreAuthSession(
    sessionId: string,
    payload: { mobile: string; nickname: string; loginMode: 'sms' | 'password' },
    completedByUserId: number | null,
  ) {
    const session = this.db
      .prepare(
        `
          SELECT
            session_id AS sessionId,
            platform,
            source,
            auth_type AS authType,
            status,
            store_id AS storeId,
            owner_account_id AS ownerAccountId,
            created_by_user_id AS createdByUserId,
            integration_mode AS integrationMode
          FROM store_auth_sessions
          WHERE session_id = ?
        `,
      )
      .get(sessionId) as
      | {
          sessionId: string;
          platform: StorePlatform;
          source: string;
          authType: number;
          status: StoreAuthSessionStatus;
          storeId: number | null;
          ownerAccountId: number | null;
          createdByUserId: number | null;
          integrationMode: StoreAuthIntegrationMode;
        }
      | undefined;

    if (!session || session.status !== 'pending') {
      return null;
    }

    if (session.integrationMode !== 'simulated') {
      const error = new Error('当前授权会话已切换为真实授权模式，请先完成官方回调。');
      (error as Error & { statusCode?: number }).statusCode = 409;
      throw error;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const authExpiresAt = format(
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      'yyyy-MM-dd HH:mm:ss',
    );
    const ownerAccountId = this.upsertStoreOwnerAccount({
      accountId: session.ownerAccountId,
      platform: session.platform,
      ownerName: payload.nickname,
      mobile: payload.mobile,
      loginMode: payload.loginMode,
      authorizedByUserId: completedByUserId,
    });

    let storeId = session.storeId ?? null;
    let sellerNo = '';
    let activationStatus: StoreConnectionStatus;

    if (storeId) {
      const currentStore = this.db
        .prepare(
          `
            SELECT
              id,
              seller_no AS sellerNo,
              connection_status AS connectionStatus,
              enabled
            FROM managed_stores
            WHERE id = ?
          `,
        )
        .get(storeId) as
        | {
            id: number;
            sellerNo: string;
            connectionStatus: StoreConnectionStatus;
            enabled: number;
          }
        | undefined;

      if (!currentStore) {
        return null;
      }

      sellerNo = currentStore.sellerNo;
      activationStatus =
        currentStore.connectionStatus === 'pending_activation' ? 'pending_activation' : 'active';

      this.db
        .prepare(
          `
            UPDATE managed_stores
            SET
              shop_name = @shopName,
              nickname = @nickname,
              owner_account_id = @ownerAccountId,
              auth_status = 'authorized',
              auth_expires_at = @authExpiresAt,
              last_session_id = @lastSessionId,
              last_reauthorize_at = @lastReauthorizeAt,
              last_sync_at = CASE
                WHEN @activationStatus = 'active' THEN @lastSyncAt
                ELSE last_sync_at
              END,
              health_status = @healthStatus,
              last_health_check_detail = @lastHealthCheckDetail,
              connection_status = @activationStatus,
              activation_status = @activationStatus,
              status_text = @statusText,
              updated_at = @updatedAt
            WHERE id = @id
          `,
        )
        .run({
          id: storeId,
          shopName: payload.nickname,
          nickname: payload.nickname,
          ownerAccountId,
          authExpiresAt,
          lastSessionId: sessionId,
          lastReauthorizeAt: now,
          lastSyncAt: activationStatus === 'active' ? now : null,
          healthStatus: activationStatus === 'pending_activation' ? 'warning' : 'healthy',
          lastHealthCheckDetail:
            activationStatus === 'pending_activation'
              ? '授权已恢复，等待手动激活。'
              : '重新授权完成，连接已恢复正常。',
          activationStatus,
          statusText: this.getManagedStoreStatusText(
            activationStatus,
            Boolean(currentStore.enabled),
          ),
          updatedAt: now,
        });
    } else {
      sellerNo = this.buildSellerNo(session.platform);
      activationStatus = session.platform === 'xianyu' ? 'pending_activation' : 'active';

      const insertResult = this.db
        .prepare(
          `
            INSERT INTO managed_stores (
              platform,
              shop_type_label,
              shop_name,
              seller_no,
              nickname,
              status_text,
              activation_status,
              package_text,
              publish_limit_text,
              owner_account_id,
              created_by_user_id,
              group_name,
              tags_text,
              remark,
              enabled,
              connection_status,
              auth_status,
              auth_expires_at,
              last_sync_at,
              health_status,
              last_health_check_at,
              last_health_check_detail,
              last_session_id,
              last_reauthorize_at,
              created_at,
              updated_at
            ) VALUES (
              @platform,
              @shopTypeLabel,
              @shopName,
              @sellerNo,
              @nickname,
              @statusText,
              @activationStatus,
              @packageText,
              @publishLimitText,
              @ownerAccountId,
              @createdByUserId,
              @groupName,
              @tagsText,
              @remark,
              1,
              @connectionStatus,
              'authorized',
              @authExpiresAt,
              @lastSyncAt,
              @healthStatus,
              NULL,
              @lastHealthCheckDetail,
              @lastSessionId,
              @lastReauthorizeAt,
              @createdAt,
              @updatedAt
            )
          `,
        )
        .run({
          platform: session.platform,
          shopTypeLabel: session.platform === 'xianyu' ? '闲鱼店铺' : '淘宝店铺',
          shopName: payload.nickname,
          sellerNo,
          nickname: payload.nickname,
          statusText: this.getManagedStoreStatusText(activationStatus, true),
          activationStatus,
          packageText: session.platform === 'xianyu' ? '开通提效包' : '极速搬家',
          publishLimitText:
            session.platform === 'xianyu' ? '发布数提升至 1000+' : '已准备同步商品与库存',
          ownerAccountId,
          createdByUserId: session.createdByUserId ?? completedByUserId,
          groupName: session.platform === 'xianyu' ? '闲鱼主店' : '淘宝搬家',
          tagsText:
            session.platform === 'xianyu'
              ? this.normalizeStoreTags(['闲鱼', '新接入'])
              : this.normalizeStoreTags(['淘宝', '搬家']),
          remark: '通过店铺接入中心授权创建',
          connectionStatus: activationStatus,
          authExpiresAt,
          lastSyncAt: activationStatus === 'active' ? now : null,
          healthStatus: activationStatus === 'pending_activation' ? 'warning' : 'healthy',
          lastHealthCheckDetail:
            activationStatus === 'pending_activation'
              ? '授权完成，等待激活。'
              : '授权完成，连接状态正常。',
          lastSessionId: sessionId,
          lastReauthorizeAt: now,
          createdAt: now,
          updatedAt: now,
        });

      storeId = Number(insertResult.lastInsertRowid);
    }

    this.db
      .prepare(
        `
          UPDATE store_auth_sessions
          SET
            status = 'completed',
            completed_at = @completedAt,
            mobile = @mobile,
            nickname = @nickname,
            invalid_reason = NULL,
            store_id = @storeId,
            owner_account_id = @ownerAccountId,
            next_step = 'done',
            profile_sync_status = 'success',
            profile_sync_error = NULL,
            profile_synced_at = @completedAt
          WHERE session_id = @sessionId
        `,
      )
      .run({
        sessionId,
        completedAt: now,
        mobile: payload.mobile,
        nickname: payload.nickname,
        storeId,
        ownerAccountId,
      });

    return {
      storeId,
      platform: session.platform,
      activationStatus,
      statusText: this.getManagedStoreStatusText(activationStatus, true),
      shopName: payload.nickname,
      sellerNo,
      source: session.source,
      loginMode: payload.loginMode,
      reauthorized: Boolean(session.storeId),
    };
  }

  activateManagedStore(storeId: number) {
    const store = this.db
      .prepare(
        `
        SELECT
          id,
          shop_name AS shopName,
          connection_status AS connectionStatus,
          enabled
        FROM managed_stores
        WHERE id = ?
      `,
      )
      .get(storeId) as
      | {
          id: number;
          shopName: string;
          connectionStatus: StoreConnectionStatus;
          enabled: number;
        }
      | undefined;

    if (!store) {
      return null;
    }

    if (store.connectionStatus === 'active') {
      return { activated: true, shopName: store.shopName };
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

    this.db
      .prepare(
        `
        UPDATE managed_stores
        SET
          status_text = @statusText,
          activation_status = 'active',
          connection_status = 'active',
          health_status = CASE WHEN enabled = 1 THEN 'healthy' ELSE health_status END,
          last_sync_at = CASE WHEN enabled = 1 THEN @lastSyncAt ELSE last_sync_at END,
          last_health_check_detail = CASE
            WHEN enabled = 1 THEN '搴楅摵宸叉縺娲诲苟鎭㈠姝ｅ紡璋冨害銆?'
            ELSE last_health_check_detail
          END,
          updated_at = @updatedAt
        WHERE id = @id
      `,
      )
      .run({
        id: storeId,
        statusText: this.getManagedStoreStatusText('active', Boolean(store.enabled)),
        lastSyncAt: now,
        updatedAt: now,
      });

    return { activated: true, shopName: store.shopName };
  }

  markManagedStoreCredentialRenew(
    storeId: number,
    input: {
      cookieText?: string | null;
      detail: string;
      renewed: boolean;
      verificationUrl?: string | null;
    },
  ) {
    const context = this.getManagedStoreCredentialContext(storeId);
    if (!context) {
      return null;
    }

    if (!context.credentialId) {
      const error = new Error('褰撳墠搴楅摵灏氭湭缁戝畾鍑嵁锛屼笉鑳借褰曠画鐧荤粨鏋溿€?');
      (error as Error & { statusCode?: number }).statusCode = 409;
      throw error;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const cookieText = input.cookieText?.trim() || null;
    this.db
      .prepare(
        `
          UPDATE store_platform_credentials
          SET
            access_token_encrypted = COALESCE(@accessTokenEncrypted, access_token_encrypted),
            access_token_masked = COALESCE(@accessTokenMasked, access_token_masked),
            verification_url = COALESCE(@verificationUrl, verification_url),
            last_renewed_at = @lastRenewedAt,
            last_renew_status = @lastRenewStatus,
            updated_at = @updatedAt
          WHERE id = @id
        `,
      )
      .run({
        id: context.credentialId,
        accessTokenEncrypted: cookieText ? encryptSecret(cookieText, this.secureConfigSecret) : null,
        accessTokenMasked: cookieText ? maskSecret(cookieText) : null,
        verificationUrl: input.verificationUrl?.trim() || null,
        lastRenewedAt: now,
        lastRenewStatus: input.detail.trim(),
        updatedAt: now,
      });

    this.db
      .prepare(
        `
          UPDATE managed_stores
          SET
            updated_at = @updatedAt
          WHERE id = @id
        `,
      )
      .run({
        id: storeId,
        updatedAt: now,
      });

    if (cookieText) {
      this.clearManagedStoreXianyuImAuthCache(storeId);
    }

    this.recordStoreCredentialEvent({
      storeId,
      credentialId: context.credentialId,
      eventType: 'browser_renewed',
      status: input.renewed ? 'success' : input.verificationUrl?.trim() ? 'warning' : 'error',
      detail: input.detail.trim(),
      source: 'browser_renew',
      verificationUrl: input.verificationUrl ?? null,
    });
    if (input.verificationUrl?.trim()) {
      this.recordStoreCredentialEvent({
        storeId,
        credentialId: context.credentialId,
        eventType: 'manual_takeover_required',
        status: 'warning',
        detail: input.detail.trim(),
        source: 'browser_renew',
        verificationUrl: input.verificationUrl ?? null,
      });
    }

    return {
      storeId,
      shopName: context.shopName,
      renewed: input.renewed,
      renewedAt: now,
      detail: input.detail.trim(),
    };
  }

  saveManagedStoreCredentialCheckResult(
    storeId: number,
    input: {
      riskLevel: Exclude<StoreCredentialRiskLevel, 'pending'>;
      detail: string;
      verificationUrl?: string | null;
      refreshedCookieText?: string | null;
    },
    triggeredByUserId: number | null,
    triggerMode: 'manual' | 'batch' = 'manual',
  ) {
    const context = this.getManagedStoreCredentialContext(storeId);
    if (!context) {
      return null;
    }

    if (!context.credentialId) {
      const error = new Error('褰撳墠搴楅摵灏氭湭缁戝畾鍑嵁锛屼笉鑳芥墽琛岀櫥褰曟€佹牎楠屻€?');
      (error as Error & { statusCode?: number }).statusCode = 409;
      throw error;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const nextConnectionStatus: StoreConnectionStatus =
      input.riskLevel === 'healthy' || input.riskLevel === 'warning'
        ? context.connectionStatus === 'pending_activation'
          ? 'pending_activation'
          : 'active'
        : input.riskLevel === 'offline'
          ? 'offline'
          : 'abnormal';
    const nextHealthStatus: StoreHealthStatus =
      input.riskLevel === 'healthy'
        ? 'healthy'
        : input.riskLevel === 'warning'
          ? 'warning'
          : input.riskLevel === 'offline'
            ? 'offline'
            : 'abnormal';
    const nextAuthStatus: StoreAuthStatus =
      input.riskLevel === 'offline'
        ? 'expired'
        : input.riskLevel === 'abnormal'
          ? 'invalidated'
          : 'authorized';
    const refreshedCookieText = input.refreshedCookieText?.trim() || null;

    this.db
      .prepare(
        `
          UPDATE store_platform_credentials
          SET
            access_token_encrypted = COALESCE(@accessTokenEncrypted, access_token_encrypted),
            access_token_masked = COALESCE(@accessTokenMasked, access_token_masked),
            risk_level = @riskLevel,
            risk_reason = @riskReason,
            verification_url = @verificationUrl,
            last_verified_at = @lastVerifiedAt,
            updated_at = @updatedAt
          WHERE id = @id
        `,
      )
      .run({
        id: context.credentialId,
        accessTokenEncrypted: refreshedCookieText
          ? encryptSecret(refreshedCookieText, this.secureConfigSecret)
          : null,
        accessTokenMasked: refreshedCookieText ? maskSecret(refreshedCookieText) : null,
        riskLevel: input.riskLevel,
        riskReason: input.detail.trim(),
        verificationUrl: input.verificationUrl?.trim() || null,
        lastVerifiedAt: now,
        updatedAt: now,
      });

    this.db
      .prepare(
        `
          INSERT INTO store_health_checks (
            store_id,
            status,
            detail,
            checked_at,
            triggered_by_user_id,
            trigger_mode
          ) VALUES (
            @storeId,
            @status,
            @detail,
            @checkedAt,
            @triggeredByUserId,
            @triggerMode
          )
        `,
      )
      .run({
        storeId,
        status: nextHealthStatus,
        detail: input.detail.trim(),
        checkedAt: now,
        triggeredByUserId,
        triggerMode,
      });

    this.db
      .prepare(
        `
          UPDATE managed_stores
          SET
            connection_status = @connectionStatus,
            activation_status = @activationStatus,
            auth_status = @authStatus,
            health_status = @healthStatus,
            last_health_check_at = @lastHealthCheckAt,
            last_health_check_detail = @lastHealthCheckDetail,
            last_verified_at = @lastVerifiedAt,
            last_sync_at = CASE
              WHEN enabled = 1 AND @connectionStatus = 'active' AND @healthStatus = 'healthy'
                THEN @lastSyncAt
              ELSE last_sync_at
            END,
            status_text = @statusText,
            updated_at = @updatedAt
          WHERE id = @id
        `,
      )
      .run({
        id: storeId,
        connectionStatus: nextConnectionStatus,
        activationStatus: nextConnectionStatus,
        authStatus: nextAuthStatus,
        healthStatus: nextHealthStatus,
        lastHealthCheckAt: now,
        lastHealthCheckDetail: input.detail.trim(),
        lastVerifiedAt: now,
        lastSyncAt: now,
        statusText: this.getManagedStoreStatusText(nextConnectionStatus, Boolean(context.enabled)),
        updatedAt: now,
      });

    if (refreshedCookieText || input.riskLevel === 'offline' || input.riskLevel === 'abnormal') {
      this.clearManagedStoreXianyuImAuthCache(storeId);
    }

    this.recordStoreCredentialEvent({
      storeId,
      credentialId: context.credentialId,
      eventType: 'credential_verified',
      status:
        input.riskLevel === 'healthy'
          ? 'success'
          : input.riskLevel === 'warning'
            ? 'warning'
            : 'error',
      detail: input.detail.trim(),
      source: triggerMode,
      riskLevel: input.riskLevel,
      verificationUrl: input.verificationUrl ?? null,
      operatorUserId: triggeredByUserId,
    });
    if (
      input.verificationUrl?.trim() ||
      input.riskLevel === 'warning' ||
      input.riskLevel === 'offline' ||
      input.riskLevel === 'abnormal'
    ) {
      this.recordStoreCredentialEvent({
        storeId,
        credentialId: context.credentialId,
        eventType: 'manual_takeover_required',
        status: 'warning',
        detail: input.detail.trim(),
        source: triggerMode,
        riskLevel: input.riskLevel,
        verificationUrl: input.verificationUrl ?? null,
        operatorUserId: triggeredByUserId,
      });
    }

    return {
      storeId,
      shopName: context.shopName,
      riskLevel: input.riskLevel,
      connectionStatus: nextConnectionStatus,
      authStatus: nextAuthStatus,
      healthStatus: nextHealthStatus,
      checkedAt: now,
      detail: input.detail.trim(),
      verificationUrl: input.verificationUrl?.trim() || null,
      refreshed: Boolean(refreshedCookieText),
    };
  }
}
