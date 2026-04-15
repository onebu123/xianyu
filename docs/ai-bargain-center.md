# AI 议价中心

## 目标

AI 议价中心用于管理“最低价保护下的自动议价”能力。系统只允许在商品最低价与目标价之间自动还价，命中黑名单、敏感词或高风险画像时必须转人工。

## 工作台组成

- 策略配置：统一维护 AI 开关、自动议价、高风险转人工、目标价内自动成交、敏感词和黑名单提示。
- 商品策略：按商品维护标价、最低价、目标价、让价梯度、最大轮次和风险标签。
- 议价会话：查看买家出价、最近还价、风险等级、当前边界和接管人。
- 人工处理：支持人工接管、释放接管、人工报价、人工成交和人工拒绝。
- 最近留痕：回放买家出价、AI 还价、人工接管和最终结论。
- 模板与黑名单：维护议价话术模板与黑名单条目启停。

## 自动议价规则

### 价格规则

- AI 不得低于商品最低价。
- 买家报价达到目标价，或达到最大轮次且报价仍高于最低价时，可自动成交。
- 买家报价低于最低价且已达到最大轮次时，系统自动拒绝。
- 其余情况按让价梯度生成还价，且还价结果被限制在最低价和目标价之间。

### 风控规则

- 命中议价黑名单时，系统直接转人工。
- 命中敏感词时，系统按高风险处理。
- 买家历史售后、争议和退款画像达到高风险时，系统直接转人工。
- 人工接管后的会话不再执行自动让价，直到释放接管。

## 数据留痕

议价日志至少记录以下动作：

- 买家出价
- AI 还价
- 自动成交
- 自动拒绝
- 风险拦截
- 人工接管与释放
- 人工报价、人工成交、人工拒绝

## 相关接口

- `GET /api/workspaces/ai-bargain/detail`
- `POST /api/workspaces/ai-bargain/bargain-sessions/:sessionId/evaluate`
- `POST /api/workspaces/ai-bargain/bargain-sessions/:sessionId/takeover`
- `POST /api/workspaces/ai-bargain/bargain-sessions/:sessionId/manual-decision`
- `POST /api/workspaces/ai-bargain/bargain-settings`
- `POST /api/workspaces/ai-bargain/bargain-strategies/:strategyId`
- `POST /api/workspaces/ai-bargain/bargain-templates/:templateId/enabled`
- `POST /api/workspaces/ai-bargain/bargain-blacklist/:blacklistId/enabled`

## 验证要点

- 底价保护会话评估后只能还价到最低价，不得穿透底价。
- 自动成交会话评估后必须写入成交留痕，且会话状态变为 `agreed`。
- 高风险会话必须转人工，不能继续自动还价。
- 商品策略修改后，新的最低价、目标价、梯度和轮次会参与后续评估。
