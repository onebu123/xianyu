export type DatePreset = 'today' | 'last7Days' | 'last30Days' | 'last90Days';
export type RuntimeMode = 'demo' | 'staging' | 'prod';
export type SystemUserRole = 'admin' | 'operator' | 'support' | 'finance';
export type SystemUserStatus = 'active' | 'disabled';
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
