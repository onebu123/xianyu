# API 设计概览

## 说明

- 所有业务接口统一挂载在 `/api` 下。
- 除登录、健康检查外，其余接口都需要 Bearer Token。
- 权限控制以后端为准，前端菜单和按钮仅作辅助收敛。
- 认证失败返回 `401`，权限不足返回 `403`，触发限流返回 `429`。

## 认证与会话

### `POST /api/auth/login`

用途：

- 用户登录并获取访问令牌

请求体：

```json
{
  "username": "admin",
  "password": "<APP_INIT_ADMIN_PASSWORD>"
}
```

返回示例：

```json
{
  "token": "jwt-token",
  "expiresAt": "2026-03-09T22:10:00.000Z",
  "user": {
    "id": 1,
    "username": "admin",
    "displayName": "系统管理员",
    "role": "admin",
    "status": "active",
    "createdAt": "2026-03-09 10:00:00",
    "updatedAt": "2026-03-09 10:00:00",
    "lastLoginAt": "2026-03-09 14:32:21"
  }
}
```

### `POST /api/auth/refresh`

用途：

- 对当前会话执行 Token 续期

返回：

- 结构与登录接口一致，返回新的 `token` 和 `expiresAt`

### `GET /api/auth/profile`

用途：

- 获取当前登录用户资料

返回：

```json
{
  "user": {
    "id": 1,
    "username": "admin",
    "displayName": "系统管理员",
    "role": "admin",
    "status": "active"
  }
}
```

## 系统与安全

### `GET /api/health`

用途：

- 健康检查
- 返回当前运行模式，便于部署验收

返回字段：

- `status`
- `service`
- `version`
- `runtimeMode`
- `timestamp`
- `configuration.strictMode`
- `configuration.envProfile`
- `configuration.envFileLoaded`
- `configuration.envFilesLoaded`
- `configuration.demoDataEnabled`
- `configuration.bootstrapAdminConfigured`
- `configuration.requestLoggingEnabled`
- `configuration.metricsEnabled`
- `configuration.logLevel`
- `configuration.trustProxy`
- `configuration.dataRoot`
- `configuration.dbPath`
- `database.path`
- `database.sizeBytes`
- `alerts.activeCount`
- `alerts.criticalCount`
- `jobs.failedCount`
- `jobs.pendingCount`
- `backups.successCount`
- `backups.latestBackupNo`

### `GET /api/metrics`

用途：

- 输出 Prometheus 指标
- 用于 Grafana、Prometheus 或自定义监控采集

鉴权：

- 如果配置了 `APP_METRICS_TOKEN`，请求头必须携带 `x-metrics-token`
- 如果未配置 `APP_METRICS_TOKEN`，仅 `admin` 可通过 Bearer Token 访问

响应类型：

- `text/plain; version=0.0.4; charset=utf-8`

关键指标：

- `sale_compass_info`
- `sale_compass_uptime_seconds`
- `sale_compass_http_requests_total`
- `sale_compass_http_request_duration_seconds`
- `sale_compass_http_requests_in_flight`
- `sale_compass_http_request_errors_total`
- `sale_compass_process_resident_memory_bytes`
- `sale_compass_process_heap_used_bytes`
- `sale_compass_database_size_bytes`
- `sale_compass_system_alerts_active`
- `sale_compass_system_alerts_critical`
- `sale_compass_fulfillment_jobs_failed`
- `sale_compass_fulfillment_jobs_pending`
- `sale_compass_backups_success_total`
- `sale_compass_runtime_strict_mode`

### `GET /api/system/users`

用途：

- 获取后台账号列表

权限：

- 仅 `admin`

### `POST /api/system/users`

用途：

- 创建后台账号

权限：

- 仅 `admin`

请求体：

```json
{
  "username": "operator_02",
  "displayName": "华东运营",
  "password": "Operator@123456",
  "role": "operator"
}
```

### `POST /api/system/users/:userId/role`

用途：

- 调整后台账号角色

权限：

- 仅 `admin`

### `POST /api/system/users/:userId/status`

用途：

- 启用或停用后台账号

权限：

- 仅 `admin`

