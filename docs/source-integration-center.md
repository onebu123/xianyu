# 自有货源系统接入说明

## 目标

第 13 轮把 `distribution-source` 和 `distribution-supply` 两个工作台扩展为“自有货源接入中心”，覆盖货源系统管理、商品映射、同步、推单、回调、退款通知和对账。

## 当前能力

- 标准模拟自有货源适配器 `sim-own-supply`
- 货源系统账号、回调令牌、同步模式和状态管理
- 商品、库存、价格三类同步
- 货源商品与平台商品映射
- 订单推单、回调状态映射和人工接管
- 退款通知、售后退款单联动和退款对账
- 同步记录、回调记录、退款通知记录、对账记录留痕

## 数据模型

核心表如下：

- `supply_source_systems`：货源系统主表，记录系统标识、回调令牌、同步模式、状态和最近同步时间
- `supply_source_products`：货源商品与平台商品映射
- `supply_source_sync_runs`：商品、库存、价格同步执行记录
- `supply_source_orders`：货源推单主任务
- `supply_source_callbacks`：货源系统发货结果回调记录
- `supply_source_refund_notices`：货源系统退款通知记录
- `supply_source_reconciliations`：货源侧与平台侧统一对账记录

## 关键规则

### 适配器协议

- 适配器必须实现 `syncProducts`
- 适配器必须实现 `dispatchOrder`
- 适配器必须实现 `normalizeCallback`
- 适配器必须实现 `normalizeRefundNotice`
- 适配器必须实现 `verifyCallbackToken`

### 同步规则

- `product` 用于主数据和映射校准
- `inventory` 用于库存刷新
- `price` 用于供货价刷新
- 工作台支持手动执行和基于历史记录的重试

### 推单规则

- 仅启用中的货源系统和已映射商品允许推单
- 推单成功后主状态进入 `processing`
- 发货回调按 `processing`、`success`、`failed` 统一映射
- 成功回调会同步更新订单主状态、发货状态和时间线

### 退款通知规则

- 合法退款通知会写入 `supply_source_refund_notices`
- 若平台侧还没有退款售后单，会自动创建退款售后主单和退款子单
- `resolved` 会写入 `matched` 对账结果
- `processing` 会写入 `pending` 对账结果
- 验签失败或退款失败会写入 `anomaly`

## 工作台入口

### `distribution-source`

- 查看直充供应商和自有货源系统
- 启停货源系统
- 轮换回调令牌
- 手动执行商品、库存、价格同步
- 查看同步记录和货源商品映射

### `distribution-supply`

- 查看直充任务与自有货源订单
- 对货源订单执行推单、重试、转人工
- 查看货源回调记录
- 查看退款通知记录
- 查看货源侧对账结果

## 已知限制

- 当前接入的是标准模拟货源系统，不包含真实私有货源接口联调
- 当前不包含多货源编排、采购单和结算单体系
- 当前商品映射仍由演示初始化数据维护，未开放可视化编辑器
