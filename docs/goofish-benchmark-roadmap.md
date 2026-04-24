# 对标闲管家产品路线图

## 使用规则

- 当前整体架构蓝图见：[v2-architecture-blueprint.md](/D:/codex/goofish-sale-statistics/docs/v2-architecture-blueprint.md)。

- 本文档用于把项目从“企业级私有化后台”推进到“对标闲管家的商家运营 SaaS 平台”。
- 每个版本只在“代码完成 + 文档更新 + 相关构建/测试通过”后才允许把 `[ ]` 改成 `[x]`。
- 已完成项按当前仓库状态预先打勾，未完成项保持 `[ ]`。
- 每一轮优先推进当前版本；当前版本未完成前，不把下一个版本视为正式开始。

## 版本总览

| 版本 | 版本名 | 目标 | 状态 |
| --- | --- | --- | --- |
| `v1.0` | 私有化交付版 | 把当前项目收口成可部署、可验收、可交付的企业级私有化版本 | [x] |
| `v1.1` | SaaS 控制面基础版 | 建立租户、平台账号、租户会话、平台管理接口的 SaaS 底座 | [ ] 当前版本 |
| `v1.2` | 多店铺运营版 | 支持一个租户管理多个闲鱼店铺、多个操作员、多个经营分组 | [ ] |
| `v1.3` | 商品与交易中台版 | 完成商品、订单、售后、资金的统一运营中台 | [ ] |
| `v1.4` | 自动化履约版 | 把同步、发货、续登、备份等任务迁入队列与 Worker | [ ] |
| `v1.5` | 开放平台版 | 提供 ERP、自研系统、Webhook、开放接口能力 | [ ] |
| `v1.6` | 协同客服版 | 建立客服工作台、会话协同、快捷回复、风险操作保护 | [ ] |
| `v2.0` | 企业级 SaaS 正式版 | 完成 PostgreSQL、Redis、Worker、测试矩阵、可观测性与安全治理闭环 | [ ] |

## `v1.0` 私有化交付版 `[x]`

### 版本目标

把当前仓库收口为首个可交付的企业级私有化版本，具备真实部署、初始化、安全权限、店铺接入、订单售后和发布交付能力。

### 功能与交付清单

- [x] 完成前后端可运行、可构建、可打包的基础工程。
- [x] 完成 `demo / staging / prod` 运行模式切分。
- [x] 完成管理员初始化、健康检查、部署文档、升级回滚文档。
- [x] 完成管理员、运营、客服、财务四类基础角色能力。
- [x] 完成店铺接入、授权会话、激活、状态管理、凭据校验基础链路。
- [x] 完成订单、售后、资金、卡密、AI 客服、AI 议价等首版模块。
- [x] 完成 `release:v1` 发布链路。

### 交付标志

- [x] 当前仓库已经具备首个企业级私有化交付版本。

## `v1.1` SaaS 控制面基础版 `[ ] 当前版本`

### 版本目标

把当前项目从“单租户私有化后台”升级为“具备 SaaS 控制面基础能力的多租户系统”，但暂不追求完整运营中台。

### 控制面与租户模型

- [x] 新增 `APP_DEPLOYMENT_MODE=private|saas`。
- [x] 建立 `platform_users`、`tenants`、`tenant_memberships`、`tenant_provisioning_jobs`、`secret_refs` 基础模型。
- [x] 增加平台接口前缀 `/api/platform/*`。
- [x] 支持租户创建、状态切换、成员管理、开通任务查询的基础接口。
- [x] 增加租户生命周期后台页面。
- [x] 增加租户成员管理页面。
- [x] 增加租户开通记录与失败重试页面。
- [ ] 增加租户配额、套餐、备注、启停策略字段。

### 认证与会话