### `POST /api/system/secure-settings/:settingKey`

用途：

- 新增或轮换敏感配置

权限：

- 仅 `admin`

说明：

- 页面与接口仅返回脱敏值
- 明文不会通过接口返回

## 通用筛选

以下统计接口支持部分或全部通用筛选参数：

- `preset`：`today | last7Days | last30Days | last90Days`
- `startDate`
- `endDate`
- `storeId`
- `category`
- `source`
- `keyword`
- `orderStatus`
- `afterSaleStatus`

### `GET /api/options`

用途：

- 获取筛选器选项字典

返回内容：

- 店铺选项
- 商品选项
- 分类选项
- 来源选项

## 统计看板

### `GET /api/dashboard`

用途：

- 获取销售总览页全部数据

返回内容：

- 总览指标
- 今日统计 / 商品统计 / 订单统计 / 售后统计
- 销售趋势
- 来源分布
- 订单状态分布
- 爆品排行
- 筛选项字典

返回重点补充：

- 顶部摘要卡已切换为真实支付与利润口径，返回 `实收金额`、`净销售额`、`净利润`、`毛利率`

### `GET /api/reports`

用途：

- 获取经营报表中心数据
- 统一返回店铺、商品、订单、售后四个维度统计
- 页面、接口、导出共用同一套利润口径

支持参数：

- 复用通用筛选参数
- `storeIds`：多店铺筛选，逗号分隔，例如 `1,2,3`
- `productId`
- `keyword`

返回重点：

- `summary`：顶部摘要卡，包含 `实收金额`、`净销售额`、`净利润`、`毛利率`
- `formulas`：利润与毛利公式说明，返回公式、说明和当前值
- `paymentSummary`：支付资金口径，包含订单原额、优惠金额、实收金额、退款金额、支付笔数
- `storeStats`：店铺维度经营统计
- `productStats`：商品维度经营统计
- `orderStats`：订单维度概览、主状态分布、来源分布、履约队列分布
- `afterSaleStats`：售后维度概览、类型分布、状态分布
- `trend`：按日回溯订单原额、实收金额、退款金额、净利润、订单数、售后单数

### `GET /api/reports/export`

用途：

- 导出经营报表 CSV
- 导出内容与 `/api/reports` 指标口径保持一致

支持参数：

- 与 `/api/reports` 相同

权限：

- `admin`
- `operator`
- `finance`

### `GET /api/orders/overview`

用途：

- 获取订单页顶部统计卡片

返回重点：

- `totalOrders`
- `paidOrders`
- `fulfilledOrders`
- `mainCompletedOrders`
- `mainAfterSaleOrders`
- `averageDeliveryHours`
- `salesAmount`

### `GET /api/orders`

用途：

- 获取订单列表

额外参数：

- `productId`
- `mainStatus`
- `deliveryStatus`
- `page`
- `pageSize`
- `sortBy`：`paidAt | paidAmount | completedAt | updatedAt`
- `sortOrder`：`asc | desc`

返回重点：

- `mainStatus` / `mainStatusText`
- `deliveryStatus` / `deliveryStatusText`
- `paymentStatus` / `paymentStatusText`
- `fulfillmentType` / `fulfillmentTypeText`
- `fulfillmentQueue` / `fulfillmentQueueText`
- `fulfillmentStage` / `fulfillmentStageDetail`
- `latestEventAt`

### `GET /api/orders/:orderId`

用途：

- 获取订单详情
- 返回订单主信息、订单项、支付记录、事件时间线

权限：

- `admin`
- `operator`
- `support`
- `finance`

返回重点：

- `order` 中包含统一履约类型、统一履约队列和阶段字段
- `fulfillment` 返回当前履约摘要，包含任务号、供应商单号 / 出库单号、重试次数、人工原因和动作可用性
- `fulfillmentLogs` 统一返回 `card_*`、`direct_charge_*`、`fulfillment_*` 履约日志

### `GET /api/orders/workbench/fulfillment`

用途：

- 获取订单履约工作台概览
- 返回统一队列摘要、异常订单、履约日志和店铺履约表现

额外参数：

