# SaaS 基线实现说明

## 已落地能力

- 支持 `APP_DEPLOYMENT_MODE=private|saas`
- `private` 模式保持原有单租户私有化认证与业务接口
- `saas` 模式新增控制面数据库与租户业务库解析能力
- 控制面已落地核心模型：
  - `platform_users`
  - `tenants`
  - `tenant_memberships`
  - `tenant_provisioning_jobs`
  - `secret_refs`
  - `control_plane_audit_logs`
- 认证改为双阶段：
  - `POST /api/auth/login` 返回平台会话和可访问租户列表
  - `POST /api/auth/select-tenant` 选择租户并签发租户作用域会话
- 平台接口前缀已生效：
  - `GET /api/platform/tenants`
  - `POST /api/platform/tenants`
  - `POST /api/platform/tenants/:tenantId/status`
  - `GET /api/platform/tenants/:tenantId/memberships`
  - `POST /api/platform/tenants/:tenantId/memberships`
  - `GET /api/platform/provisioning-jobs`
- 平台作用域 token 访问业务接口会被拒绝
- 租户作用域 token 访问平台接口会被拒绝
- 业务库访问已通过 `DatabaseProvider`、`TenantDatabaseResolver`、`MigrationRunner` 抽象解耦

## 新增配置

- `APP_DEPLOYMENT_MODE`
- `APP_CONTROL_PLANE_DB_PATH`
- `APP_TENANT_DB_ROOT`

## 当前边界

- 当前控制面和租户业务库仍使用 SQLite 落地，以保证现有交付链路和测试体系稳定
- PostgreSQL、Redis、队列、独立 Worker 已完成边界抽象，但尚未切入运行时实现
- 店铺同步、自动备份、真实数据轮询在 `saas` 模式下仍未迁入 Worker，因此已保持关闭

## 下一阶段

- 控制面和租户业务库切换到 PostgreSQL
- 引入 Redis 队列与独立 Worker
- 将自动备份、店铺凭据校验、商品订单同步、AI 同步迁出 API 进程
- 继续拆 `orders / after-sales / funds / ai-service / ai-bargain` 写侧边界
