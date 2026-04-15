# 闲鱼真实接入改造方案

## 1. 结论

当前仓库已经不是“纯模拟”状态，实际上已经落了一层真实授权骨架：

- 后端已经支持 `APP_STORE_AUTH_MODE=xianyu_browser_oauth`。
- 已经可以生成闲鱼授权地址、接收浏览器回调、加密保存 `access token`。
- 前端已经有真实授权页和回调页。

但它仍然不适合直接拿真实闲鱼账号做联调，原因也很明确：

- 真实回调目前只做到“令牌入库”，还没有做到“资料换取、店铺绑入、真实探活”。
- 店铺创建和重新授权的主链路仍然以本地模拟表单和本地状态机为主。
- 回调处理依赖后台当前登录态和同浏览器弹窗，不适合作为正式生产授权链路。

建议按两步推进：

1. 先把“真实授权骨架”补到可联调状态。
2. 再接平台资料，完成真实绑店与真实体检。

## 2. 当前实现盘点

### 2.1 已有真实骨架

- `server/src/store-auth-providers.ts`
  - 已支持按闲鱼平台生成真实授权地址。
  - 已生成 `state`，并区分 `simulated` 与 `xianyu_browser_oauth`。
- `server/src/database.ts`
  - `createStoreAuthSession` 已把真实模式字段写入 `store_auth_sessions`。
  - `receiveStoreAuthProviderCallback` 已校验 `state`，并把 `access token` 加密写入 `store_platform_credentials`。
  - `store_platform_credentials` 已预留 `refresh_token_encrypted`、`provider_user_id`、`provider_shop_id`、`provider_shop_name` 等字段。
- `web/src/pages/StoreAuthorizePage.tsx`
  - 已区分模拟授权页和真实闲鱼授权页。
  - 真实模式下会展示回调地址、令牌接收状态和跳转按钮。
- `web/src/pages/StoreAuthorizeCallbackPage.tsx`
  - 已能从 URL `hash/query` 里读取授权回调参数，并把回调内容提交给后端。

### 2.2 仍然是模拟的部分

- `server/src/database.ts` 的 `completeStoreAuthSession`
  - 只有 `simulated` 模式能真正完成建店或重新授权。
  - 真实模式会直接拦截，要求先完成官方回调。
- `server/src/database.ts` 的 `runStoreHealthCheck`
  - 只是根据本地状态推导 `healthy / warning / offline / abnormal`。
  - 没有真实调用闲鱼接口做探活、权限校验或资料核验。
- `web/src/pages/StoreAuthorizePage.tsx`
  - 模拟模式仍然使用手机号、验证码、昵称表单直接完成授权。
- `web/src/pages/StoresPage.tsx`
  - 只监听 `store-auth-complete`，没有处理 `store-auth-provider-callback` 的刷新动作。

## 3. 当前不适合真实联调的关键模拟点

### 3.1 店铺主数据仍是本地生成

当前新建店铺时，店铺名、卖家号、分组、标签、套餐描述等大量字段仍由本地逻辑生成，不是平台回传：

- `sellerNo` 由本地 `buildSellerNo` 生成。
- `shopName`、`nickname` 来自页面表单。
- `packageText`、`publishLimitText` 是固定文案。

这意味着系统还没有建立“本地店铺 ID”与“平台真实店铺 ID”的稳定映射。

### 3.2 真实回调只做了令牌入库

`receiveStoreAuthProviderCallback` 当前完成的动作只有：

- 校验 `sessionId + state`。
- 脱敏并加密保存 `access token`。
- 将下一步标记为 `pending_profile_sync`。

当前还没有：

- 用令牌换取卖家资料。
- 拉取店铺资料。
- 绑定 `provider_user_id / provider_shop_id`。
- 依据真实资料创建或更新 `managed_stores`。

### 3.3 回调链路仍依赖后台当前登录态

当前回调页会直接调用：

