# v2.0 工程基线

## 本轮已收口

- 已补齐 `web` 单元测试与页面组件测试。
- 已补齐浏览器级 Playwright 冒烟测试：
  - `npm run smoke:web:private`
  - `npm run smoke:web:saas`
- 已新增 `release:v2` 正式发布脚本，串联以下校验：
  - `lint`
  - `test`
  - `build`
  - `smoke:release`
  - `smoke:saas`
  - `smoke:web:private`
  - `smoke:web:saas`
  - `worker:dry-run`
  - `package:release`
- GitHub Actions 已升级为四套矩阵：
  - `private-demo`
  - `private-prod`
  - `saas-control-plane`
  - `saas-tenant-worker`
- `private-prod` 与 `saas-control-plane` 已接入浏览器烟测。
- 已引入后台作业运行模式 `APP_BACKGROUND_JOBS_MODE=embedded|worker|disabled`。
- SaaS 控制面存储层已抽成统一接口，当前支持 `SQLite | PostgreSQL` 双引擎切换入口。
- 已新增 `APP_CONTROL_PLANE_DB_ENGINE=sqlite|postgres` 与 `APP_CONTROL_PLANE_POSTGRES_URL`。
- 自动备份、店铺健康巡检、浏览器续登、AI 客服同步、AI 议价同步、闲鱼真实数据同步都已可由 API 进程或 `Worker` 接管。
- 履约链路已经切到“接口入队 + Worker 消费”的共享运行时。
- 已新增 `APP_QUEUE_BACKEND=sqlite|redis`、`APP_REDIS_URL`、`APP_REDIS_PREFIX`，履约任务支持 `sqlite|redis` 可切换队列后端。

## 当前验证口径

- `npm run test`
  - `server` 全量测试
  - `web` 单元与组件测试
- `npm run smoke:release`
  - 私有化登录与基础接口
- `npm run smoke:saas`
  - 平台登录
  - 创建租户
  - 平台会话与租户会话隔离
  - 选租户后访问业务接口
- `npm run smoke:web:private`
  - 私有化浏览器登录
  - 工作台布局渲染
  - 仪表盘首页渲染
- `npm run smoke:web:saas`
  - SaaS 浏览器登录
  - 租户选择
  - SaaS 工作台布局渲染
  - 仪表盘首页渲染
- `npm run worker:dry-run -w server`
  - 配置加载
  - 目录准备
  - 单次启动检查
  - `worker` 模式下的后台作业装配

## 当前已经具备的工程能力

- SaaS 控制面与租户作用域认证
- 控制面数据库双引擎入口
- 前端 SaaS 控制台页面
- `web` 测试基线
- `server` 测试基线
- API 与浏览器双层烟测
- `Worker` 进程基线
- API 进程与 `Worker` 进程的后台作业切换开关
- 自动备份后台作业模块化
- 店铺健康巡检与浏览器续登模块化
- AI 客服与 AI 议价后台作业模块化
- 闲鱼真实商品/订单同步后台作业模块化
- 履约任务的统一入队与消费基线
- 可切换的履约队列后端

## 当前仍未完成

- PostgreSQL 正式替换当前 SQLite 运行时
- Redis 队列的真实联调验收
- 商品、订单、售后、资金的完整中台化拆分
- 多店铺运营中心
- 开放平台正式接口
- 管理员 MFA、密钥治理、可观测性闭环

## 2026-04-20 增量进展

- 已打通 SaaS 租户业务库的 PostgreSQL 开通落库链路，租户创建时可以直接把业务库初始化到 PostgreSQL。
- 已新增租户业务库的 PostgreSQL 只读适配器，`/api/options`、`/api/dashboard`、`/api/orders/overview`、`/api/orders`、`/api/orders/:orderId`、`/api/orders/export` 这些读链路在 SaaS 租户 PostgreSQL 模式下会优先走 PostgreSQL。
- 当前租户业务库运行态升级为“PostgreSQL 读 + SQLite shadow 兜底”的 hybrid 模式；这不是最终正式版架构，但已经不是纯 SQLite 运行时。
- 已新增 `npm run smoke:saas:tenant-business-postgres`，会验收：
  - 平台登录
  - 租户创建
  - 租户切换
  - 租户 PostgreSQL 库表初始化
  - `/api/options`
  - `/api/dashboard`
  - `/api/orders/overview`
## 2026-04-20 Additional Update

