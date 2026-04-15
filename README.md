# Sale Compass

Sale Compass 是一个基于开源组件二次开发的销售统计后台私有化交付版，覆盖销售总览、订单统计、商品分析、客户分析、筛选联动、CSV 导出，以及登录鉴权、角色隔离、审计日志与敏感配置加密等能力。

## 快速开始

```bash
cp .env.example .env
npm install
npm run dev
```

- 环境模板：`.env.development`、`.env.staging`、`.env.production`
- 前端：`http://127.0.0.1:5173`
- 后端：`http://127.0.0.1:4300`

## 生产运行

生产模式下由 Fastify 同时提供前端静态资源与 API：

```bash
npm run build
npm run preflight
npm run start
```

运维与发布命令：

```bash
npm run db:inspect
npm run db:doctor
npm run smoke:release
```

标准入口：

- 本机：`http://127.0.0.1:4300`
- 公网直连：`http://<VPS_IP>:4300`

## Docker 运行

1. 复制环境变量模板：

```bash
cp .env.example .env
```

2. 直接启动：

```bash
docker compose up -d --build
```

3. 健康检查：

```bash
curl http://127.0.0.1:4300/api/health
docker compose ps
```

也可以在启动前执行：

```bash
npm run preflight
```

## Ubuntu VPS 部署

默认推荐 Docker 部署，不使用 systemd 直跑。

### 标准模式

适用于云厂商允许公网直连 `4300/tcp` 的环境：

```bash
cp .env.example .env
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d --build
```

标准公网地址：`http://<VPS_IP>:4300`

### 当前阿里云 VPS 实际落地模式

当前这台阿里云 Ubuntu VPS 的公网 `4300` 链路没有真正到达 ECS 网卡，因此实际交付入口改为复用现有 `80` 端口，在不影响根路径业务的前提下挂载独立路径：

- 当前地址：`http://47.251.63.59/sale-compass/`
- Nginx 路径代理样例：[`deploy/nginx.sale-compass.conf`](./deploy/nginx.sale-compass.conf)

这一模式仍然由容器内应用监听 `127.0.0.1:4300`，只是在公网入口层通过 Nginx 转发到 `/sale-compass/`。

## 初始化管理员

首次启动不会再内置演示账号。默认登录账号取决于 `.env` 中的初始化配置：

- 用户名：`APP_INIT_ADMIN_USERNAME`
- 密码：`APP_INIT_ADMIN_PASSWORD`

## 数据说明

- 默认按 `prod` 模式启动，不会自动写入演示业务数据
- 首次启动只会根据 `.env` 创建初始化管理员
- 如需本地演示数据，必须显式切到 `demo` 模式并开启 `APP_ENABLE_DEMO_DATA=true`

## 标准交付打包

第 15 轮交付版可直接执行：

```bash
npm run release:v1
```

标准输出目录：

```text
output/releases/sale-compass-v1.0.0-<时间戳>/
```

## 文档

- 项目说明：[`docs/project-overview.md`](./docs/project-overview.md)
- API 文档：[`docs/api.md`](./docs/api.md)
- 安全模型：[`docs/security-model.md`](./docs/security-model.md)
- 安全验收记录：[`docs/security-acceptance.md`](./docs/security-acceptance.md)
- 开源依赖与许可证：[`docs/open-source-and-license.md`](./docs/open-source-and-license.md)
- 部署说明：[`docs/deployment.md`](./docs/deployment.md)
- 备份恢复手册：[`docs/backup-restore-runbook.md`](./docs/backup-restore-runbook.md)
- 数据库运维手册：[`docs/database-operations-runbook.md`](./docs/database-operations-runbook.md)
- 可观测说明：[`docs/production-observability.md`](./docs/production-observability.md)
- 生产化路线：[`docs/production-readiness-roadmap.md`](./docs/production-readiness-roadmap.md)
- 事件响应手册：[`docs/incident-response-runbook.md`](./docs/incident-response-runbook.md)
- 生产化验收：[`docs/production-acceptance.md`](./docs/production-acceptance.md)
- 升级说明：[`docs/upgrade.md`](./docs/upgrade.md)
- 回滚说明：[`docs/rollback.md`](./docs/rollback.md)
- 客户交付手册：[`docs/customer-delivery-handbook.md`](./docs/customer-delivery-handbook.md)
- `v1.0` 发布说明：[`docs/v1-release-notes.md`](./docs/v1-release-notes.md)
- `v1.0` 范围冻结：[`docs/v1-scope-freeze.md`](./docs/v1-scope-freeze.md)
- `v1.0` 支持边界：[`docs/v1-support-boundary.md`](./docs/v1-support-boundary.md)
- `v1.0` 验收清单：[`docs/v1-acceptance-checklist.md`](./docs/v1-acceptance-checklist.md)
- `v1.0` 试运行记录：[`docs/v1-pilot-run.md`](./docs/v1-pilot-run.md)
- `v1.0` 已知问题：[`docs/v1-known-issues.md`](./docs/v1-known-issues.md)
