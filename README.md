# Sale Compass

Sale Compass 是面向闲鱼商家和企业客户的企业级运营平台，覆盖租户管理、店铺接入、订单中心、售后中心、资金中心、AI 客服、AI 议价、开放平台、队列 Worker、审计安全和生产运维。

当前主线已更新到 `v2.0.0`，定位为 SaaS + 私有化双模式企业版基线：

- `private` 模式：保留单租户私有化部署，兼容本地 SQLite 演示和单租户 PostgreSQL 正式库。
- `saas` 模式：提供控制面、平台账号、租户成员、租户作用域会话和每租户独立业务库。
- 正式企业基线：`PostgreSQL + Redis + Queue + Worker + OpenAPI + 审计 + MFA + 可观测性`。
- 发布链路：`lint`、测试、构建、私有化冒烟、SaaS 冒烟、PostgreSQL 冒烟、Redis 队列冒烟、Web 冒烟、Worker 干运行和交付打包。

## 核心能力

- 租户控制面：租户创建、暂停、恢复、成员管理、开通任务、数据库配置引用。
- 两段式认证：平台账号登录后选择租户，业务接口只接受租户作用域会话。
- 多店铺运营：租户下多店铺、多分组、多成员协同运营。
- 交易中台：订单、售后、资金、履约、卡密、直充、自有货源接入。
- AI 工作台：AI 客服、AI 议价、真实 IM 同步和任务化处理。
- 开放平台：应用、API Key、Webhook、开放接口审计。
- 生产运维：备份恢复、巡检、Prometheus 指标、结构化日志、发布回滚文档。

## 技术栈

- 后端：Node.js、TypeScript、Fastify、PostgreSQL、SQLite 兼容层、Redis、Worker。
- 前端：React、TypeScript、Vite、Ant Design、Vitest、Playwright 冒烟。
- 数据治理：控制面数据库、租户业务数据库、迁移 Runner、SecretProvider 接口。
- 交付治理：Docker Compose、CI 矩阵、OpenAPI 文档、发布包清单。

## 快速开始

```bash
cp .env.example .env
npm install
npm run dev
```

默认访问地址：

- 前端：`http://127.0.0.1:5173`
- 后端：`http://127.0.0.1:4300`

## 运行模式

私有化模式：

```bash
APP_DEPLOYMENT_MODE=private
npm run build
npm run preflight
npm run start
```

SaaS 模式：

```bash
APP_DEPLOYMENT_MODE=saas
CONTROL_PLANE_DATABASE_URL=postgres://...
REDIS_URL=redis://...
npm run build
npm run start
npm run worker -w server
```

## Docker 部署

```bash
cp .env.example .env
docker compose up -d --build
curl http://127.0.0.1:4300/api/health
```

VPS 环境可叠加：

```bash
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d --build
```

Nginx 示例：[deploy/nginx.sale-compass.conf](./deploy/nginx.sale-compass.conf)

## 版本发布

标准 v2 发布命令：

```bash
npm run release:v2
```

该命令串行执行：

- `npm run lint`
- `npm run test`
- `npm run build`
- `npm run smoke:release`
- `npm run smoke:saas`
- `npm run smoke:saas:postgres`
- `npm run smoke:saas:tenant-business-postgres`
- `npm run smoke:queue:redis`
- `npm run smoke:business-db:postgres`
- `npm run smoke:web:private`
- `npm run smoke:web:saas`
- `npm run worker:dry-run -w server`
- `npm run package:release`

标准输出目录：

```text
output/releases/sale-compass-v2.0.0-<timestamp>/
```

## 当前版本

- 当前版本：`v2.0.0`
- 发布日期：`2026-04-24`
- 当前定位：企业级 SaaS + 私有化双模式正式基线。

主要交付文档：

- [docs/v2-release-notes.md](./docs/v2-release-notes.md)
- [docs/v2-scope-freeze.md](./docs/v2-scope-freeze.md)
- [docs/v2-support-boundary.md](./docs/v2-support-boundary.md)
- [docs/v2-acceptance-checklist.md](./docs/v2-acceptance-checklist.md)
- [docs/v2-architecture-blueprint.md](./docs/v2-architecture-blueprint.md)
- [docs/v2-engineering-baseline.md](./docs/v2-engineering-baseline.md)

## 文档导航

- 项目总览：[docs/project-overview.md](./docs/project-overview.md)
- SaaS 基座：[docs/saas-foundation.md](./docs/saas-foundation.md)
- 架构蓝图：[docs/v2-architecture-blueprint.md](./docs/v2-architecture-blueprint.md)
- 工程基线：[docs/v2-engineering-baseline.md](./docs/v2-engineering-baseline.md)
- 接口文档：[docs/api.md](./docs/api.md)
- 部署说明：[docs/deployment.md](./docs/deployment.md)
- 安全模型：[docs/security-model.md](./docs/security-model.md)
- 备份恢复：[docs/backup-restore-runbook.md](./docs/backup-restore-runbook.md)
- 生产验收：[docs/production-acceptance.md](./docs/production-acceptance.md)
- 客户交付手册：[docs/customer-delivery-handbook.md](./docs/customer-delivery-handbook.md)

## License

本项目使用 [LICENSE](./LICENSE) 中声明的许可协议。