- SaaS tenant PostgreSQL now serves `/api/workspaces/:featureKey` for migrated workspace features.
- Tenant PostgreSQL write path now covers `runWorkspaceAction`, `toggleWorkspaceRule`, `updateWorkspaceTaskStatus`, and tenant audit log writes.
- `smoke:saas:tenant-business-postgres` now validates tenant workspace PostgreSQL writes end to end.
- Tenant PostgreSQL write path now also covers `POST /api/workspaces/system-monitoring/alerts/:alertId/status`.
- The system alert status route keeps SQLite shadow mirror writes enabled because `system-monitoring detail`, metrics, and archive flows still read from `StatisticsDatabase`.
- `smoke:saas:tenant-business-postgres` now validates tenant PostgreSQL system alert status persistence and the corresponding `workspace_logs` write.
- `/api/workspaces/:featureKey/detail` is now wired to prefer a tenant PostgreSQL system-monitoring detail reader when the adapter exposes one at runtime; otherwise it safely falls back to the existing SQLite shadow detail path.
- `smoke:saas:tenant-business-postgres` now reports `tenantSystemAlertShadowDetailVerified`, proving the PostgreSQL primary write is visible through the mirrored `system-monitoring detail` read path.

## 2026-04-20 SQLite Shadow Checklist

- `/api/metrics` still renders `healthSnapshot: db.getSystemHealthSnapshot()`, so tenant PostgreSQL runtime still falls back to `StatisticsDatabase.getSystemHealthSnapshot()` and `syncSystemMonitoringAlerts()`.
- `system-monitoring` operational writes are still SQLite-primary in tenant mode:
  - `POST /api/workspaces/:featureKey/backups/run` -> `db.runSystemBackup(...)`
  - `POST /api/workspaces/:featureKey/log-archives/run` -> `db.runSystemLogArchive(...)`
  - `POST /api/workspaces/:featureKey/recovery-drills/run` -> `db.runSystemRecoveryDrill(...)`
- Some tenant PostgreSQL routes are still SQLite-dependent because they precompute a fallback payload before calling the adapter:
  - `GET /api/options` -> `adapter.getFilterOptions(db.getFilterOptions())`
  - `GET /api/dashboard` -> `adapter.getDashboard(query, db.getDashboard(query))`
  - `GET /api/workspaces/:featureKey` -> `adapter.getWorkspaceOverview(featureKey, db.getWorkspaceOverview(...))`
  - `GET /api/workspaces/:featureKey/detail` -> `getTenantWorkspaceDetail(..., db.getWorkspaceBusinessDetail(...))`
- Tenant PostgreSQL read/write coverage is still incomplete at the app layer. The Xianyu product/order sync, store-auth writes, supply-source execution, and direct-charge/card worker queue routes now run tenant PostgreSQL primary writes with SQLite shadow retained as best-effort mirror; the remaining runtime blocker is tenant-aware AI auto-sync wiring.
  - `GET /api/orders/workbench/fulfillment`
  - `GET /api/after-sales/workbench`
  - `GET /api/after-sales`
  - `GET /api/after-sales/:caseId`
- Launch gating is still blocked by runtime design, not by smoke coverage:
  - `DatabaseProvider.getRuntimeSummary().tenantDatabase.runtimeEngine === 'hybrid'`
  - unsupported tenant routes still fall back to SQLite shadow storage
  - enterprise launch readiness still treats `business_database_runtime` as incomplete

## 2026-04-20 Blocker Deep Dive

### Tenant PostgreSQL adapter gaps

- `products`
  - `GET /api/products` is already tenant PostgreSQL-aware.
  - `POST /api/products/xianyu-web-sync` now uses tenant PostgreSQL `listManagedStoreProductSyncTargets(...)` and `syncManagedStoreProducts(...)` first.
- `customers`
  - `GET /api/customers` is already tenant PostgreSQL-aware.
  - There is no remaining standalone customer read blocker in the current tenant PG checklist.
- `orders`
  - `/api/orders`、`/api/orders/:orderId`、`/api/orders/export` are now tenant PostgreSQL-aware.
  - `POST /api/orders/xianyu-web-sync` now uses tenant PostgreSQL `listManagedStoreOrderSyncTargets(...)` and `syncManagedStoreOrders(...)` first.

### `system-monitoring` operational write side effects

- `GET /api/metrics`
  - Tenant PostgreSQL now computes `healthSnapshot` from the adapter first and only lazily falls back to `StatisticsDatabase` if the adapter is unavailable at runtime.
- `POST /api/workspaces/:featureKey/backups/run`
  - Tenant PostgreSQL now owns the primary execution path and preserves backup artifact generation, `system_backup_runs`, `workspace_logs`, `workspace_modules.updated_at`, and the outer audit log write.
