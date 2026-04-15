# 订单状态机说明

## 目标

第 4 轮开始，订单成为后续发货、售后、资金模块的统一主线。

当前订单模型分为四层状态：

- 主状态 `main_status`
- 发货状态 `delivery_status`
- 支付状态 `payment_status`
- 售后状态 `after_sale_status`

这样可以避免把“订单是否完成”和“是否发货”“是否退款”混成一个字段。

## 主状态

### `paid`

- 订单已支付
- 还未进入正式履约完成态
- 常见于待发货订单

### `processing`

- 订单已进入处理中
- 预留给后续履约引擎接入

### `fulfilled`

- 订单已履约
- 典型场景是已发货、待最终完成

### `completed`

- 订单主流程已完成
- 可归档，可用于统计、资金、客户复购分析

### `after_sale`

- 订单当前存在进行中的售后流程
- 主状态需要从正常流转中切换出来单独标识

### `closed`

- 预留给关闭、取消、人工终止等场景

## 发货状态

### `pending`

- 待发货

### `shipped`

- 已发货

### `delivered`

- 已交付

### `manual_review`

- 预留人工处理态

## 支付状态

### `paid`

- 已支付，未退款

### `refunded_partial`

- 部分退款

### `refunded_full`

- 全额退款

## 售后状态

### `none`

- 无售后

### `processing`

- 售后处理中

### `resolved`

- 售后已完结

## 当前映射规则

现有演示订单由历史字段回填为新状态机：

- `order_status = pending_shipment` 映射为 `main_status = paid`、`delivery_status = pending`
- `order_status = shipped` 映射为 `main_status = fulfilled`、`delivery_status = shipped`
- `order_status = completed` 映射为 `main_status = completed`、`delivery_status = delivered`
- `after_sale_status = processing` 时，主状态提升为 `after_sale`
- `refund_amount > 0` 时，支付状态映射为部分退款或全额退款

## 第 7 轮统一履约队列

第 7 轮在原有主状态、发货状态之上，补充统一履约视图，用于把普通订单、卡密发货和直充发货拉到同一工作台处理。

统一履约队列包含：

- `pending`：待处理，订单已进入履约主线但还未进入实际任务执行
- `processing`：处理中，订单已经发起履约任务或处于供应商处理中
- `success`：已成功，订单已完成交付或供应商已确认成功
- `failed`：失败待处理，当前自动履约已失败，需要人工继续跟进
- `manual_review`：待人工，订单被人工接管或明确标记为人工处理

订单详情和订单列表会额外返回：

- `fulfillmentType`：`standard | card | direct_charge`
- `fulfillmentQueue`：统一履约队列
- `fulfillmentStage`：面向页面展示的阶段标题
- `fulfillmentStageDetail`：面向页面展示的阶段说明

## 履约类型映射规则

### `standard`

- 没有卡密或直充任务的订单归类为 `standard`
- `delivery_status = manual_review` 时映射为 `manual_review`
- `delivery_status = delivered` 或 `main_status in (fulfilled, completed)` 时映射为 `success`
- `main_status = processing` 或 `delivery_status = shipped` 时映射为 `processing`
- 其他情况映射为 `pending`

### `card`

- 只要商品绑定了 `card_delivery_items`，订单就进入卡密履约类型
- 最新 `card_delivery_jobs.job_status = failed` 时映射为 `failed`
- `delivery_status = manual_review` 时映射为 `manual_review`
- 最新发货任务成功、订单已交付或主状态为 `fulfilled / completed` 时映射为 `success`
- 主状态为 `processing` 或发货状态为 `shipped` 时映射为 `processing`
- 其他情况映射为 `pending`

### `direct_charge`

- 只要商品绑定了 `direct_charge_items` 或已经生成过 `direct_charge_jobs`，订单就进入直充履约类型
- 最新 `direct_charge_jobs.task_status = failed` 时映射为 `failed`
- 最新 `task_status = manual_review` 或 `delivery_status = manual_review` 时映射为 `manual_review`
- 最新 `task_status = success`、订单已交付或主状态为 `completed` 时映射为 `success`
- 最新 `task_status = processing`、主状态为 `processing` 或发货状态为 `shipped` 时映射为 `processing`
- 其他情况映射为 `pending`

### `closed` 的优先级

- 当 `main_status = closed` 时，统一履约队列优先视为 `failed`
- 这类订单通常来自人工终止、关闭或异常中断，需要进入异常闭环而不是继续参与成功统计

## 状态约束

- 同一订单任一时刻只能有一个主状态。
- 发货状态与主状态独立存储，但必须可解释当前进度。
- 售后状态不覆盖支付状态，退款信息仍保留在支付维度。
- 后续第 5 轮到第 7 轮的履约引擎，只允许围绕该状态机扩展，不再回到页面散字段。

## 时间线来源

订单详情时间线当前由 `order_events` 提供，包含：

- 订单创建
- 支付成功
- 发货或交付
- 售后发起或售后完结
- 订单完成

第 7 轮后，履约链路的日志继续统一写入 `order_events`，其中：

- `card_*`：卡密发货、补发、回收等事件
- `direct_charge_*`：直充下发、回调、人工接管等事件
- `fulfillment_*`：统一人工动作，如终止、备注

订单详情页的 `timeline` 继续展示订单全链路事件，`fulfillmentLogs` 则专门抽取履约相关事件。