- [x] 支持平台登录 `POST /api/auth/login`。
- [x] 支持选租户 `POST /api/auth/select-tenant`。
- [x] 平台作用域会话与租户作用域会话隔离。
- [x] 平台 token 禁止访问租户业务接口。
- [x] 租户 token 禁止访问平台接口。
- [x] 登录后增加“可访问租户列表”前端选择页。
- [x] 增加租户切换入口与当前租户展示。
- [ ] 增加平台管理员重置租户管理员密码能力。

### 数据与基础设施

- [x] 抽象 `DatabaseProvider`、`TenantDatabaseResolver`、`MigrationRunner`。
- [x] SaaS 模式下支持按租户解析业务数据库。
- [ ] 将租户业务库正式切换到 PostgreSQL。
- [ ] 将控制面数据库正式切换到 PostgreSQL。
- [ ] 增加租户数据库初始化与迁移状态管理。
- [ ] 提供 `SQLite private -> PostgreSQL private` 离线迁移工具。

### 验收清单

- [x] 已有 SaaS 认证与隔离测试基线。
- [x] 平台控制面前端页面可用。
- [x] 租户开通全链路从接口扩展到后台可操作闭环。
- [ ] `private` 与 `saas` 两种部署模式都有发布验收记录。

## `v1.2` 多店铺运营版 `[ ]`

### 版本目标

让“一个租户 = 一个企业客户”真正拥有类似闲管家的多店铺运营能力，而不是只有单店铺接入。

### 店铺与组织模型

- [ ] 支持一个租户绑定多个闲鱼店铺。
- [ ] 支持店铺分组、标签、备注、负责人。
- [ ] 支持店铺启用、停用、冻结、掉线、异常等状态。
- [ ] 支持店铺授权过期提醒与批量续登入口。
- [ ] 支持店铺级权限范围控制。
- [ ] 支持按店铺查看最近同步时间、最近异常时间、健康状态。

### 协同与配额

- [ ] 支持一个租户下多个操作员协同管理店铺。
- [ ] 支持租户维度店铺数量配额。
- [ ] 支持操作员店铺授权范围分配。
- [ ] 支持“谁在管理哪个店铺”的在线状态标记。
- [ ] 支持租户管理员查看店铺使用情况和席位占用。

### 运营视角

- [ ] 增加多店铺总览页。
- [ ] 增加按店铺、分组、负责人维度的经营筛选。
- [ ] 增加待处理事项中心，聚合掉线、异常、待授权、待同步。
- [ ] 增加店铺批量操作能力。

### 验收清单

- [ ] 单租户至少可稳定管理 `10+` 店铺。
- [ ] 店铺之间数据、权限、任务不混淆。
- [ ] 多操作员同时进入系统时，状态与操作可追踪。

## `v1.3` 商品与交易中台版 `[ ]`

### 版本目标

把商品、订单、售后、资金从“分散模块”升级成真正可运营的交易中台，接近目标平台的核心使用体验。

### 商品中心

- [ ] 支持商品草稿、待发布、处理中、销售中、下架、售罄等状态流转。
- [ ] 支持批量发布、批量下架、批量设置、批量同步。
- [ ] 支持商品图片、标题、描述、发货地、规格、库存、编码管理。
- [ ] 支持定时发布、重新发布、自动上架等运营功能。
- [ ] 支持商品失败原因查看与重试。

### 订单中心

- [ ] 支持订单自动同步与手动补同步。
- [ ] 支持订单明细、筛选、导出、批量发货。
- [ ] 支持订单来源店铺、订单状态、物流状态、履约状态统一展示。
- [ ] 支持订单与商品、买家、客服会话联动。
- [ ] 支持订单异常队列与处理记录。

### 售后中心

- [ ] 支持仅退款、退货退款、拒绝退款、同意退货、确认收货退款。
- [ ] 支持售后状态机与超时提醒。
- [ ] 支持售后原因、责任归属、处理记录与证据留存。
- [ ] 支持售后与订单、资金联动。

### 资金中心

