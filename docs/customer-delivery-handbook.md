# 客户交付手册

## 文档目的

本文档面向 `v1.0.0` 首个可交付版本，用于指导客户完成部署、初始化、试运行、验收和日常运维。

适用日期：`2026-03-11`

## 交付包内容

标准交付包包含以下内容：

- 应用源码与已验证的构建产物
- Docker Compose 部署文件与 Nginx 路径代理样例
- 安装、部署、备份恢复、升级、回滚文档
- `v1.0` 发布说明、范围冻结、支持边界、验收清单、试运行记录、已知问题
- `release-manifest.json`，用于核对交付包文件完整性

标准发布命令：

```bash
npm run release:v1
```

该命令已包含：

- `npm run lint`
- `npm run test`
- `npm run build`
- `npm run smoke:release`
- `npm run package:release`

标准输出目录：

```text
output/releases/sale-compass-v1.0.0-<时间戳>/
```

## 推荐环境

### 部署环境

- Ubuntu `22.04 LTS` x86_64
- Docker `24+`
- Docker Compose `v2`
- CPU `4` 核以上
- 内存 `8 GB` 以上
- 可用磁盘 `50 GB` 以上

### 浏览器

- Chrome 最新稳定版
- Edge 最新稳定版

### 运行模式

- 单机
- 单租户
- 由 Docker Compose 承载前后端与数据库文件

## 首次部署

### 1. 准备环境变量

```bash
cp .env.example .env
```

生产环境至少确认以下项：

- `APP_RUNTIME_MODE=prod`
- `APP_ENABLE_DEMO_DATA=false`
- 初始化管理员账号与密码
- 基础路径与反向代理路径
- 备份目录与日志目录

部署细节见 [deployment.md](/D:/codex/goofish-sale-statistics/docs/deployment.md)。

### 2. 启动服务

```bash
npm run preflight
docker compose up -d --build
```

如果使用 VPS 路径代理模式：

```bash
npm run preflight
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d --build
```

### 3. 健康检查

```bash
curl http://127.0.0.1:4300/api/health
docker compose ps
```

如已配置指标令牌，建议追加：

```bash
curl -H "x-metrics-token: <APP_METRICS_TOKEN>" http://127.0.0.1:4300/api/metrics
```

验收要求：

- 健康检查返回 `status: ok`
- 健康检查返回版本号与环境摘要
- 健康检查返回 `configuration.strictMode = true`
- 健康检查返回 `configuration.demoDataEnabled = false`
- 前端页面可正常加载
- 管理员可登录
- 审计日志可写入

## 初始化开通顺序

建议按以下顺序完成首日开通：

1. 管理员登录并修改初始密码。
2. 校验角色权限、菜单和工作台入口。
3. 完成店铺授权接入与店铺体检。
4. 导入卡密库存或配置直充、货源适配信息。
5. 检查订单中心、履约闭环、售后中心和报表中心。
6. 执行一次备份、一次日志归档和一次恢复演练。

## 客户首日验收路径

### 基础链路

- 登录
- 角色权限控制
- 操作审计
- 健康检查

### 核心业务链路

- 店铺接入与重新授权
- 订单中心查看与异常履约处理
- 卡密发货、直充发货或货源推单
- 售后退款、补发、争议处理
- 统计报表和资金账本核对

### 运维链路

- AI 客服与 AI 议价策略启停
- 告警确认
- 数据库备份
- 日志归档
- 恢复演练

## 日常运维建议

### 每日

- 查看 `GET /api/health`
- 查看 `GET /api/metrics`
- 处理工作台告警
- 检查失败任务和人工介入任务

### 每周

- 执行一次数据库备份
- 执行一次 `npm run db:doctor`
- 执行一次日志归档
- 核对售后、资金和报表摘要

### 每月

- 执行一次恢复演练
- 复核支持边界与实际业务量
- 清理不再使用的测试店铺和演示账号

## 升级与回滚

- 升级说明见 [upgrade.md](/D:/codex/goofish-sale-statistics/docs/upgrade.md)
- 回滚说明见 [rollback.md](/D:/codex/goofish-sale-statistics/docs/rollback.md)
- 备份恢复说明见 [backup-restore-runbook.md](/D:/codex/goofish-sale-statistics/docs/backup-restore-runbook.md)

原则：

- 升级前必须先备份
- 生产库恢复前必须先停服务
- 非紧急变更不要跨版本跳跃升级

## 支持与售后

- 支持范围见 [v1-support-boundary.md](/D:/codex/goofish-sale-statistics/docs/v1-support-boundary.md)
- 试运行记录见 [v1-pilot-run.md](/D:/codex/goofish-sale-statistics/docs/v1-pilot-run.md)
- 已知问题见 [v1-known-issues.md](/D:/codex/goofish-sale-statistics/docs/v1-known-issues.md)
- 验收清单见 [v1-acceptance-checklist.md](/D:/codex/goofish-sale-statistics/docs/v1-acceptance-checklist.md)

客户提单时建议附带：

- 问题发生时间
- 操作账号与角色
- 涉及店铺、订单或售后单编号
- 页面截图或接口报错
- `GET /api/health` 输出

## 文档索引

- 项目说明：[project-overview.md](/D:/codex/goofish-sale-statistics/docs/project-overview.md)
- 部署说明：[deployment.md](/D:/codex/goofish-sale-statistics/docs/deployment.md)
- API 文档：[api.md](/D:/codex/goofish-sale-statistics/docs/api.md)
- 升级说明：[upgrade.md](/D:/codex/goofish-sale-statistics/docs/upgrade.md)
- 回滚说明：[rollback.md](/D:/codex/goofish-sale-statistics/docs/rollback.md)
- 备份恢复手册：[backup-restore-runbook.md](/D:/codex/goofish-sale-statistics/docs/backup-restore-runbook.md)
- 发布说明：[v1-release-notes.md](/D:/codex/goofish-sale-statistics/docs/v1-release-notes.md)
- 范围冻结：[v1-scope-freeze.md](/D:/codex/goofish-sale-statistics/docs/v1-scope-freeze.md)
- 支持边界：[v1-support-boundary.md](/D:/codex/goofish-sale-statistics/docs/v1-support-boundary.md)
- 验收清单：[v1-acceptance-checklist.md](/D:/codex/goofish-sale-statistics/docs/v1-acceptance-checklist.md)
- 试运行记录：[v1-pilot-run.md](/D:/codex/goofish-sale-statistics/docs/v1-pilot-run.md)
- 已知问题：[v1-known-issues.md](/D:/codex/goofish-sale-statistics/docs/v1-known-issues.md)
