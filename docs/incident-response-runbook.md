# 事件响应手册

## 目标

当系统出现不可用、数据异常、履约积压或大面积告警时，要求运维按固定顺序处置，避免二次破坏。

## 一级检查

1. 访问 `GET /api/health`
2. 查看 `GET /api/metrics`
3. 执行 `npm run db:doctor`
4. 检查最新结构化日志

## 常见场景

### 启动失败

- 先执行 `npm run preflight`
- 检查是否缺少前端构建产物
- 检查密钥、管理员账号和目录权限
- 检查数据库文件是否存在以及是否可写

### 接口大量 5xx

- 从日志按 `requestId` 和 `event=request_error` 检索
- 查看 `sale_compass_http_request_errors_total`
- 对照 `sale_compass_fulfillment_jobs_failed`
- 必要时暂停高风险写操作入口

### 履约堆积

- 查看 `sale_compass_fulfillment_jobs_pending`
- 进入订单中心和运维工作台定位失败队列
- 检查第三方回调、货源和直充供应商状态

### 数据恢复

- 先备份当前正式库
- 仅恢复到预演库验证
- 验证通过后再替换正式库
- 恢复后重新执行 `db:doctor`

## 事件复盘最少要素

- 发生时间
- 影响范围
- 首次告警来源
- 根因
- 修复动作
- 回滚动作
- 防再发措施
