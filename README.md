# Sale Compass

Sale Compass 是一个面向私有化部署的企业级闲鱼电商运营后台，覆盖店铺接入、订单中心、商品中心、售后中心、资金中心、AI 客服、AI 议价、运维监控与发布交付链路。

当前仓库已经收口到 `v1.0.0`，具备以下交付特征：
- 可直接本地运行、Docker 部署和标准打包发布
- 内置登录鉴权、角色隔离、审计日志、敏感配置加密
- 支持闲鱼网页登录态接入、店铺授权与凭据事件时间线
- 支持 `lint`、测试、构建、冒烟检查、发布打包一体化执行

## 核心能力

- 店铺接入：授权会话、网页登录态接入、资料同步、绑店激活、凭据校验、续登记录
- 交易中台：订单中心、商品中心、售后中心、资金中心、报表中心
- 履约能力：卡密发货、直充发货、自有货源接入
- AI 工作台：AI 客服、AI 议价、真实 IM 会话同步
- 运维治理：健康检查、Prometheus 指标、备份恢复、恢复演练、预检脚本

## 技术栈

- 后端：Node.js、TypeScript、Fastify、better-sqlite3
- 前端：React、TypeScript、Vite、Ant Design
- 质量保障：ESLint、Vitest、发布冒烟脚本
- 部署方式：本地运行、Docker Compose、Ubuntu VPS

## 快速开始

```bash
cp .env.example .env
npm install
npm run dev
```

默认访问地址：
- 前端：`http://127.0.0.1:5173`
- 后端：`http://127.0.0.1:4300`

## 生产运行

```bash
npm run build
npm run preflight
npm run start
```

常用运维命令：

```bash
npm run db:inspect
npm run db:doctor
npm run smoke:release
```

## Docker 部署

```bash
cp .env.example .env
docker compose up -d --build
curl http://127.0.0.1:4300/api/health
```

如果是 VPS 环境，可结合：

```bash
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d --build
```

Nginx 路径代理示例见：
[deploy/nginx.sale-compass.conf](./deploy/nginx.sale-compass.conf)

## 管理员初始化

首次启动会根据 `.env` 中的初始化参数创建管理员账号：

- 用户名：`APP_INIT_ADMIN_USERNAME`
- 密码：`APP_INIT_ADMIN_PASSWORD`

默认 `prod` 模式不会自动注入演示数据。  
如果需要本地演示数据，请显式启用：

- `APP_RUNTIME_MODE=demo`
- `APP_ENABLE_DEMO_DATA=true`

## 版本发布

标准发布命令：

```bash
npm run release:v1
```

该命令会串行执行：
- `npm run lint`
- `npm run test`
- `npm run build`
- `npm run smoke:release`
- `npm run package:release`

标准输出目录：

```text
output/releases/sale-compass-v1.0.0-<timestamp>/
```

## 当前版本

- 当前版本：`v1.0.0`
- 发布日期：`2026-04-15`
- 当前定位：首个可交付的企业级私有化版本

最新发布产物和说明：
- [docs/v1-release-notes.md](./docs/v1-release-notes.md)
- [docs/v1-support-boundary.md](./docs/v1-support-boundary.md)
- [docs/v1-known-issues.md](./docs/v1-known-issues.md)

## 文档导航

- 项目总览：[docs/project-overview.md](./docs/project-overview.md)
- 接口文档：[docs/api.md](./docs/api.md)
- 部署说明：[docs/deployment.md](./docs/deployment.md)
- 安全模型：[docs/security-model.md](./docs/security-model.md)
- 备份恢复：[docs/backup-restore-runbook.md](./docs/backup-restore-runbook.md)
- 生产验收：[docs/production-acceptance.md](./docs/production-acceptance.md)
- 企业改造路线图：[docs/enterprise-roadmap.md](./docs/enterprise-roadmap.md)

## 下一阶段

`v1.0.0` 已完成交付收口。下一阶段重点为：
- 继续拆分订单、售后、资金、AI 工作台仓储边界
- 拆分 `app.ts` 路由与应用服务边界
- 为 `web` 补齐前端测试、组件测试与冒烟测试
- 为接口治理补齐 OpenAPI 契约

## License

本项目使用 [LICENSE](./LICENSE) 中声明的许可协议。
