// API 模块统一入口
// 从各子模块聚合 re-export，确保现有 import 路径向后兼容

// 类型定义
export * from './types/auth.types';
export * from './types/dashboard.types';
export * from './types/order.types';
export * from './types/after-sale.types';
export * from './types/product.types';
export * from './types/store.types';
export * from './types/workspace.types';
export * from './types/open-platform.types';
export * from './types/filter.types';

// 工具函数
export { apiRequest, buildQuery } from './client';
