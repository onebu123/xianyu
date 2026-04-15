# 数据库运维手册

## 适用范围

当前版本默认使用 SQLite 单文件数据库，运维重点是：

- 启动前巡检
- 运行中备份
- 恢复前验证
- 结构迁移校验

## 巡检命令

### 查看数据库元数据

```bash
npm run db:inspect
```

输出包含：

- 数据库路径
- 文件大小
- `user_version`
- `journal_mode`
- 核心表和关键计数
- 最近备份文件

### 执行数据库诊断

```bash
npm run db:doctor
```

严格模式：

```bash
npm run db:doctor -- --strict true
```

诊断项包含：

- 数据库文件是否存在
- SQLite 完整性检查
- schema 版本是否落后
- 核心表是否齐全
- 关键列是否缺失
- 备份目录是否存在
- 是否已有最近备份

## 备份

执行备份：

```bash
npm run backup:db
```

建议：

- 每天至少一次
- 升级前必须执行
- 故障处理前先保留当前库快照

## 恢复预演

恢复到预览库：

```bash
npm run restore:db -- --backup <备份文件路径>
```

恢复后建议立即执行：

```bash
npm run db:inspect -- --db <恢复后的数据库路径>
npm run db:doctor -- --db <恢复后的数据库路径>
```

## 故障处置顺序

1. 先执行 `db:inspect`
2. 再执行 `db:doctor`
3. 如完整性异常，立刻冻结原库文件
4. 从最近一次可用备份恢复到预演库
5. 验证订单、账号、备份记录和关键表数量
6. 再决定是否替换正式库