- 复用 `/api/orders` 的筛选参数
- 支持 `preset`

权限：

- `admin`
- `operator`
- `support`
- `finance`

返回重点：

- `queueSummary`：统一履约五类队列汇总，包含 `pending`、`processing`、`success`、`failed`、`manual_review`
- `exceptionOrders`：失败和待人工订单列表，包含履约类型、队列、阶段和阶段说明
- `logs`：履约任务日志，统一读取 `order_events` 中的履约相关事件
- `storeStats`：店铺维度履约统计，包含总订单数、成功数、失败数、人工数、处理中数和对应占比

### `POST /api/orders/:orderId/fulfillment/retry`

用途：

- 对订单执行统一履约重试
- 卡密订单会重跑自动发货或失败任务
- 直充订单会重新下发或走重试链路

权限：

- `admin`
- `operator`
- `support`

### `POST /api/orders/:orderId/fulfillment/resend`

用途：

- 对订单执行统一补发
- 当前仅卡密履约支持补发

权限：

- `admin`
- `operator`
- `support`

### `POST /api/orders/:orderId/fulfillment/terminate`

用途：

- 人工终止订单履约
- 终止后统一写入履约日志和审计日志

权限：

- `admin`
- `operator`
- `support`

请求体示例：

```json
{
  "reason": "供应商长时间无响应，转人工线下处理"
}
```

### `POST /api/orders/:orderId/fulfillment/note`

用途：

- 给订单追加履约备注
- 同步写入订单备注和履约日志

权限：

- `admin`
- `operator`
- `support`

请求体示例：

```json
{
  "note": "已联系供应商复核库存，等待二次确认"
}
```

### `GET /api/orders/export`

用途：

- 导出订单 CSV 报表
- 导出结果与当前筛选条件一致

权限：

- `admin`
- `operator`
- `finance`

## 售后中心

### `GET /api/after-sales/workbench`

用途：

- 获取售后工作台概览
- 返回摘要卡片、待处理提醒、超时售后单

额外参数：

- 复用基础筛选参数
- 支持 `caseType`
- 支持 `caseStatus`

权限：

- `admin`
- `operator`
- `support`

返回重点：

- `summary`：售后总量、待处理、处理中、已完结、超时、退款/补发/争议数量、待退款金额
- `reminders`：待处理提醒和超时提醒
- `pendingCases`：待处理售后单列表
- `timeoutCases`：超时售后单列表

### `GET /api/after-sales`

用途：

- 获取售后列表
- 支持分页、类型筛选、状态筛选和订单维度筛选

额外参数：

- `page`
- `pageSize`
- `caseType`：`refund | resend | dispute`
- `caseStatus`：`pending_review | processing | waiting_execute | resolved | rejected`

权限：

- `admin`
- `operator`
- `support`

返回重点：

- `caseType` / `caseTypeText`
- `caseStatus` / `caseStatusText`
- `refundStatusText` / `resendStatusText` / `disputeStatusText`
- `reminderTypes`
- `canReviewRefund` / `canExecuteResend` / `canConcludeDispute`

### `GET /api/after-sales/:caseId`

用途：

- 获取售后详情
- 联动返回订单摘要、统一履约摘要、履约记录、处理记录和提醒记录

权限：

- `admin`
- `operator`
- `support`

返回重点：

- `caseInfo`：售后主单信息
- `refund` / `resend` / `dispute`：对应子单详情
- `order`：关联订单摘要
- `fulfillment`：统一履约摘要
- `artifacts`：卡密出库记录和直充任务记录
- `records`：售后处理记录
- `reminders`：待处理提醒和超时提醒记录

### `POST /api/after-sales/:caseId/refund/review`

用途：

- 处理退款审核
- 支持审核通过、驳回、确认退款三种动作

权限：

- `admin`
- `operator`
- `support`

请求体示例：

```json
{
  "decision": "approve",
  "approvedAmount": 18.8,
  "note": "核对履约日志后同意退款"
}
```

### `POST /api/after-sales/:caseId/resend/execute`

用途：

- 处理补发申请和补发执行
- 支持通过、驳回、执行成功、执行失败四种动作

权限：

