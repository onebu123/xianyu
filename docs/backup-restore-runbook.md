# 数据库备份恢复手册

## 备份

### 在线执行

1. 打开 `/workspace/system-monitoring`
2. 点击“执行备份”
3. 在“备份记录”确认新备份已生成

### CLI 执行

```bash
npm run backup:db
```

可选参数：

```bash
npm run backup:db -- --output-dir ./data/custom-backups --prefix nightly
```

输出包含：

- `*.sqlite`：数据库备份文件
- `*.sqlite.json`：备份清单文件

## 恢复验证

### 演练方式

```bash
npm run restore:db -- --backup ./data/backups/goofish-db-20260311-120000.sqlite
```

默认恢复到：

- `APP_BACKUP_ROOT/restore-preview/restored-<timestamp>.db`

脚本会自动校验：

- 表数量
- 订单数量
- 后台账号数量

## 覆盖恢复

生产环境执行覆盖恢复前必须：

1. 停止后端服务
2. 备份当前数据库
3. 明确目标数据库路径

示例：

```bash
npm run restore:db -- --backup ./data/backups/goofish-db-20260311-120000.sqlite --target ./server/data/app.db
```

## 日志归档

在线动作：

- 在 `/workspace/system-monitoring` 点击“归档日志”

归档文件位置：

- 默认：`APP_LOG_ROOT/archive`

归档文件格式：

- JSON
- 含归档编号、时间区间、日志数量、原始日志内容

## 恢复演练

在线动作：

1. 先执行一次成功备份
2. 在 `/workspace/system-monitoring` 点击“恢复演练”
3. 在“恢复演练”列表核对：
   - 备份编号
   - 演练状态
   - 耗时
   - 恢复目标路径

## 排障建议

- 备份失败：优先检查数据库文件权限和备份目录权限。
- 恢复失败：确认备份文件存在且不是空文件。
- 日志归档为空：先检查近期是否已有审计日志。
- 告警反复 reopen：说明底层异常仍存在，不能只做手动关闭。
