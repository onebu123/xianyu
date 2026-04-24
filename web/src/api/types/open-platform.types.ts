export interface OpenPlatformAppRecord {
  id: number;
  appKey: string;
  appName: string;
  ownerName: string;
  contactName: string;
  callbackUrl: string;
  status: 'active' | 'suspended' | 'draft';
  scopesText: string;
  scopes: string[];
  rateLimitPerMinute: number;
  lastCalledAt: string | null;
  createdAt: string;
  updatedAt: string;
  secretMasked: string;
  successCount: number;
  blockedCount: number;
  failureCount: number;
  totalCallCount: number;
}

export interface OpenPlatformCallLogRecord {
  id: number;
  appKey: string;
  tenantKey: string | null;
  traceId: string;
  httpMethod: string;
  routePath: string;
  requestIp: string | null;
  statusCode: number;
  callStatus: 'success' | 'blocked' | 'failure';
  durationMs: number;
  detail: string;
  createdAt: string;
}

export interface OpenPlatformAppsDetailResponse {
  kind: 'open-apps';
  title: string;
  description: string;
  metrics: Array<{
    label: string;
    value: number | string;
    unit: string;
    helper: string;
  }>;
  apps: OpenPlatformAppRecord[];
  recentCalls: OpenPlatformCallLogRecord[];
}

export interface OpenPlatformDocRecord {
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
}

export interface OpenPlatformDocsDetailResponse {
  kind: 'open-docs';
  title: string;
  description: string;
  metrics: Array<{
    label: string;
    value: number | string;
    unit: string;
    helper: string;
  }>;
  docs: OpenPlatformDocRecord[];
}

export interface OpenPlatformSettingsDetailResponse {
  kind: 'open-settings';
  title: string;
  description: string;
  metrics: Array<{
    label: string;
    value: number | string;
    unit: string;
    helper: string;
  }>;
  settings: {
    webhookBaseUrl: string;
    notifyEmail: string;
    publishedVersion: string;
    defaultRateLimitPerMinute: number;
    signatureTtlSeconds: number;
    whitelistEnforced: boolean;
    updatedAt: string;
    updatedByName: string | null;
  } | null;
}

export interface OpenPlatformWhitelistRuleRecord {
  id: number;
  ruleType: 'ip';
  ruleValue: string;
  description: string;
  enabled: boolean;
  hitCount: number;
  lastHitAt: string | null;
  createdAt: string;
  updatedAt: string;
  updatedByName: string | null;
}

export interface OpenPlatformWhitelistDetailResponse {
  kind: 'open-whitelist';
  title: string;
  description: string;
  metrics: Array<{
    label: string;
    value: number | string;
    unit: string;
    helper: string;
  }>;
  rules: OpenPlatformWhitelistRuleRecord[];
}