- `admin`
- `operator`
- `support`

请求体示例：

```json
{
  "decision": "success",
  "note": "已重新补发卡密并写回出库记录"
}
```

### `POST /api/after-sales/:caseId/dispute/conclude`

用途：

- 登记争议结论
- 支持支持买家、支持卖家、转退款、转补发四种结论

权限：

- `admin`
- `operator`
- `support`

请求体示例：

```json
{
  "decision": "buyer_win",
  "compensationAmount": 6.6,
  "note": "根据履约凭证不足，判定支持买家"
}
```

### `POST /api/after-sales/:caseId/note`

用途：

- 追加售后备注
- 同步写入售后处理记录和订单备注

权限：

- `admin`
- `operator`
- `support`

请求体示例：

```json
{
  "note": "已电话联系买家，等待其确认最终处理方案"
}
```

### `GET /api/products`

用途：

- 获取商品分析页面数据

### `GET /api/customers`

用途：

- 获取客户分析页面数据

## 店铺管理

### `GET /api/stores/management`

用途：

- 获取店铺接入中心概览数据，包括：
- 店铺列表
- 闲鱼与淘宝分平台列表
- 授权会话记录
- 健康检查日志
- 分组统计
- 汇总指标

权限：

- `admin`
- `operator`

核心返回字段：

- `stores`：统一店铺列表，包含平台、店主账号、分组、标签、备注、启停状态、授权状态、连接状态、健康状态、最近同步时间等字段
- `authSessions`：授权会话记录，支持 `pending`、`completed`、`expired`、`invalidated`
- `healthChecks`：健康检查日志，支持 `healthy`、`warning`、`offline`、`abnormal`、`skipped`
- `summaries`：总店铺数、已启用/已停用、待激活/已激活/掉线/异常、待处理会话等汇总信息

### `POST /api/stores/auth-sessions`

用途：

- 发起店铺授权会话
- 支持新接入和重新授权两种模式

权限：

- `admin`
- `operator`

请求体示例：

```json
{
  "platform": "xianyu",
  "source": "shop",
  "authType": 11,
  "storeId": 3
}
```

说明：

- `storeId` 为空时表示创建新店铺授权会话
- `storeId` 有值时表示针对已有店铺重新授权
- 接口会返回 `expiresAt`、`reauthorize`、`storeId`、`storeName`

### `POST /api/stores/auth-sessions/:sessionId/complete`

用途：

- 完成授权回传
- 新接入时创建店铺记录
- 重新授权时刷新原店铺授权状态，不创建重复店铺

权限：

- `admin`
- `operator`

请求体示例：

```json
{
  "mobile": "13800138000",
  "nickname": "新增闲鱼店铺",
  "loginMode": "sms"
}
```

返回说明：

- `activationStatus`：返回授权后的接入状态
- `reauthorized`：标记是否为重新授权链路

### `POST /api/stores/:storeId/activate`

用途：

- 激活已完成授权的店铺

权限：

- `admin`
- `operator`

### `POST /api/stores/:storeId/meta`

用途：

- 编辑店铺分组、标签和备注

权限：

- `admin`
- `operator`

请求体示例：

```json
{
  "groupName": "闲鱼主店",
  "tags": ["闲鱼", "主推", "潮玩"],
  "remark": "当前主力经营店铺"
}
```

### `POST /api/stores/:storeId/enabled`

用途：

- 单店启用或停用

权限：

- `admin`
- `operator`

请求体示例：

```json
{
  "enabled": false
}
```

### `POST /api/stores/batch/enabled`

用途：

- 批量启用或停用多家店铺

权限：

- `admin`
- `operator`

请求体示例：

```json
{
  "storeIds": [2, 3, 7],
  "enabled": true
}
```

### `POST /api/stores/:storeId/health-check`

用途：

- 对单个店铺执行健康检查

权限：

- `admin`
- `operator`

返回重点：

- 掉线店铺返回 `offline`
- 异常店铺返回 `abnormal`
- 停用店铺返回 `skipped`
- 待激活店铺返回 `warning`

### `POST /api/stores/batch/health-check`

用途：

- 批量执行健康检查任务

