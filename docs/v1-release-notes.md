# v1.0 发布说明

## 发布信息

- 版本号：`1.0.0`
- 发布日期：`2026-04-15`
- 发布定位：首个可对外交付的私有化版本
- 发布命令：`npm run release:v1`

## 本次发布结果

- 发布脚本已完整通过：`lint`、`test`、`build`、`smoke:release`、`package:release`
- 发布包目录：[sale-compass-v1.0.0-20260415-214059](/D:/codex/goofish-sale-statistics/output/releases/sale-compass-v1.0.0-20260415-214059)
- 压缩包路径：[sale-compass-v1.0.0-20260415-214059.zip](/D:/codex/goofish-sale-statistics/output/releases/sale-compass-v1.0.0-20260415-214059.zip)
- 清单文件：[release-manifest.json](/D:/codex/goofish-sale-statistics/output/releases/sale-compass-v1.0.0-20260415-214059/release-manifest.json)
- 打包文件数：`289`

## 发布范围

本次 `v1.0` 交付已经覆盖以下能力：

- 登录鉴权、角色隔离、审计日志、敏感配置加密
- 多店铺接入与店铺管理
- 订单中心、商品中心、售后中心、资金中心、报表中心
- 卡密发货、直充发货、自有货源接入
- AI 客服、AI 议价
- 运维监控、健康检查、告警确认、备份恢复演练

## 本次版本亮点

- 店铺接入域已经完成读写仓储拆分，`database.ts` 在该域仅保留委托入口。
- 前端授权页已经完成 cookie 会话模型收口，不再依赖旧 token 透传。
- 发布包可直接生成标准目录、压缩包和 `release-manifest.json`，便于交付与验收。

## 发布前验证

- `npm run lint`
- `npm run test`
- `npm run build`
- `npm run smoke:release`
- `npm run package:release`

## 升级与交付说明

- 当前默认面向单机 `Docker Compose` 私有化部署。
- 生产环境不应启用演示数据。
- 升级前应先执行数据库与配置备份。
- 回滚与恢复流程见 [rollback.md](/D:/codex/goofish-sale-statistics/docs/rollback.md) 和 [backup-restore-runbook.md](/D:/codex/goofish-sale-statistics/docs/backup-restore-runbook.md)。

## 已知边界

- 当前版本仍不是高可用、多活、分布式任务调度架构。
- 当前仍以单机 SQLite 为主，`P2` 阶段再迁移到 PostgreSQL、Redis 与队列体系。
- 更大规模租户隔离、外部身份系统、集中式密钥治理不在 `v1.0` 冻结范围内。
- 详细边界见 [v1-known-issues.md](/D:/codex/goofish-sale-statistics/docs/v1-known-issues.md) 和 [v1-support-boundary.md](/D:/codex/goofish-sale-statistics/docs/v1-support-boundary.md)。
