# v1.0 范围冻结说明

## 冻结信息

- 版本：`v1.0.0`
- 冻结日期：`2026-03-11`
- 冻结原则：只交付已完成验收的能力，不混入未验证需求

## 冻结范围

`v1.0` 冻结范围以第 `0` 轮到第 `14` 轮已完成事项为准，包含：

- 账号登录、权限、审计、安全配置
- 店铺接入中心与健康体检
- 订单中心、统一履约闭环、异常处理
- 卡密发货、直充发货、自有货源接入
- 售后中心、资金中心、统计报表
- AI 客服、AI 议价
- 运维监控、告警、备份恢复
- 交付打包、试运行记录、验收清单、支持边界文档

## 不在本次冻结范围内

以下内容明确不属于 `v1.0` 交付承诺：

- 大规模多租户 SaaS 化改造
- 多节点高可用与自动扩缩容
- 面向不同客户的长期版本分叉
- 未经验证的第三方供应商深度定制适配
- 独立 App、小程序或开放平台接口产品化
- 复杂 BI 建模、自定义报表设计器

## 变更控制规则

冻结后变更按以下规则处理：

1. `P0` 或 `P1` 级缺陷可以通过补丁修复，但不得扩大功能边界。
2. 非阻塞优化记录到后续版本池，不进入 `v1.0`。
3. 新模块、新流程、新第三方接入统一延后到 `v1.1` 评估。
4. 所有冻结后修订必须同步更新发布说明、已知问题和验收清单。

## 冻结基线文件

以下文件共同构成 `v1.0` 交付冻结基线：

- [roadmap-checklist.md](/D:/codex/goofish-sale-statistics/docs/roadmap-checklist.md)
- [v1-release-notes.md](/D:/codex/goofish-sale-statistics/docs/v1-release-notes.md)
- [v1-support-boundary.md](/D:/codex/goofish-sale-statistics/docs/v1-support-boundary.md)
- [v1-acceptance-checklist.md](/D:/codex/goofish-sale-statistics/docs/v1-acceptance-checklist.md)
- [v1-known-issues.md](/D:/codex/goofish-sale-statistics/docs/v1-known-issues.md)
- `output/releases/sale-compass-v1.0.0-<时间戳>/release-manifest.json`

## 结论

`v1.0` 范围冻结后，项目已经具备“可部署、可试运行、可培训、可验收”的交付条件。
