# 店铺接入仓储拆分说明

## 目标

本次拆分把原先集中在 [database.ts](/D:/codex/goofish-sale-statistics/server/src/database.ts) 中的店铺接入逻辑按读写职责拆开，降低单文件复杂度，并为后续订单、售后、资金、AI 工作台继续模块化提供模板。

## 当前结构

- 读仓储：[store-access-read-repository.ts](/D:/codex/goofish-sale-statistics/server/src/store-access-read-repository.ts)
- 写仓储：[store-access-write-repository.ts](/D:/codex/goofish-sale-statistics/server/src/store-access-write-repository.ts)
- 委托入口：[database.ts](/D:/codex/goofish-sale-statistics/server/src/database.ts)

## 已迁移的读侧职责

- 店铺管理总览读取
- 授权会话详情读取
- 店铺凭据时间线读取
- 网页登录态凭据读取
- 商品、订单、AI 议价同步目标读取
- 闲鱼 IM 同步目标读取

## 已迁移的写侧职责

- 授权会话创建与续期
- 官方回调接收
- 网页登录态凭据写入
- 资料探测与绑店回写
- 模拟授权完成
- 店铺激活
- 网页登录态校验结果回写
- 浏览器续登结果回写

## `database.ts` 的收口原则

- 店铺接入相关入口只保留委托，不再保留重复历史实现。
- 公共基础设施能力仍保留在 `StatisticsDatabase`，例如数据库连接与非店铺接入域的通用逻辑。
- 后续新增店铺接入能力优先落到读写仓储，不再直接回填到 `database.ts`。

## 当前收益

- `database.ts` 在店铺接入域的认知负担明显下降。
- 店铺接入写链路已经具备独立修改、独立回归的能力。
- 后续可按同样模式继续拆订单、售后、资金、AI 工作台。

## 后续建议

- 继续把 `database.ts` 中店铺接入残余辅助逻辑外提到仓储或服务层。
- 为读写仓储补更细粒度的单元测试，而不只依赖 `app.test.ts` 的集成覆盖。
- 下一阶段优先拆订单与售后域。