- `POST /api/stores/auth-sessions/:sessionId/provider-callback`

这个接口仍挂在后台鉴权体系下，需要当前浏览器里有后台 `Bearer Token`。这有两个问题：

- 真实授权回调强依赖“同一浏览器、同一后台登录态”。
- 正式平台联调时，回调入口不应依赖操作员当前会话是否还有效。

### 3.4 授权返回使用前端直接接触令牌的模式

当前授权地址固定写的是：

- `response_type=token`

这意味着 `access token` 会先出现在浏览器回调地址里，再由前端页面读出后提交后端。这个模式可以用于骨架联调，但不适合直接作为长期生产方案：

- 令牌会经过浏览器地址栏和前端页面。
- 若平台支持 `authorization code`，应优先切到服务端换票模式。
- 若平台只支持 `token` 回调，则必须做最小暴露处理，例如立即清理 URL、最小化页面依赖、禁止第三方脚本。

### 3.5 体检与风控仍是本地状态机

当前体检结果并不反映平台真实状态，只反映本地状态流转：

- 授权过期 -> `offline`
- 授权失效 -> `abnormal`
- 待激活 -> `warning`

这适合本地流程测试，不适合用来判断真实闲鱼账号是否还能正常调度。

### 3.6 配置模板与真实模式不完全对齐

代码已经支持：

- `APP_STORE_AUTH_MODE`
- `APP_XIANYU_APP_KEY`
- `APP_XIANYU_APP_SECRET`
- `APP_XIANYU_CALLBACK_BASE_URL`
- `APP_XIANYU_AUTHORIZE_BASE_URL`
- `APP_XIANYU_FORCE_AUTH`

但此前环境模板未完整体现这些真实接入参数，容易导致“代码支持了，部署模板没跟上”。

## 4. 真实接入目标架构

建议把真实闲鱼接入拆成四段：

1. 授权会话创建
   - 操作员发起新接入或重新授权。
   - 后端生成会话、签名态、回调票据、过期时间。
2. 平台授权回调接收
   - 只负责接住平台回调并安全保存授权结果。
   - 不在这一跳里直接写死建店逻辑。
3. 资料换取与绑店
   - 用授权结果换取卖家资料、店铺资料、权限范围。
   - 成功后再创建或更新 `managed_stores` 与 `store_owner_accounts`。
4. 体检与持续校验
   - 定时校验令牌、权限、店铺资料和必要探活接口。
   - 决定店铺是否允许参与正式调度。

## 5. 后端改造方案

### 5.1 接口改造

建议保留现有接口入口，但补齐真实模式所需的步骤型接口。

#### 保留

- `POST /api/stores/auth-sessions`
  - 继续负责创建授权会话。
- `GET /api/stores/auth-sessions/:sessionId`
  - 继续作为授权弹窗轮询详情接口。

#### 调整

- `POST /api/stores/auth-sessions/:sessionId/provider-callback`
  - 不建议继续依赖后台操作员 `Bearer Token`。
  - 第一版真实骨架建议改为“带一次性回调票据或签名态即可调用”。

#### 新增

- `POST /api/stores/auth-sessions/:sessionId/profile-sync`
  - 手动触发一次资料同步与绑店。
  - 第一版可以先由操作员点击触发，避免一上来就做复杂异步任务编排。
- `POST /api/stores/:storeId/credential-verify`
  - 基于真实令牌做一次即时探活。
  - 用于替代当前纯本地状态机体检。

### 5.2 授权状态机改造

建议把 `store_auth_sessions` 的真实流程状态扩成下面这组：

- `pending_authorize`
- `callback_received`
- `pending_profile_sync`
- `profile_syncing`
- `bound`
- `failed`
- `expired`
- `invalidated`

兼容方案：

- `simulated` 继续沿用当前简单状态。
- `xianyu_browser_oauth` 进入更细的步骤状态。

