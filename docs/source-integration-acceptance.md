# 第 13 轮验收记录

## 轮次

- 第 13 轮：自有货源系统接入
- 验收日期：2026-03-11

## 验收范围

- 货源适配层
- 货源系统与回调令牌管理
- 商品、库存、价格同步
- 货源订单推单、回调、人工接管
- 退款通知与售后联动
- 货源对账与异常留痕
- 自动化测试

## 自动化验证

- `npm run lint`
- `npm run test`
- `npm run build`

## 核对结果

- 已新增 `source-system-adapters.ts`，落地 `sim-own-supply` 标准模拟货源适配器。
- 已新增 `supply_source_systems`、`supply_source_products`、`supply_source_sync_runs`、`supply_source_orders`、`supply_source_callbacks`、`supply_source_refund_notices`、`supply_source_reconciliations`。
- 已支持商品、库存、价格三类同步和同步重试。
- 已支持货源系统启停、令牌轮换、订单推单、回调验签和人工接管。
- 已支持退款通知写入售后退款单和退款对账记录。
- 已把 `distribution-source` 与 `distribution-supply` 工作台扩展到自有货源场景。

## 自动化测试覆盖点

- 货源系统启停、令牌轮换、手动同步和同步重试。
- 货源订单推单、成功回调和订单状态回写。
- 退款通知生成售后记录和退款对账。

## 人工验收结论

- `distribution-source` 页面可以直接看到货源系统、商品映射和同步记录。
- `distribution-supply` 页面可以直接执行货源推单、重试、转人工，并查看货源回调、退款通知、对账记录。
- 货源系统成功回调后，订单中心可以看到发货状态和主状态同步更新。

## 已知限制

- 当前只接入 1 套标准模拟自有货源系统，不包含真实外部系统联调。
- 当前不支持多货源自动选路和复杂采购结算。