- [ ] 支持收支流水、退款流水、履约成本、利润口径统一。
- [ ] 支持账单查询、对账、异常资金标记。
- [ ] 支持按店铺、商品、时间范围的资金分析。
- [ ] 支持提现、结算、对账状态管理。

### 报表与经营看板

- [ ] 支持今日统计、近 7 日、近 30 日经营指标。
- [ ] 支持店铺、商品、客户、售后、客服等多维报表。
- [ ] 支持趋势分析、排行分析、来源分析、转化分析。
- [ ] 支持 CSV 导出与定时导出任务。

### 验收清单

- [ ] 商品、订单、售后、资金四大中心使用同一套状态与审计口径。
- [ ] 能支撑一个租户多店铺的日常经营操作。
- [ ] 关键操作具备批量处理能力和失败回溯能力。

## `v1.4` 自动化履约版 `[ ]`

### 版本目标

把所有关键后台任务从 API 进程中迁出，形成企业级稳定运行的异步任务体系。

### 基础设施

- [ ] 引入 Redis。
- [ ] 引入统一队列系统。
- [ ] 引入独立 Worker 进程。
- [ ] 为任务引入 `tenantId`、`jobId`、幂等键、重试、死信、审计、指标。
- [x] 履约任务已抽象为 `sqlite|redis` 可切换队列后端。
- [ ] Redis 实例接入运行时并完成联调验收。

### 迁移任务

- [x] 自动备份迁移到 Worker。
- [x] 店铺凭据校验迁移到 Worker。
- [x] 浏览器续登迁移到 Worker。
- [x] 商品同步迁移到 Worker。
- [x] 订单同步迁移到 Worker。
- [x] AI 客服同步迁移到 Worker。
- [x] AI 议价同步迁移到 Worker。
- [x] 运维巡检任务迁移到 Worker。

### 履约能力

- [x] 卡密自动发货迁移到任务体系。
- [x] 直充自动发货迁移到任务体系。
- [x] 失败补发与重试流程迁移到任务体系。
- [x] 人工接管流程迁移到任务体系。
- [ ] 任务状态回写到订单、售后、资金、审计体系。

### 验收清单

- [ ] API 进程不再长期跑核心后台定时任务。
- [ ] Worker 重启后，任务可恢复。
- [ ] 任务失败有死信收敛和人工处理入口。

## `v1.5` 开放平台版 `[ ]`

### 版本目标

提供类似目标平台“第三方 ERP / 自研系统接入”的开放能力，让平台不只是一套后台，而是业务中枢。

### 开放接口

- [ ] 发布平台控制面 OpenAPI。
- [ ] 发布租户业务 OpenAPI。
- [ ] 提供商品同步接口。
- [ ] 提供订单同步接口。
- [ ] 提供发货回传接口。
- [ ] 提供库存变更接口。
- [ ] 提供状态回调与 Webhook。

### 接入治理

- [ ] 支持应用凭据管理。
- [ ] 支持签名验签、时间戳、防重放。
- [ ] 支持回调重试与回调日志。
- [ ] 支持接口限流与配额。
- [ ] 支持应用级审计日志。

### 集成生态

- [ ] 支持第三方 ERP 对接配置。
- [ ] 支持自研系统接入流程。
- [ ] 支持接入文档、示例代码、联调验收清单。
- [ ] 支持应用市场或接入列表页。

### 验收清单

- [ ] 第三方系统可不登录后台，仅通过 API 完成商品、订单、发货链路联调。
- [ ] 回调失败、重试、签名错误都有完整记录。

## `v1.6` 协同客服版 `[ ]`

### 版本目标

补齐目标平台非常关键的一块能力：多账号客服协同与会话工作台。

### 会话工作台

- [ ] 增加客服会话列表。
- [ ] 增加买家详情、商品上下文、订单上下文联动侧栏。
- [ ] 增加快捷回复、话术模板、常见问题库。
- [ ] 增加多店铺会话切换能力。
- [ ] 增加未读、待跟进、超时未回复等队列视图。