权限：

- `admin`
- `operator`

请求体示例：

```json
{
  "storeIds": [1, 4, 5]
}
```

## 工作台模块

### `GET /api/workspaces/:featureKey`

用途：

- 获取工作台概览数据

返回内容：

- 模块摘要
- 动作列表
- 规则列表
- 任务列表
- 日志列表

### `GET /api/workspaces/:featureKey/detail`

用途：

- 获取模块专属业务详情

典型模块：

- `system-accounts`
- `open-logs`
- `system-configs`
- `fund-accounts`
- `fund-bills`
- `fund-withdrawals`
- `fund-deposit`
- `fund-orders`
- `fund-agents`
- `ai-service`
- `ai-bargain`
- `card-types`
- `card-delivery`
- `card-records`
- `card-trash`
- `distribution-source`
- `distribution-supply`

说明：

- 资金模块复用通用筛选参数，支持 `preset`、`startDate`、`endDate`、`storeId`、`storeIds`
- `fund-accounts` 返回账户余额、最近结算、退款、对账结果和说明
- `fund-bills` 返回统一账单流水，含收入、退款、手续费、提现、调整、保证金、订购等分类
- `fund-withdrawals` 返回提现申请列表，支持按店铺和时间查看
- `ai-bargain` 返回议价配置、商品策略、会话、留痕、模板和黑名单
- `fund-deposit` 返回保证金记录，带店铺维度
- `fund-orders` 返回订购与增值服务账单，带店铺维度
- `fund-agents` 返回代理与会员订购明细
- `ai-service` 返回策略配置、会话列表、最近消息、人工接管记录、知识库、话术模板和风险边界说明。
- `card-types` 返回卡种库存模型，含可用、锁定、已售、禁用、最近导入和最近出库信息。
- `card-delivery` 返回发货配置、履约任务、低库存预警和模板联动信息。
- `card-records` 返回出库记录、回收记录和批次导入记录。
- `distribution-source` 返回直充供应商、自有货源系统、货源商品映射和同步记录。
- `distribution-supply` 返回直充任务、自有货源订单、回调记录、退款通知和对账结果。

### `POST /api/workspaces/:featureKey/actions/:actionId/run`

用途：

- 执行模块动作

### `POST /api/workspaces/:featureKey/rules/:ruleId/toggle`

用途：

- 切换模块规则状态

### `POST /api/workspaces/:featureKey/tasks/:taskId/status`

用途：

- 更新任务状态

请求体：

```json
{
  "status": "done"
}
```

### `POST /api/workspaces/:featureKey/suppliers/:supplierId/toggle`

用途：

- 启用或停用直充供应商账号

### `POST /api/workspaces/:featureKey/suppliers/:supplierId/token/rotate`

用途：

- 轮换供应商回调令牌
- 返回新的脱敏令牌摘要和轮换时间

### `POST /api/workspaces/:featureKey/direct-charge-jobs/:jobId/dispatch`

用途：

- 对指定直充任务执行首次下发

### `POST /api/workspaces/:featureKey/direct-charge-jobs/:jobId/retry`

用途：

- 对超时、失败或人工释放后的直充任务重新下发

### `POST /api/workspaces/:featureKey/direct-charge-jobs/:jobId/manual-review`

用途：

- 把指定直充任务转入人工接管

请求体：

```json
{
  "reason": "工作台人工接管"
}
```

### `POST /api/workspaces/:featureKey/source-systems/:systemId/toggle`

用途：

- 启用或停用自有货源系统
- 影响货源同步和后续推单可用性

### `POST /api/workspaces/:featureKey/source-systems/:systemId/token/rotate`

用途：

- 轮换自有货源系统回调令牌
- 返回新的脱敏令牌摘要和轮换时间

### `POST /api/workspaces/:featureKey/source-systems/:systemId/sync`

用途：

- 手动执行自有货源同步任务
- 当前支持 `product`、`inventory`、`price` 三类同步

请求体：

```json
{
  "syncType": "price"
}
```

### `POST /api/workspaces/:featureKey/source-sync-runs/:runId/retry`

用途：

