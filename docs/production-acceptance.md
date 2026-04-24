# 生产化验收清单

## 发布门禁

- [x] `npm run release:v2` 串联 lint、测试、构建、私有化冒烟、SaaS 冒烟、PostgreSQL 冒烟、Redis 队列冒烟、Web 冒烟、Worker 干运行和打包。
- [x] 发布包包含 `release-manifest.json`。
- [x] 版本号统一为 `2.0.0`。
- [x] 旧发布入口已移除。

## 启动基线

- [x] `npm run preflight` 可通过。
- [x] `prod/staging` 默认禁止演示数据。
- [x] 启动前可阻断缺失前端构建产物。
- [x] 启动前可阻断不可写目录。

## SaaS 基线

- [x] 控制面数据库可初始化。
- [x] 租户可创建、暂停、恢复和查询。
- [x] 初始管理员可分配。
- [x] 租户业务库可初始化。
- [x] 平台会话和租户会话隔离。

## 可观测性

- [x] 返回 `x-request-id`。
- [x] 结构化日志可落标准输出和运行时日志文件。
- [x] `GET /api/metrics` 可输出 Prometheus 文本。
- [x] 健康检查包含配置摘要和版本信息。

## 数据库运维

- [x] `npm run db:inspect` 可返回数据库元数据。
- [x] `npm run db:doctor` 可执行结构巡检。
- [x] PostgreSQL 迁移可重复执行。
- [x] 租户备份恢复可独立验证。

## 当前边界

- [ ] 真实闲鱼生产店铺需要客户授权后单独联调。
- [ ] 外部 KMS、SSO、计费系统进入后续版本。
- [ ] 大规模压测和容量报告需基于客户真实规模执行。