### 协同与安全

- [ ] 支持客服席位分配与在线状态。
- [ ] 支持“当前谁在接待该买家”的占用标记。
- [ ] 支持高风险操作密码校验。
- [ ] 支持客服操作日志和质检记录。
- [ ] 支持客服绩效统计与响应时长统计。

### 形态规划

- [ ] 先完成 Web 客服工作台。
- [ ] 评估是否需要 Electron 客户端。
- [ ] 如果进入桌面端，补齐消息通知、快捷键、剪贴板图片发送等能力。

### 验收清单

- [ ] 多客服协同不会重复接待或误操作。
- [ ] 客服会话能联动订单与商品，减少来回切页。

## `v2.0` 企业级 SaaS 正式版 `[ ]`

### 版本目标

让产品从“功能接近目标平台”升级为“真正可规模化运营、可运维、可治理、可审计”的企业级 SaaS 正式版本。

### 数据与部署

- [ ] 控制面正式运行在 PostgreSQL。
- [ ] 租户业务库正式运行在 PostgreSQL。
- [ ] 私有化模式支持单租户 PostgreSQL。
- [ ] 提供正式迁移、回滚、校验、修复工具。
- [ ] 支持多实例部署与实例级健康检查。

### 可观测性与运维

- [ ] 建立日志、指标、链路追踪三件套。
- [ ] 建立告警中心与值班处理流程。
- [ ] 建立备份、恢复、演练、故障复盘流程。
- [ ] 建立容量评估、压测、性能基线。

### 安全治理

- [ ] 管理员 MFA。
- [ ] 密码复杂度与轮换策略。
- [ ] 高风险操作审批流。
- [ ] 租户级审计日志查询与导出。
- [ ] 密钥治理接口按 `SecretProvider` 统一。
- [ ] 为后续 KMS/Secret Manager 接入预留标准化适配层。

### 测试与交付

- [ ] `web` 增加单测。
- [ ] `web` 增加组件测试。
- [ ] `web` 增加 Playwright 冒烟测试。
- [ ] `server` 补齐多租户、任务、迁移、开放平台测试矩阵。
- [ ] CI 升级为 `private-demo`、`private-prod`、`saas-control-plane`、`saas-tenant-worker` 四套矩阵。
- [ ] 为发布建立正式版本门禁、变更记录、回滚门禁。

### 正式验收标志

- [ ] 支持企业客户正式开通租户。
- [ ] 支持租户稳定运营多个店铺。
- [ ] 支持任务外置、开放平台接入、协同客服、审计治理闭环。
- [ ] 支持私有化交付和 SaaS 交付两条产品线并行维护。

## 当前优先顺序

1. `v1.1` 补齐控制面前端、租户开通闭环、PostgreSQL 切换准备。
2. `v1.2` 完成多店铺运营中心。
3. `v1.3` 打通商品、订单、售后、资金中台。
4. `v1.4` 迁出任务到 `Redis + Queue + Worker`。
5. `v1.5` 做开放平台。
6. `v1.6` 做客服协同。
7. `v2.0` 做企业级正式收口。

## 2026-04-20 当前状态补充

- [x] SaaS 租户业务库 PostgreSQL 开通初始化
- [x] SaaS 租户 PostgreSQL 只读运行时第一阶段
- [x] `/api/options` 在租户 PostgreSQL 模式下可用
- [x] `/api/dashboard` 在租户 PostgreSQL 模式下可用
- [x] `/api/orders/overview` 在租户 PostgreSQL 模式下可用
- [x] `/api/orders`、`/api/orders/:orderId`、`/api/orders/export` 在租户 PostgreSQL 模式下可用
- [x] `smoke:saas:tenant-business-postgres` 验收链路
- [ ] 租户业务库剩余读接口继续切 PostgreSQL
- [ ] 租户业务库写链路正式切 PostgreSQL
- [ ] 去掉 SQLite shadow 兜底，完成真正的 tenant PostgreSQL runtime
## 2026-04-20 Additional Update

