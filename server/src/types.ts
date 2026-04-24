export type DatePreset = 'today' | 'last7Days' | 'last30Days' | 'last90Days';
export type RuntimeMode = 'demo' | 'staging' | 'prod';
export type DeploymentMode = 'private' | 'saas';
export type BackgroundJobsMode = 'embedded' | 'worker' | 'disabled';
export type QueueBackend = 'sqlite' | 'redis';
export type DatabaseEngine = 'sqlite' | 'postgres';
export type SystemUserRole = 'admin' | 'operator' | 'support' | 'finance';
export type SystemUserStatus = 'active' | 'disabled';
export type PlatformUserRole = 'platform_admin' | 'platform_operator';
export type PlatformUserStatus = 'active' | 'disabled';
export type TenantStatus = 'provisioning' | 'active' | 'suspended';
export type TenantMembershipRole = 'owner' | 'admin' | 'member' | 'support';
export type AuthScope = 'private' | 'platform' | 'tenant';
export type StoreAuthIntegrationMode =
  | 'simulated'
  | 'xianyu_browser_oauth'
  | 'xianyu_web_session';
export type StoreAuthProviderKey = 'xianyu-browser-oauth' | 'xianyu-web-session';

export interface BootstrapAdminConfig {
  username: string;
  password: string;
  displayName: string;
}

export interface DatabaseInitializeOptions {
  forceReseed?: boolean;
  runtimeMode?: RuntimeMode;
  seedDemoData?: boolean;
  bootstrapAdmin?: BootstrapAdminConfig | null;
}

export interface QueryFilters {
  preset?: DatePreset;
  startDate?: string;
  endDate?: string;
  storeId?: number;
  storeIds?: number[];
  productId?: number;
  category?: string;
  source?: string;
  keyword?: string;
  mainStatus?: string;
  deliveryStatus?: string;
  orderStatus?: string;
  afterSaleStatus?: string;
  caseType?: string;
  caseStatus?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface PaginationParams {
  page: number;
  pageSize: number;
}

export interface FilterOptions {
  stores: Array<{ label: string; value: number }>;
  products: Array<{ label: string; value: number }>;
  categories: Array<{ label: string; value: string }>;
  sources: Array<{ label: string; value: string }>;
}

export interface SystemUserRecord {
  id: number;
  username: string;
  displayName: string;
  role: SystemUserRole;
  status: SystemUserStatus;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  tokenVersion?: number;
  passwordHash?: string;
}

export interface PlatformUserRecord {
  id: number;
  username: string;
  displayName: string;
  role: PlatformUserRole;
  status: PlatformUserStatus;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  passwordChangedAt: string | null;
  tokenVersion?: number;
  passwordHash?: string;
  mfaSecretRefId?: number | null;
}

export interface TenantRecord {
  id: number;
  tenantKey: string;
  tenantName: string;
  displayName: string;
  status: TenantStatus;
  businessDbPath: string;
  createdAt: string;
  updatedAt: string;
  provisionedAt: string | null;
  suspendedAt: string | null;
}

export interface TenantMembershipRecord {
  id: number;
  tenantId: number;
  platformUserId: number;
  membershipRole: TenantMembershipRole;
  systemRole: SystemUserRole;
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
}

export interface TenantProvisioningJobRecord {
  id: number;
  tenantId: number;
  jobType: 'tenant_bootstrap';
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  detail: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface SecretRefRecord {
  id: number;
  provider: string;
  refKey: string;
  cipherText: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AppAuthClaims {
  sub: number;
  username: string;
  displayName: string;
  role: string;
  status: string;
  ver: number;
  scope: AuthScope;
  tenantId?: number;
  membershipRole?: TenantMembershipRole;
  systemRole?: SystemUserRole;
}
