# 可观测说明

## 结构化日志

服务端默认输出 JSON 行日志，写入标准输出并追加到：

```text
server/data/logs/app-runtime.log
```

每条日志至少包含以下字段：

- `timestamp`
- `level`
- `service`
- `runtimeMode`
- `envProfile`
- `event`
- `message`

请求日志额外包含：

- `requestId`
- `method`
- `route`
- `url`
- `statusCode`
- `durationMs`
- `ipAddress`

## 请求追踪

- 服务端会优先复用上游传入的 `x-request-id`
- 如果上游未传，服务端自动生成 `req_<随机串>`
- 所有响应都会回写 `x-request-id`

## Prometheus 指标

接口：

```text
GET /api/metrics
```

鉴权规则：

- 如果配置了 `APP_METRICS_TOKEN`，请求头必须携带 `x-metrics-token`
- 如果未配置 `APP_METRICS_TOKEN`，仅管理员可通过 Bearer Token 访问

当前已暴露的关键指标：

- `sale_compass_info`
- `sale_compass_uptime_seconds`
- `sale_compass_http_requests_total`
- `sale_compass_http_request_duration_seconds`
- `sale_compass_http_requests_in_flight`
- `sale_compass_http_request_errors_total`
- `sale_compass_process_resident_memory_bytes`
- `sale_compass_process_heap_used_bytes`
- `sale_compass_database_size_bytes`
- `sale_compass_system_alerts_active`
- `sale_compass_system_alerts_critical`
- `sale_compass_fulfillment_jobs_failed`
- `sale_compass_fulfillment_jobs_pending`
- `sale_compass_backups_success_total`
- `sale_compass_runtime_strict_mode`

## 推荐接入方式

### Prometheus

- 使用 `x-metrics-token` 采集
- 建议仅在内网或反向代理白名单内开放

### Loki / ELK

- 直接采集标准输出 JSON 行
- 按 `requestId`、`event`、`statusCode` 建索引

### Grafana

- 以接口错误率、备份成功次数、失败任务数和数据库文件大小作为第一批面板
