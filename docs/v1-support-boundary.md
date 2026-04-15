# v1.0 支持范围与风险边界

## 支持范围

### 部署形态

- 单机私有化部署
- Docker Compose 部署
- Ubuntu `22.04 LTS` x86_64 环境优先支持

### 业务范围

- 单租户后台使用
- 多店铺接入、订单履约、售后、报表、资金、AI 辅助、运维监控
- 管理员、运营、客服、财务四类后台角色

### 运维范围

- 健康检查
- 告警确认
- 数据库备份
- 日志归档
- 恢复演练
- 升级与回滚指导

### 浏览器范围

- Chrome 最新稳定版
- Edge 最新稳定版

## 建议容量边界

为保证 `v1.0` 的稳定性，建议控制在以下边界内：

- 启用店铺数：`10` 家以内
- 后台并发操作人数：`20` 人以内
- 年累计订单量：`100000` 单以内
- 部署方式：单实例、单数据库文件、单运维入口

超过以上范围时，应先做专项压测与架构评估。

## 风险边界

### 当前版本限制

- 使用本地 SQLite 数据库，不提供原生高可用。
- 备份与恢复以文件级流程为主，正式恢复前必须停服务。
- AI 客服和 AI 议价以规则、模板、知识库和人工接管为主。
- 标准适配器可用于演示与规范化对接，真实供应商深度联调需单独实施。

### 不提供的能力

- 多机房容灾
- 分布式任务调度
- 对外开放 API 网关
- 复杂审批流引擎
- 面向大量客户的多版本并行托管

## 售后与支持流程

### 问题分级

- `P1`：系统不可用、核心交易阻塞、数据损坏风险
- `P2`：关键功能受限但存在临时绕行方案
- `P3`：咨询、配置协助、非阻塞优化建议

### 默认处理原则

- `P1`：收到问题后优先进入人工处理与恢复流程
- `P2`：进入工作日问题清单，结合业务影响排期
- `P3`：记录到版本池，不承诺进入 `v1.0` 补丁

### 客户提单必备信息

- 问题时间
- 操作账号
- 涉及店铺、订单、售后或任务编号
- 页面截图或日志
- 当前 `GET /api/health` 输出

## 建议配套文档

- 部署：[deployment.md](/D:/codex/goofish-sale-statistics/docs/deployment.md)
- 升级：[upgrade.md](/D:/codex/goofish-sale-statistics/docs/upgrade.md)
- 回滚：[rollback.md](/D:/codex/goofish-sale-statistics/docs/rollback.md)
- 备份恢复：[backup-restore-runbook.md](/D:/codex/goofish-sale-statistics/docs/backup-restore-runbook.md)
- 客户交付：[customer-delivery-handbook.md](/D:/codex/goofish-sale-statistics/docs/customer-delivery-handbook.md)

## 结论

`v1.0` 的定位是首个可交付私有化版本，不是无限制扩展版本。任何超出本边界的需求，都应先经过交付评估，再决定是否进入后续版本。