- [x] SaaS tenant PostgreSQL `workspace overview` first read path
- [x] SaaS tenant PostgreSQL `runWorkspaceAction`
- [x] SaaS tenant PostgreSQL `toggleWorkspaceRule`
- [x] SaaS tenant PostgreSQL `updateWorkspaceTaskStatus`
- [x] SaaS tenant PostgreSQL audit log write for migrated workspace actions
- [x] `smoke:saas:tenant-business-postgres` validates tenant workspace PostgreSQL writes
- [x] SaaS tenant PostgreSQL `system-monitoring alert status` write path
- [x] SQLite shadow mirror retained for `system-monitoring alert status` until `system-monitoring detail` migrates off `StatisticsDatabase`
- [x] `smoke:saas:tenant-business-postgres` validates tenant PostgreSQL system alert status persistence
- [x] `workspace detail` route can now prefer a tenant PostgreSQL `system-monitoring detail` reader when the adapter provides one at runtime
- [x] `smoke:saas:tenant-business-postgres` validates PostgreSQL primary write plus mirrored `system-monitoring detail` readback
- [x] `GET /api/metrics` no longer depends on eager `StatisticsDatabase.getSystemHealthSnapshot()` precompute
- [x] `system-monitoring` operational writes (`backups/run`, `log-archives/run`, `recovery-drills/run`) migrate off SQLite-primary execution
- [ ] tenant PostgreSQL adapter routes stop precomputing SQLite fallback payloads (`/api/options`, `/api/dashboard`, `/api/workspaces/:featureKey`, `/api/workspaces/:featureKey/detail`)
- [x] app-layer tenant routes (xianyu product/order sync) run tenant PostgreSQL primary writes with SQLite shadow retained as best-effort mirror
- [x] tenant PostgreSQL adapter surface exposes `getBusinessReports` and `exportBusinessReportsCsv` so `/api/reports*` stops calling `StatisticsDatabase`
- [x] tenant PostgreSQL adapter surface exposes `getProductsView` and `getCustomersView`
- [x] tenant PostgreSQL adapter surface exposes `getOrdersList`, `getOrderDetail`, and `exportOrdersCsv`
- [x] tenant PostgreSQL adapter surface exposes `getOrderFulfillmentWorkbench`, `getAfterSaleWorkbench`, `getAfterSaleCases`, and `getAfterSaleDetail`
- [x] tenant PostgreSQL workspace-fund write surface exposes `createFundWithdrawal`, `updateFundWithdrawalStatus`, and `updateFundReconciliationStatus`
- [x] tenant PostgreSQL open-platform management read surface exposes `getOpenPlatformAppsDetail`, `getOpenPlatformDocsDetail`, `getOpenPlatformSettingsDetail`, and `getOpenPlatformWhitelistDetail`
- [x] tenant PostgreSQL open-platform management write surface exposes `updateOpenPlatformAppStatus`, `updateOpenPlatformWhitelistRuleEnabled`, and `updateOpenPlatformSettings`
- [x] tenant PostgreSQL adapter surface exposes `listManagedStoreProductSyncTargets`, `syncManagedStoreProducts`, `listManagedStoreOrderSyncTargets`, and `syncManagedStoreOrders`
- [x] tenant PostgreSQL `system-monitoring` operational writes preserve the full side-effect set: filesystem artifacts, `system_*` run tables, `workspace_logs`, and `workspace_modules.updated_at`
- [ ] before removing `business_database_runtime`, finish tenant-aware AI auto-sync runtime wiring; `store-routes` and direct-charge/card fulfillment worker queue writes are now tenant PostgreSQL-first with SQLite shadow retained only for compatibility