- 对指定货源同步记录执行重试
- 生成新的手动同步执行记录

### `POST /api/workspaces/:featureKey/source-orders/:sourceOrderId/dispatch`

用途：

- 对指定自有货源订单执行首次推单
- 推单成功后订单进入 `processing`

### `POST /api/workspaces/:featureKey/source-orders/:sourceOrderId/retry`

用途：

- 对失败、待推单或人工接管后的货源订单重新推单

### `POST /api/workspaces/:featureKey/source-orders/:sourceOrderId/manual-review`

用途：

- 将指定货源订单转入人工接管
- 会保留人工接管原因和异常对账状态

请求体：

```json
{
  "reason": "工作台人工接管"
}
```

### `POST /api/workspaces/:featureKey/delivery-items/:deliveryId/toggle`

用途：

- 切换卡密发货项状态

### `POST /api/workspaces/:featureKey/combos/:comboId/toggle`

用途：

- 切换卡密组合状态

### `POST /api/workspaces/:featureKey/templates/:templateId/random-toggle`

用途：

- 切换卡密模板随机发货开关

### `POST /api/workspaces/:featureKey/card-types/:cardTypeId/restore`

用途：

- 恢复回收站中的卡种

### `POST /api/workspaces/:featureKey/card-types/:cardTypeId/import`

用途：

- 导入卡密批次，返回新增、重复、格式异常统计

请求体：

```json
{
  "lines": [
    "SW-23816811#ON-23816811",
    "SW-23816811#ON-23816811",
    "BAD-LINE"
  ]
}
```

### `POST /api/workspaces/:featureKey/card-types/:cardTypeId/inventory-sample/toggle`

用途：

- 在工作台中禁用或恢复一张演示样卡，用于验证禁用与库存回补逻辑

### `POST /api/workspaces/:featureKey/orders/:orderId/fulfill`

用途：

- 对指定卡密订单执行自动发货
- 同一订单再次调用会返回已有出库记录，满足幂等控制

### `POST /api/workspaces/:featureKey/jobs/:jobId/run`

用途：

- 执行或重试卡密发货任务

### `POST /api/workspaces/:featureKey/outbound-records/:outboundRecordId/resend`

用途：

- 对指定出库记录执行卡密补发
- 补发结果会关联原订单和原出库单

### `POST /api/workspaces/:featureKey/outbound-records/:outboundRecordId/recycle`

用途：

- 对指定出库记录执行回收返库或撤回禁用

请求体：

```json
{
  "action": "recycle"
}
```

### `POST /api/direct-charge/callbacks/:supplierKey`

用途：

- 接收供应商异步回调
- 完成令牌校验、状态映射、订单状态同步和异常记录

请求体：

```json
{
  "taskNo": "DC2026031099002",
  "supplierOrderNo": "SIM-20260310121000-9002",
  "supplierStatus": "SUCCESS",
  "resultCode": "0000",
  "detail": "模拟供应商回执：充值成功。",
  "token": "sim-topup-callback-token"
}
```

### `POST /api/source-supply/callbacks/:systemKey`

用途：

- 接收自有货源系统发货结果回调
- 完成令牌校验、状态映射、订单状态同步和履约对账记录

请求体：

```json
{
  "taskNo": "SS2026031077001",
  "sourceOrderNo": "SRC-20260311105100-7001",
  "sourceStatus": "DELIVERED",
  "detail": "模拟货源回调：已完成发货。",
  "token": "own-supply-core-token"
}
```

### `POST /api/source-supply/refunds/:systemKey`

用途：

- 接收自有货源系统退款通知
- 自动写入退款通知、售后退款单和退款对账记录

请求体：

```json
{
  "noticeNo": "REFUND-TEST-001",
  "sourceOrderNo": "SRC-20260311105100-7001",
  "refundStatus": "REFUNDED",
  "detail": "模拟货源退款通知：已退款。",
  "token": "own-supply-core-token"
}
```

### `POST /api/workspaces/:featureKey/withdrawals`

用途：

- 新建提现申请
- 当前仅 `fund-withdrawals` 模块支持
- 创建后会立即占用可用余额，并写入账本联动

权限：

