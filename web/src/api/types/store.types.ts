// 店铺管理与授权相关类型定义

export type StorePlatform = 'xianyu' | 'taobao';
export type StoreConnectionStatus = 'pending_activation' | 'active' | 'offline' | 'abnormal';
export type StoreAuthStatus = 'authorized' | 'expired' | 'invalidated' | 'pending';
export type StoreAuthSessionStatus = 'pending' | 'completed' | 'expired' | 'invalidated';
export type StoreHealthStatus = 'healthy' | 'warning' | 'offline' | 'abnormal' | 'skipped';
export type StoreCredentialRiskLevel = 'pending' | 'healthy' | 'warning' | 'offline' | 'abnormal';
export type StoreAuthIntegrationMode =
  | 'simulated'
  | 'xianyu_browser_oauth'
  | 'xianyu_web_session';
export type StoreProfileSyncStatus = 'pending' | 'syncing' | 'success' | 'failed';
export type StoreAuthSessionNextStep =
  | 'manual_complete'
  | 'wait_provider_callback'
  | 'sync_profile'
  | 'done'
  | 'expired'
  | 'invalidated';

export interface StoreManagementStore {
  id: number;
  platform: StorePlatform;
  shopTypeLabel: string;
  shopName: string;
  sellerNo: string;
  nickname: string;
  statusText: string;
  activationStatus: StoreConnectionStatus;
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
  tagsText?: string | null;
  tags: string[];
  remark: string;
  enabled: boolean;
  scheduleStatus: 'running' | 'paused';
  connectionStatus: StoreConnectionStatus;
  connectionStatusText: string;
  authStatus: StoreAuthStatus;
  authStatusText: string;
  authExpiresAt: string | null;
  lastSyncAt: string | null;
  healthStatus: StoreHealthStatus;
  healthStatusText: string;
  profileSyncStatus: StoreProfileSyncStatus;
  profileSyncStatusText: string;
  profileSyncError: string | null;
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
  lastProfileSyncAt: string | null;
  lastVerifiedAt: string | null;
  lastHealthCheckAt: string | null;
  lastHealthCheckDetail: string | null;
  lastSessionId: string | null;
  lastReauthorizeAt: string | null;
  activationHint: string | null;
}

export interface StoreAuthSessionRecord {
  sessionId: string;
  platform: StorePlatform;
  source: string;
  authType: number;
  status: StoreAuthSessionStatus;
  statusText: string;
  integrationMode: StoreAuthIntegrationMode;
  providerLabel: string | null;
  createdAt: string;
  expiresAt: string | null;
  completedAt: string | null;
  invalidReason: string | null;
  providerAccessTokenReceivedAt: string | null;
  tokenReceived: boolean;
  nextStepKey: StoreAuthSessionNextStep;
  nextStepText: string;
  storeId: number | null;
  ownerAccountId: number | null;
  mobile: string | null;
  nickname: string | null;
  reauthorize: boolean;
  storeName: string | null;
  ownerAccountName: string | null;
  createdByName: string | null;
}

export interface StoreHealthCheckRecord {
  id: number;
  storeId: number;
  storeName: string | null;
  status: StoreHealthStatus;
  statusText: string;
  detail: string;
  checkedAt: string;
  triggerMode: 'manual' | 'batch';
  triggeredByName: string | null;
}

export type StoreCredentialEventType =
  | 'qr_login_started'
  | 'credential_captured'
  | 'profile_synced'
  | 'credential_verified'
  | 'browser_renewed'
  | 'manual_takeover_required';
export type StoreCredentialEventStatus = 'info' | 'success' | 'warning' | 'error';

export interface StoreCredentialEventRecord {
  id: number;
  storeId: number | null;
  sessionId: string | null;
  credentialId: number | null;
  eventType: StoreCredentialEventType;
  eventTypeText: string;
  status: StoreCredentialEventStatus;
  statusText: string;
  detail: string;
  source: string | null;
  riskLevel: StoreCredentialRiskLevel | null;
  verificationUrl: string | null;
  createdAt: string;
  operatorName: string | null;
}

export interface StoreCredentialEventsResponse {
  storeId: number;
  shopName: string;
  events: StoreCredentialEventRecord[];
}

export interface StoreSessionCredentialEventsResponse {
  sessionId: string;
  storeId: number | null;
  storeName: string | null;
  events: StoreCredentialEventRecord[];
}

export interface StoreAuthSessionLiveStreamTokenResponse {
  streamToken: string;
  expiresAt: string;
}

export interface StoreAuthSessionLiveSnapshotResponse {
  sessionId: string;
  sessionDetail: StoreAuthSessionDetailResponse;
  qrSession: StoreQrLoginSessionResponse | null;
  credentialEvents: StoreCredentialEventRecord[];
}

