// 认证与 SaaS 控制面相关类型

export type SystemUserRole = 'admin' | 'operator' | 'support' | 'finance';
export type SystemUserStatus = 'active' | 'disabled';
export type PlatformUserRole = 'platform_admin' | 'platform_operator';
export type PlatformUserStatus = 'active' | 'disabled';
export type AuthScope = 'private' | 'platform' | 'tenant';
export type TenantStatus = 'provisioning' | 'active' | 'suspended';
export type TenantMembershipRole = 'owner' | 'admin' | 'member' | 'support';

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  role: SystemUserRole;
  status: SystemUserStatus;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

export interface PlatformAuthUser {
  id: number;
  username: string;
  displayName: string;
  role: PlatformUserRole;
  status: PlatformUserStatus;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  passwordChangedAt: string | null;
}

export interface TenantSummary {
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

export interface TenantMembership {
  id: number;
  tenantId: number;
  platformUserId: number;
  membershipRole: TenantMembershipRole;
  systemRole: SystemUserRole;
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
}

export interface TenantAccessItem {
  membership: TenantMembership;
  tenant: TenantSummary;
}

export interface PrivateSessionResponse {
  token: string;
  expiresAt: string;
  scope: 'private';
  user: AuthUser;
}

export interface PlatformSessionResponse {
  token: string;
  expiresAt: string;
  scope: 'platform';
  user: PlatformAuthUser;
  memberships: TenantAccessItem[];
  nextStep?: 'select_tenant';
}

export interface PlatformMfaChallengeResponse {
  scope: 'platform_mfa';
  challengeToken: string;
  expiresAt: string;
  user: PlatformAuthUser;
  nextStep: 'verify_mfa';
}

export interface TenantSessionResponse {
  token: string;
  expiresAt: string;
  scope: 'tenant';
  user: AuthUser;
  tenant: TenantSummary;
  membership: TenantMembership;
}

export type LoginResponse =
  | PrivateSessionResponse
  | PlatformSessionResponse
  | TenantSessionResponse
  | PlatformMfaChallengeResponse;

export interface PrivateAuthProfileResponse {
  scope: 'private';
  user: AuthUser;
}

export interface PlatformAuthProfileResponse {
  scope: 'platform';
  user: PlatformAuthUser;
  memberships: TenantAccessItem[];
}

export interface TenantAuthProfileResponse {
  scope: 'tenant';
  user: AuthUser;
  platformUser: PlatformAuthUser;
  tenant: TenantSummary;
  membership: TenantMembership;
  memberships: TenantAccessItem[];
}

export type AuthProfileResponse =
  | PrivateAuthProfileResponse
  | PlatformAuthProfileResponse
  | TenantAuthProfileResponse;

export interface PlatformTenantListResponse {
  list: TenantSummary[];
}

export interface PlatformTenantCreateResponse {
  tenant: TenantSummary | null;
  provisioningJob: PlatformProvisioningJob | null;
}

export interface PlatformTenantMembershipListResponse {
  tenant: TenantSummary;
  list: Array<{
    membership: TenantMembership;
    user: PlatformAuthUser;
  }>;
}

export interface PlatformUserListResponse {
  list: PlatformAuthUser[];
}

export interface PlatformProvisioningJob {
  id: number;
  tenantId: number;
  jobType: 'tenant_bootstrap';
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  detail: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface PlatformProvisioningJobListResponse {
  list: PlatformProvisioningJob[];
}

export interface PlatformMfaStatusResponse {
  enabled: boolean;
  user: PlatformAuthUser;
  secretRefId: number | null;
  updatedAt: string | null;
}

export interface PlatformMfaSetupResponse {
  enabled: boolean;
  pendingSecretRefId: number | null;
  otpAuthUrl: string;
  manualEntryKey: string;
  qrCodeDataUrl: string;
}