- `admin`
- `finance`

请求体：

```json
{
  "amount": 120,
  "storeId": 1,
  "method": "支付宝",
  "receivingAccount": "finance@alipay"
}
```

返回重点：

- `status`：初始为 `pending`
- 提现记录会同步出现在 `fund-withdrawals` 和 `fund-bills`
- `fund-accounts.account.pendingWithdrawal` 会同步增加

### `POST /api/workspaces/:featureKey/withdrawals/:withdrawalId/status`

用途：

- 审核提现状态

权限：

- `admin`
- `finance`

请求体：

```json
{
  "status": "paid"
}
```

返回重点：

- `pending -> paid`：扣减待审核金额，保留已出账结果
- `pending -> rejected`：释放冻结余额
- 审核结果会同步回写 `fund-bills` 的提现流水和手续费流水

### `POST /api/workspaces/:featureKey/reconciliations/:reconciliationId/status`

用途：

- 更新对账状态
- 当前支持 `fund-accounts`、`fund-bills` 两个模块入口

权限：

- `admin`
- `finance`

请求体：

```json
{
  "status": "reviewed",
  "note": "复核后确认属于平台延迟回执"
}
```

状态说明：

- `matched`：已对平
- `anomaly`：异常待核
- `reviewed`：已复核

### `POST /api/workspaces/:featureKey/conversations/:conversationId/ai-reply`

用途：

- 触发 AI 客服对指定会话生成回复、建议回复或人工提示。
- 如果最近一条买家消息之后已经生成过 AI / 建议 / 系统提示，则复用最近一次结果，避免重复答复。

权限：

- `admin`
- `operator`
- `support`

返回重点：

- `reused`：是否复用已有结果
- `replyType`：`ai | suggestion | system`
- `conversationStatus`
- `aiStatus`
- `content`

### `POST /api/workspaces/:featureKey/conversations/:conversationId/takeover`

用途：

- 人工接管或释放 AI 会话。
- 同步写入系统消息、接管记录和会话状态。

权限：

- `admin`
- `operator`
- `support`

请求体示例：

```json
{
  "action": "takeover",
  "note": "高风险投诉已转人工专员跟进"
}
```

动作说明：

- `takeover`：会话进入 `manual_active`
- `release`：会话回到 AI 待处理队列

### `POST /api/workspaces/:featureKey/conversations/:conversationId/manual-reply`

用途：

- 发送人工纠偏回复。
- 可选择在发送后直接关闭会话。

权限：

- `admin`
- `operator`
- `support`

请求体示例：

```json
{
  "content": "已转人工专员核对处理，会尽快给您最终结果。",
  "closeConversation": true
}
```

### `POST /api/workspaces/:featureKey/settings`

用途：

- 更新 AI 客服总开关、自动回复开关、FAQ / 订单查询 / 售后建议开关。
- 更新风险边界说明和敏感词列表。

权限：

- `admin`
- `operator`
- `support`

请求体示例：

```json
{
  "aiEnabled": true,
  "autoReplyEnabled": true,
  "faqEnabled": true,
  "orderQueryEnabled": true,
  "afterSaleSuggestionEnabled": true,
  "highRiskManualOnly": true,
  "boundaryNote": "仅允许回答 FAQ、订单进度和标准售后建议，高风险或敏感会话必须转人工。",
  "sensitiveWordsText": "投诉,差评,举报,维权,赔偿"
}
```

返回重点：

- `settings`：返回更新后的 AI 客服策略配置

### `POST /api/workspaces/:featureKey/knowledge-items/:knowledgeItemId/enabled`

用途：

- 启用或停用 AI 知识库条目。

权限：

- `admin`
- `operator`
- `support`

请求体示例：

```json
{
  "enabled": false
}
```

### `POST /api/workspaces/:featureKey/reply-templates/:templateId/enabled`

用途：

- 启用或停用 AI 话术模板。

权限：

- `admin`
- `operator`
- `support`

请求体示例：

```json
{
  "enabled": true
}
```

### `POST /api/workspaces/:featureKey/bargain-sessions/:sessionId/evaluate`

用途：

