# 客户交付手册

本文档面向 `v2.0.0` 企业级版本，用于指导客户完成部署、初始化、试运行、验收和日常运维。

## 交付材料

- 源码仓库和发布包。
- `.env.example`、`.env.development`、`.env.staging`、`.env.production`。
- Docker、VPS、Nginx 和回滚文档。
- v2 发布说明、支持边界、验收清单、试运行记录和架构蓝图。
- OpenAPI、备份恢复、数据库运维、生产可观测性和事故响应文档。

## 发布打包

```bash
npm install
npm run release:v2
```

发布包输出：

```text
output/releases/sale-compass-v2.0.0-<timestamp>/
output/releases/sale-compass-v2.0.0-<timestamp>.zip
```

## 私有化交付

1. 配置 `APP_DEPLOYMENT_MODE=private`。
2. 配置管理员初始化账号。
3. 本地演示可使用 SQLite。
4. 正式企业环境建议使用 PostgreSQL。
5. 执行 `npm run preflight`。
6. 执行 `npm run start`。
7. 使用管理员账号登录并完成店铺接入。

## SaaS 交付

1. 配置 `APP_DEPLOYMENT_MODE=saas`。
2. 配置 `CONTROL_PLANE_DATABASE_URL`。
3. 配置租户业务库创建策略或连接引用。
4. 配置 `REDIS_URL`。
5. 启动 API 进程。
6. 启动 Worker 进程。
7. 使用平台账号创建租户并分配初始管理员。
8. 登录后选择租户进入业务后台。

## 生产验收

- 平台登录返回租户列表。
- 选租户后进入业务看板。
- 平台 token 不能访问业务接口。
- 租户 token 不能访问平台接口。
- 非成员不能进入租户。
- 租户业务数据不能跨租户读取。
- 队列任务可入队、重试、死信和审计。
- 备份恢复可按租户独立验证。

## 真实闲鱼接入前置条件

- 客户必须提供合法闲鱼账号和店铺授权。
- 客户必须确认自动化操作边界、频率限制和风控责任。
- 必须先完成测试店铺小流量试运行。
- 不提供绕过闲鱼风控、验证码、安全策略或平台规则的能力。

## 关键文档

- 发布说明：[v2-release-notes.md](./v2-release-notes.md)
- 支持边界：[v2-support-boundary.md](./v2-support-boundary.md)
- 验收清单：[v2-acceptance-checklist.md](./v2-acceptance-checklist.md)
- 试运行记录：[v2-pilot-run.md](./v2-pilot-run.md)
- 架构蓝图：[v2-architecture-blueprint.md](./v2-architecture-blueprint.md)
- SaaS 基座：[saas-foundation.md](./saas-foundation.md)
- 部署说明：[deployment.md](./deployment.md)
- 回滚说明：[rollback.md](./rollback.md)

