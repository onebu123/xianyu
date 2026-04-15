# 售后中心说明

## 目标

第 8 轮把售后页面从“按订单筛出售后状态”升级为“真实售后工作台”。当前实现已经覆盖：

- 售后主单、退款单、补发单、争议单、处理记录、提醒记录六类模型
- 售后列表、详情抽屉和工作台提醒
- 退款审核、确认退款、补发执行、争议结论、备注记录
- 超时提醒和待处理提醒
- 订单与履约记录联动查看

## 数据模型

核心表如下：

- `after_sale_cases`：售后主单，记录类型、状态、原因、优先级、处理时限和最新结论
- `after_sale_refunds`：退款单，记录申请金额、通过金额、审核状态和退款时间
- `after_sale_resends`：补发单，记录补发状态、关联履约类型、关联出库单 / 任务号和执行结果
- `after_sale_disputes`：争议单，记录争议状态、责任归属、结论和补偿金额
- `after_sale_records`：处理记录，统一记录创建、审核、执行、结论、备注等动作
- `after_sale_reminders`：提醒记录，区分待处理提醒和超时提醒

## 状态规则

### 售后主单

- `pending_review`：待审核
- `processing`：处理中
- `waiting_execute`：待执行
- `resolved`：已完结
- `rejected`：已驳回

### 退款单

- `pending_review -> approved -> refunded`
- `pending_review -> rejected`

退款单不允许从 `pending_review` 直接跳到 `refunded` 之外的任意状态。

### 补发单

- `requested -> approved -> succeeded`
- `requested -> approved -> failed`
- `requested -> rejected`

当前补发执行默认联动卡密补发链路，执行成功后会写回新的出库记录。

### 争议单

- `open / processing -> buyer_win`
- `open / processing -> seller_win`
- `open / processing -> refunded`
- `open / processing -> resent`

争议单以“登记结论”为终点，不自动派生新的退款单或补发单。

## 提醒机制

- 只要售后主单处于 `pending_review`、`processing`、`waiting_execute`，就保持一条待处理提醒
- 当 `sla_deadline_at` 早于当前时间且主单仍未关闭时，自动生成超时提醒
- 售后单完结或驳回后，提醒自动转为 `resolved`

## 页面入口

售后中心页面当前包含：

- 摘要卡片
- 提醒队列
- 超时售后单
- 售后工作台主表
- 售后详情抽屉

详情抽屉中可以直接查看：

- 订单摘要
- 统一履约摘要
- 卡密出库记录 / 直充任务记录
- 售后处理记录
- 提醒记录

## 已知限制

- 当前争议单只记录结论，不自动编排后续退款或补发工单
- 当前补发执行优先面向卡密履约场景，普通实物和直充售后暂不提供独立补发引擎
