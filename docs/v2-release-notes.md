# v2.0.0 发布说明

- 版本号：`2.0.0`
- 发布日期：`2026-04-24`
- 发布命令：`npm run release:v2`
- 版本定位：企业级 SaaS + 私有化双模式正式基线。

## 本次交付

- 新增 `APP_DEPLOYMENT_MODE=private|saas`，保留私有化兼容并启用 SaaS 控制面。
- 新增控制面模型：租户、平台账号、租户成员、开通任务、密钥引用。
- 新增两段式认证：平台登录后选择租户，业务接口使用租户作用域会话。
- 新增每租户独立业务库治理，正式基线支持 PostgreSQL，SQLite 保留本地和演示兼容。
- 新增 Redis 队列与独立 Worker，覆盖同步、备份、凭据校验、AI 任务和运维巡检。
- 新增多店铺运营中心、开放平台、Webhook、API Key 和租户级审计。
- 新增 MFA、密码策略、敏感密钥接口、可观测性和生产验收闭环。
- 新增前端私有化与 SaaS 冒烟，发布链路升级为 v2 全量门禁。

## 交付产物

- 交付包目录：`output/releases/sale-compass-v2.0.0-<timestamp>/`
- 交付压缩包：`output/releases/sale-compass-v2.0.0-<timestamp>.zip`
- 清单文件：`release-manifest.json`

## 运行要求

- 私有化演示可继续使用 SQLite。
- 企业正式私有化建议使用 PostgreSQL。
- SaaS 模式必须配置 PostgreSQL 控制面库、租户业务库和 Redis。
- Worker 必须作为独立进程运行，API 进程只负责入队和查询状态。

## 验收门禁

- `npm run release:v2` 必须完整通过。
- 新租户创建、选租户登录、租户业务库初始化、任务入队、Worker 干运行和 Web 冒烟必须成功。
- 租户 token 访问平台接口必须失败，平台 token 访问业务接口必须失败。
- 跨租户数据访问必须失败。