### 5.3 数据表改造

#### 现有可复用表

- `store_auth_sessions`
- `managed_stores`
- `store_owner_accounts`
- `store_platform_credentials`
- `store_health_checks`
- `audit_logs`

#### 建议新增字段

`store_auth_sessions`

- `next_step`
- `callback_received_at`
- `profile_sync_status`
- `profile_sync_error`
- `profile_synced_at`
- `callback_ticket_hash`
- `provider_error_code`
- `provider_error_message`

`managed_stores`

- `provider_store_id`
- `provider_user_id`
- `credential_id`
- `profile_sync_status`
- `profile_sync_error`
- `last_profile_sync_at`
- `last_verified_at`

`store_platform_credentials`

- 当前字段已经比较完整，第一版可直接复用。
- 需要补的是：
  - 真实写入 `refresh_token_encrypted`
  - 真实写入 `scope_text`
  - 真实写入 `provider_user_id`
  - 真实写入 `provider_shop_id`
  - 真实写入 `provider_shop_name`

#### 约束建议

- `managed_stores(platform, provider_store_id)` 建唯一索引。
- `store_platform_credentials(platform, provider_key, provider_shop_id, credential_type)` 建唯一约束或唯一逻辑。

### 5.4 适配器分层

建议把闲鱼真实能力从当前的“授权 URL 生成器”升级成真正的平台适配器。

建议新增：

- `server/src/store-platform-adapters/xianyu.ts`

统一暴露方法：

- `buildAuthorizeUrl`
- `acceptCallback`
- `exchangeToken` 或 `normalizeTokenPayload`
- `fetchAuthorizedProfile`
- `fetchShopProfile`
- `verifyCredential`
- `refreshCredential`

第一版真实骨架可以先做到：

- `acceptCallback`
- `fetchAuthorizedProfile`
- `fetchShopProfile`
- `verifyCredential`

如果平台资料未齐，适配器可以先返回结构化的 `pending_platform_params` 错误，而不是继续写死模拟数据。

## 6. 前端改造方案

### 6.1 店铺列表页

`web/src/pages/StoresPage.tsx` 需要补三类能力：

- 监听 `store-auth-provider-callback`，收到后自动刷新授权会话区和店铺区。
- 在会话列表里展示真实模式步骤，例如：
  - 已跳转平台
  - 已接收回调
  - 待资料同步
  - 绑定成功
  - 同步失败
- 在店铺列表里展示真实探活结果，而不是只展示本地状态文案。

### 6.2 授权弹窗页

`web/src/pages/StoreAuthorizePage.tsx` 建议继续保留“模拟模式 / 真实模式”双分支，但要做两个调整：

- 真实模式下，回调完成后不再回退到“人工填写手机号和昵称完成授权”。
- 真实模式下，页面只负责：
  - 跳转平台授权
  - 展示会话状态
  - 必要时触发“继续同步资料”

### 6.3 回调页

`web/src/pages/StoreAuthorizeCallbackPage.tsx` 建议改成“极简安全页”：

- 回调参数一进入页面就立即提交后端。
- 提交后立即执行 `history.replaceState` 清理 `hash/query` 中的敏感参数。
- 页面中不加载任何不必要的远端资源。
- 成功后自动通知父窗口刷新并自动关闭。

## 7. 凭据、回调、风控、审计收口方案

### 7.1 凭据收口

建议以 `store_platform_credentials` 为唯一平台凭据主表：

- `access token` 只存密文和脱敏值。
- 若平台支持 `refresh token`，同样只存密文。
- 不在页面响应、普通日志、审计日志中输出明文。
- `APP_XIANYU_APP_SECRET` 只允许服务端读取。

额外建议：

- 当前 `secure_settings` 里存在 `xianyu_callback_secret` 演示项，但代码未使用。
- 第一版要么把它正式接入为回调签名或票据签名密钥，要么移除这个假占位，避免误导。

