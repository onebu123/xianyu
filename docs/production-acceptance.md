# 生产化验收清单

## 启动基线

- [x] `npm run preflight` 可通过
- [x] `prod/staging` 模式默认禁止演示数据
- [x] 启动前可阻断缺失的前端构建产物
- [x] 启动前可阻断不可写目录

## 可观测

- [x] 返回 `x-request-id`
- [x] 结构化日志可落标准输出和运行日志文件
- [x] `GET /api/metrics` 可输出 Prometheus 文本
- [x] 健康检查包含配置摘要和版本信息

## 数据库运维

- [x] `npm run db:inspect` 可返回数据库元数据
- [x] `npm run db:doctor` 可执行结构巡检
- [x] SQLite `user_version` 已落地
- [x] 旧库升级后仍可正常启动

## 发布治理

- [x] `release:v1` 已强制串联 `lint`、`test`、`build`、`smoke:release`
- [x] 本地存在发布烟测脚本
- [x] GitHub Actions CI 已配置

## 当前边界

- [ ] 仍为单机 SQLite 架构，未切换到 PostgreSQL / MySQL
- [ ] 尚未纳入外部日志平台与告警平台
- [ ] 尚未形成压测与容量基线报告