- `POST /api/workspaces/:featureKey/log-archives/run`
  - Tenant PostgreSQL now owns the primary execution path and preserves archive artifact generation, `system_log_archives`, `workspace_logs`, `workspace_modules.updated_at`, and the outer audit log write.
- `POST /api/workspaces/:featureKey/recovery-drills/run`
  - Tenant PostgreSQL now owns the primary execution path and preserves backup lookup plus fallback backup creation, recovery drill artifact generation, `system_recovery_drills`, `workspace_logs`, `workspace_modules.updated_at`, and the outer audit log write.
- `smoke:saas:tenant-business-postgres`
  - Now validates tenant PostgreSQL primary writes for `backups/run`, `log-archives/run`, `recovery-drills/run`, and the matching Prometheus metrics surface.
  - Now also validates tenant PostgreSQL primary writes for `workspace-fund` (`withdrawals`, `withdrawal status`, `reconciliation status`).
  - Now also validates tenant PostgreSQL primary reads for open-platform management `apps/docs/settings/whitelist`.
  - Now also validates tenant PostgreSQL primary writes for open-platform management `apps/:appId/status`, `whitelist/:ruleId/enabled`, and `settings`, with SQLite shadow retained as best-effort mirror only.

### `business_database_runtime` gate estimate

- Checklist view
  - After the currently documented blockers, removing `business_database_runtime` is still about two to three delivery rounds away:
    1. finish the missing tenant PostgreSQL adapter/read-write capabilities and cut the named SQLite fallback routes;
    2. reduce shadow-precompute and shadow-mirror behavior where it is no longer needed;
    3. flip the runtime summary and launch gate once tenant routes no longer depend on SQLite shadow storage.
- Codebase view
  - The real remaining scope is larger than the current checklist.
- `orders-routes.ts` now runs overview/list/detail/export plus fulfillment workbench and after-sales workbench/list/detail on tenant PostgreSQL, but fulfillment mutations still stay on `StatisticsDatabase`.
- `workspace-fund` writes and open-platform management reads/writes are now tenant PostgreSQL-aware.
- Several tenant business route modules (`workspace-ai-*`, `workspace-fulfillment`, `store-routes`) still have no tenant PostgreSQL path, and open-platform public verify/logging still stay on `StatisticsDatabase`.
- If the gate means "tenant business runtime no longer depends on SQLite shadow", the safer estimate is still two rounds minimum rather than one.

## 2026-04-24 AI Runtime Tail Status

- `workspace-ai-service-routes.ts`
  - `POST /api/workspaces/:featureKey/service-sync` is tenant PostgreSQL-first.
  - `POST /api/workspaces/:featureKey/conversations/:conversationId/ai-reply` and `manual-reply` now use a tenant-aware dispatch helper when the adapter exposes the required methods, with SQLite kept only as best-effort shadow mirror.
- `workspace-ai-bargain-routes.ts`
  - `POST /api/workspaces/:featureKey/bargain-sync` is now tenant PostgreSQL-first.
  - The route fetches real Xianyu sessions, writes refreshed cookie/auth cache through the tenant adapter first, and mirrors back to SQLite shadow.
- `ai-service-runtime.ts` and `ai-bargain-runtime.ts`
  - Both runtimes still accept a `StatisticsDatabase` as their primary dependency.
  - Both runtimes now expose optional `runtimeHooks` so tenant-aware sync target listing and sync execution can be injected without rewriting the runtime bodies.
- Remaining blocker
  - The new AI runtime hook path is not active until `app.ts` and `worker.ts` pass tenant-aware hook delegates into `createAiServiceRuntime(...)` and `createAiBargainRuntime(...)`.
- Because that wiring still lives outside the migrated files, `database-provider` continues to report the pending capabilities as `ai-service auto-sync runtime wiring` and `ai-bargain auto-sync runtime wiring`.

## 2026-04-24 Store Auth And Fulfillment Tail Status

- Store auth session writes are now tenant PostgreSQL-first for session create/detail/complete, web-session sync, profile detection credential reads, and credential-event recording.
- Direct-charge and card fulfillment worker routes now write tenant PostgreSQL business state first, then keep SQLite shadow queue payloads only for current queue compatibility.
- The tenant PostgreSQL smoke validates `tenantStoreAuthSession*`, `tenantDirectChargeQueueWriteVerified`, `tenantDirectChargeManualReviewQueueWriteVerified`, `tenantCardFulfillmentQueueWriteVerified`, and `tenantCardOutboundResendQueueWriteVerified`.
