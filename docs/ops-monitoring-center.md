# 运维监控中心

## 目标

第 14 轮将系统工作台扩展为统一的运维监控入口，覆盖以下四类能力：

- 系统告警：接口失败、发货失败、库存异常、店铺掉线。
- 任务监控：卡密发货、直充发货、货源推单、店铺体检。
- 数据安全：数据库备份、日志归档、恢复演练。
- 操作留痕：所有运维动作均写入工作台日志和审计日志。

入口：

- 页面：`/workspace/system-monitoring`
- 后端详情接口：`GET /api/workspaces/system-monitoring/detail`

## 告警规则

### 接口失败

- 统计最近 7 天审计失败。
- 统计直充回调验签失败。
- 统计货源回调验签失败。

### 发货失败

- 统计卡密发货失败任务。
- 统计直充失败或转人工任务。
- 统计货源推单失败或转人工任务。

### 库存异常

- 直接复用卡密低库存告警表。
- 当前以 `card_stock_alerts.status = open` 作为触发条件。

### 店铺掉线

- 统计启用店铺中 `connection_status` 或 `health_status` 为 `offline` / `abnormal` 的记录。

## 任务监控

工作台提供四组运维监控行：

- 卡密发货
- 直充发货
- 货源推单
- 店铺体检

每组输出：

- 待处理数量
- 失败数量
- 人工介入数量
- 最近更新时间

## 备份与恢复

### 在线动作

- `POST /api/workspaces/system-monitoring/backups/run`
- `POST /api/workspaces/system-monitoring/log-archives/run`
- `POST /api/workspaces/system-monitoring/recovery-drills/run`

### CLI 脚本

- 备份：`npm run backup:db`
- 恢复：`npm run restore:db -- --backup <备份文件路径>`

说明：

- 备份脚本默认输出到 `APP_BACKUP_ROOT`。
- 恢复脚本默认恢复到 `APP_BACKUP_ROOT/restore-preview/`，用于演练和验证。
- 如需覆盖正式数据库，应先停服务，再显式传入 `--target <数据库路径>`。

## 日志归档与查询

在线查询采用双通道：

- 近期日志：直接查看 `open-logs` 与 `system-monitoring` 工作台。
- 历史归档：查看 `system_log_archives` 记录并读取对应 JSON 文件。

归档文件内容包括：

- 归档编号
- 时间区间
- 日志数量
- 审计日志原始列表

## 关键目录

- 备份目录：`APP_BACKUP_ROOT`
- 日志归档目录：默认位于 `APP_LOG_ROOT/archive`
- 恢复演练目录：默认位于 `APP_BACKUP_ROOT/recovery-drills`

如果运行时使用了自定义数据库路径，测试环境会自动回落到数据库同级目录，避免污染正式目录。
