# 生产化推进路线

## 目标

当前 `v1.0.0` 已具备私有化交付能力，本路线用于继续把项目收紧到可持续运行、可发布、可诊断的生产级基线。

## 已完成项

### 阶段 1：运行基线

- 启动前强校验 `prod/staging/demo` 配置
- 默认关闭演示数据
- 新增 `npm run preflight`
- 新增 `.env.development`、`.env.staging`、`.env.production` 模板
- 启动前校验前端构建产物和目录可写性

### 阶段 2：可观测

- 统一 `x-request-id`
- 结构化 JSON 运行日志
- `GET /api/metrics` Prometheus 指标
- 健康检查补充版本、环境摘要和运行配置摘要

### 阶段 3：数据库运维

- 新增 `npm run db:inspect`
- 新增 `npm run db:doctor`
- 落地 SQLite `user_version` schema 版本
- 检查核心表、关键列、完整性和备份目录状态

### 阶段 4：发布治理

- 新增 `npm run smoke:release`
- `release:v1` 改为 `lint + test + build + smoke + package`
- 补 GitHub Actions CI

## 下一步建议

- 引入外部数据库方案评估与迁移计划
- 增加日志采集、指标采集和告警接入样例
- 增加压测脚本和容量基线
- 增加值班、故障复盘和升级演练制度