- 触发 AI 议价评估，按底价、目标价、风控和模板规则返回自动还价、自动成交、拒绝或转人工结果。

权限：

- `admin`
- `operator`
- `support`

请求体示例：

```json
{}
```

### `POST /api/workspaces/:featureKey/bargain-sessions/:sessionId/takeover`

用途：

- 对议价会话执行人工接管或释放接管。

权限：

- `admin`
- `operator`
- `support`

请求体示例：

```json
{
  "action": "takeover",
  "note": "高风险买家改由人工报价"
}
```

### `POST /api/workspaces/:featureKey/bargain-sessions/:sessionId/manual-decision`

用途：

- 提交人工报价、人工成交或人工拒绝结果，并写入议价留痕。

权限：

- `admin`
- `operator`
- `support`

请求体示例：

```json
{
  "content": "最低可以按 84.50 元成交。",
  "action": "counter_offer",
  "offerPrice": 84.5
}
```

### `POST /api/workspaces/:featureKey/bargain-settings`

用途：

- 更新 AI 议价总开关、自动议价、目标价自动成交、高风险转人工、敏感词和黑名单提示。

权限：

- `admin`
- `operator`
- `support`

请求体示例：

```json
{
  "aiEnabled": true,
  "autoBargainEnabled": true,
  "highRiskManualOnly": true,
  "allowAutoAccept": true,
  "boundaryNote": "AI 只能在底价与目标价之间自动议价。",
  "sensitiveWordsText": "投诉,差评,举报",
  "blacklistNotice": "命中黑名单必须转人工。"
}
```

### `POST /api/workspaces/:featureKey/bargain-strategies/:strategyId`

用途：

- 更新商品级议价策略，包括底价、目标价、让价梯度、轮次和风险标签。

权限：

- `admin`
- `operator`
- `support`

请求体示例：

```json
{
  "minPrice": 80.1,
  "targetPrice": 84.5,
  "stepPrice": 1,
  "maxRounds": 4,
  "enabled": true,
  "riskTagsText": "底价保护,重点"
}
```

### `POST /api/workspaces/:featureKey/bargain-templates/:templateId/enabled`

用途：

- 启用或停用 AI 议价模板。

权限：

- `admin`
- `operator`
- `support`

请求体示例：

```json
{
  "enabled": true
}
```

### `POST /api/workspaces/:featureKey/bargain-blacklist/:blacklistId/enabled`

用途：

- 启用或停用议价黑名单条目。

权限：

- `admin`
- `operator`
- `support`

请求体示例：

```json
{
  "enabled": false
}
```

### `POST /api/workspaces/system-monitoring/alerts/:alertId/status`

用途：

- 更新系统告警状态，支持确认告警或手动标记为已处理。

权限：

- `admin`
- `operator`

请求体示例：

```json
{
  "status": "acknowledged"
}
```

### `POST /api/workspaces/system-monitoring/backups/run`

用途：

- 立即生成一份 SQLite 数据库备份，并写入备份记录。

权限：

- `admin`
- `operator`

请求体示例：

```json
{}
```

### `POST /api/workspaces/system-monitoring/log-archives/run`

用途：

- 归档最近审计日志，生成离线 JSON 归档文件并写入归档记录。

权限：

- `admin`
- `operator`

请求体示例：

```json
{}
```

### `POST /api/workspaces/system-monitoring/recovery-drills/run`

用途：

- 基于最近一次成功备份执行恢复演练，验证备份可恢复并记录耗时。

权限：

- `admin`
- `operator`

请求体示例：

```json
{}
```

## 审计规则

以下行为会写入审计日志：

- 登录成功
- 登录失败
- 未授权访问
- 高风险写操作限流
- 店铺授权与激活
- 订单导出
- 提现申请
- 提现审核
- 对账状态更新
- AI 自动回复与建议生成
- AI 会话人工接管、释放和人工纠偏
- AI 客服策略更新
- AI 知识库与话术模板状态更新
- AI 议价评估、人工接管、人工报价与人工成交/拒绝
- AI 议价策略、模板与黑名单状态更新
- 账号创建、角色更新、状态更新
- 敏感配置更新
