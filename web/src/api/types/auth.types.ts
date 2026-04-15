// 认证相关类型定义

export type SystemUserRole = 'admin' | 'operator' | 'support' | 'finance';
export type SystemUserStatus = 'active' | 'disabled';

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

export interface LoginResponse {
  token: string;
  expiresAt: string;
  user: AuthUser;
}

export interface AuthProfileResponse {
  user: AuthUser;
}