### 7.2 回调收口

建议回调的最小安全模型为：

- `state = sessionId + nonce + 签名`
- 回调票据一次性消费
- 回调幂等
- 超时失效
- 每次回调都落审计和技术留痕

如果平台只支持浏览器回调，不支持服务端回调：

- 仍然可以保留当前弹窗模式。
- 但后端回调接收接口必须从“操作员 JWT”切到“会话级签名票据”。

### 7.3 风控收口

建议第一版就加上下面这些硬约束：

- 授权会话创建限流
- 回调接收限流
- 资料同步重试上限
- 单会话只能绑定一个平台店铺
- 平台店铺 ID 与本地店铺 ID 一旦绑定，不允许静默覆盖
- 重新授权只允许覆盖同一平台店铺，不允许跨店串绑

### 7.4 审计收口

当前审计体系可以直接复用，但要补齐事件种类：

- 发起真实授权会话
- 接收真实授权回调
- 资料同步成功
- 资料同步失败
- 新店绑定成功
- 老店重新授权成功
- 真实体检成功
- 真实体检失败
- 凭据刷新成功
- 凭据刷新失败
- 人工失效凭据

审计日志只记录：

- 会话 ID
- 店铺 ID
- 平台店铺 ID 的脱敏值
- 结果
- 操作员
- IP
- 时间

技术留痕建议记录到会话字段或单独事件表中，不直接塞进审计正文。

## 8. 哪些现在就能做，哪些必须等平台资料

### 8.1 现在就能做

下面这些不依赖平台开放资料，当前就可以直接落：

- 改造真实授权状态机
- 把回调接口从操作员 JWT 改成会话级票据
- 在店铺列表和授权页展示真实模式步骤
- 为资料同步、真实体检补状态字段和错误字段
- 接入 `store-auth-provider-callback` 的父窗口刷新
- 将 `.env.example` 补齐真实接入开关和参数模板
- 把闲鱼适配器抽象成独立模块并保留占位实现

### 8.2 必须等你提供平台资料

下面这些必须拿到闲鱼开放平台资料后才能进入真实联调：

- 实际授权地址与参数规范
- 回调究竟返回 `token` 还是 `code`
- 是否支持服务端换票
- `access token` / `refresh token` 的有效期与刷新方式
- 获取卖家资料和店铺资料的接口地址、字段、签名规则
- 需要的 `scope` 列表和应用权限包
- 回调验签规则、IP 白名单、聚石塔部署约束
- 沙箱账号或测试账号
- 平台错误码与限流规则

## 9. 建议实施顺序

### 第一阶段：把真实授权骨架补成“可联调”

目标是让系统可以安全接住真实授权，但暂时不做深度业务同步。

交付内容：

- 会话级签名回调
- 真实授权步骤状态机
- 回调成功后的自动刷新
- 资料同步占位接口
- 环境变量模板补齐
- 审计与错误态补齐

### 第二阶段：接平台资料，完成真实绑店

交付内容：

- 用真实令牌换取卖家资料和店铺资料
- 按真实平台 ID 创建或更新本地店铺
- 真实写入 `provider_user_id / provider_shop_id`
- 替换本地生成的 `sellerNo / shopName`

### 第三阶段：替换真实体检与续期

交付内容：

- 真实探活体检
- 凭据续期或失效处理
- 店铺异常自动转 `offline / abnormal`
- 重新授权后的真实恢复验证

## 10. 当前阶段建议

在第一阶段完成前，不建议直接拿真实闲鱼账号做正式联调。

原因不是“完全没做”，而是“只做到了接令牌，还没做到接住真实业务身份”。

更准确地说，当前仓库适合：

- 本地业务流程验证
- 真实授权页面骨架调试
- 令牌安全入库链路验证

当前仓库还不适合：

- 真实店铺正式绑定
- 真实店铺状态判断
- 真实账号长期稳定联调