export interface StoreManagementOverviewResponse {
  profile: {
    displayName: string;
    mobile: string;
    updatedAt: string;
  };
  actions: Array<{
    key: string;
    label: string;
    description: string;
  }>;
  stores: StoreManagementStore[];
  xianyuStores: StoreManagementStore[];
  taobaoStores: StoreManagementStore[];
  authSessions: StoreAuthSessionRecord[];
  healthChecks: StoreHealthCheckRecord[];
  groups: Array<{
    name: string;
    count: number;
  }>;
  summaries: {
    totalStoreCount: number;
    xianyuStoreCount: number;
    taobaoStoreCount: number;
    enabledStoreCount: number;
    disabledStoreCount: number;
    pendingActivationCount: number;
    activeStoreCount: number;
    offlineStoreCount: number;
    abnormalStoreCount: number;
    pendingSessionCount: number;
    expiredSessionCount: number;
    invalidatedSessionCount: number;
  };
  serviceCards: Array<{
    key: string;
    title: string;
    actionLabel: string;
    description: string;
  }>;
}

export interface StoreAuthSessionResponse {
  sessionId: string;
  platform: StorePlatform;
  source: string;
  authType: number;
  createdAt: string;
  expiresAt: string;
  reauthorize: boolean;
  storeId: number | null;
  storeName: string | null;
  integrationMode: StoreAuthIntegrationMode;
  providerKey: string | null;
  providerLabel: string | null;
  providerConfigured: boolean;
  authorizeUrl: string | null;
  callbackPath: string | null;
  callbackUrl: string | null;
  requiresBrowserCallback: boolean;
  instructions: string[];
  permissions: string[];
}

export interface StoreAuthSessionDetailResponse {
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
  reauthorize: boolean;
  integrationMode: StoreAuthIntegrationMode;
  providerKey: string | null;
  providerLabel: string | null;
  providerState: string | null;
  providerConfigured: boolean;
  authorizeUrl: string | null;
  callbackPath: string | null;
  callbackUrl: string | null;
  requiresBrowserCallback: boolean;
  instructions: string[];
  providerAccessTokenMasked: string | null;
  providerAccessTokenReceivedAt: string | null;
  callbackReceivedAt: string | null;
  profileSyncStatus: StoreProfileSyncStatus;
  profileSyncStatusText: string;
  profileSyncError: string | null;
  profileSyncedAt: string | null;
  providerUserId: string | null;
  providerShopId: string | null;
  providerShopName: string | null;
  scopeText: string | null;
  mobile: string | null;
  nickname: string | null;
  tokenReceived: boolean;
  nextStepKey: StoreAuthSessionNextStep;
  nextStepText: string;
}

export interface StoreAuthCompleteResponse {
  storeId: number;
  platform: StorePlatform;
  activationStatus: StoreConnectionStatus;
  statusText: string;
  shopName: string;
  sellerNo: string;
  source: string;
  loginMode: 'sms' | 'password';
  reauthorized: boolean;
}

export interface StoreAuthProviderCallbackResponse {
  accepted: boolean;
  statusCode: number;
  sessionId: string;
  integrationMode: StoreAuthIntegrationMode;
  providerKey: string;
  accessTokenMasked: string;
  accessTokenReceivedAt: string;
  nextStep: StoreAuthSessionNextStep;
  nextStepText: string;
  message: string;
}

export interface StoreAuthProfileSyncResponse {
  storeId: number;
  platform: StorePlatform;
  activationStatus: StoreConnectionStatus;
  statusText: string;
  shopName: string;
  sellerNo: string;
  source: string;
  reauthorized: boolean;
  providerUserId: string;
  providerShopId: string;
  providerShopName: string;
  profileSyncedAt: string;
}

export interface StoreWebSessionProfileDetectResponse {
  detected: boolean;
  currentUrl: string | null;
  pageTitle: string | null;
  verificationUrl: string | null;
  detail: string;
  providerUserId: string | null;
  providerShopId: string | null;
  providerShopName: string | null;
  nickname: string | null;
  mobile: string | null;
  credentialUpdated: boolean;
  riskLevel: StoreCredentialRiskLevel | null;
  rawRet: string[];
}

export interface StoreQrLoginSessionResponse {
  qrLoginId: string;
  authSessionId: string;
  status: 'waiting' | 'scanned' | 'success' | 'expired' | 'cancelled' | 'verification_required' | 'failed';
  qrCodeUrl: string;
  createdAt: string;
  expiresAt: string;
  lastPolledAt: string | null;
  verificationUrl: string | null;
  hasCookies: boolean;
  cookieMasked: string | null;
  failureReason: string | null;
}

export interface StoreCredentialVerifyResponse {
  storeId: number;
  shopName: string;
  riskLevel: Exclude<StoreCredentialRiskLevel, 'pending'>;
  connectionStatus: StoreConnectionStatus;
  authStatus: StoreAuthStatus;
  healthStatus: StoreHealthStatus;
  checkedAt: string;
  detail: string;
  verificationUrl: string | null;
  refreshed: boolean;
  rawRet: string[];
}

export interface StoreBrowserRenewResponse extends StoreCredentialVerifyResponse {
  renewed: boolean;
  renewDetail: string;
  currentUrl: string | null;
  pageTitle: string | null;
}
