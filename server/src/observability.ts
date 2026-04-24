import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ResolvedAppConfig } from './config.js';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const REQUEST_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

interface RequestMetricRow {
  method: string;
  route: string;
  statusClass: string;
  count: number;
  durationSum: number;
  bucketCounts: number[];
}

interface AppLogRecord {
  timestamp: string;
  level: LogLevel;
  service: string;
  runtimeMode: string;
  envProfile: string;
  event: string;
  message: string;
  [key: string]: unknown;
}

function logLevelPriority(level: LogLevel) {
  const priorities: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
  };
  return priorities[level];
}

function escapePrometheusLabel(value: string | number | boolean | null | undefined) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

function createLabelString(labels: Record<string, string | number | boolean | null | undefined>) {
  const rows = Object.entries(labels).map(([key, value]) => `${key}="${escapePrometheusLabel(value)}"`);
  return rows.length > 0 ? `{${rows.join(',')}}` : '';
}

function createMetricKey(method: string, route: string, statusClass: string) {
  return `${method}::${route}::${statusClass}`;
}

const logRedactedQueryKeys = new Set(['streamtoken', 'token', 'access_token', 'refresh_token']);

export function createRequestId() {
  return `req_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function sanitizeUrlForLog(rawUrl: string) {
  const [pathname, search = ''] = rawUrl.split('?', 2);
  if (!search) {
    return rawUrl;
  }

  const params = new URLSearchParams(search);
  let mutated = false;
  for (const key of [...params.keys()]) {
    if (!logRedactedQueryKeys.has(key.toLowerCase())) {
      continue;
    }
    params.set(key, '[REDACTED]');
    mutated = true;
  }

  if (!mutated) {
    return rawUrl;
  }

  const nextQuery = params.toString();
  return nextQuery ? `${pathname}?${nextQuery}` : pathname;
}

export function resolveRouteLabel(request: FastifyRequest) {
  const routePath = request.routeOptions?.url?.trim();
  if (routePath) {
    return routePath;
  }

  return request.url.split('?')[0] || 'unknown';
}

export function createAppLogger(config: ResolvedAppConfig) {
  const minimumLevel = logLevelPriority(config.logLevel);
  const logFilePath = path.join(config.logDir, 'app-runtime.log');

  fs.mkdirSync(config.logDir, { recursive: true });

  const writeLog = (level: LogLevel, event: string, message: string, extra: Record<string, unknown> = {}) => {
    if (logLevelPriority(level) < minimumLevel) {
      return;
    }

    const record: AppLogRecord = {
      timestamp: new Date().toISOString(),
      level,
      service: 'goofish-sale-statistics',
      runtimeMode: config.runtimeMode,
      envProfile: config.envProfile,
      event,
      message,
      ...extra,
    };
    const serialized = JSON.stringify(record);

    if (level === 'error') {
      console.error(serialized);
    } else if (level === 'warn') {
      console.warn(serialized);
    } else {
      console.log(serialized);
    }

    fs.appendFile(logFilePath, `${serialized}\n`, () => {});
  };

  return {
    debug(event: string, message: string, extra?: Record<string, unknown>) {
      writeLog('debug', event, message, extra);
    },
    info(event: string, message: string, extra?: Record<string, unknown>) {
      writeLog('info', event, message, extra);
    },
    warn(event: string, message: string, extra?: Record<string, unknown>) {
      writeLog('warn', event, message, extra);
    },
    error(event: string, message: string, extra?: Record<string, unknown>) {
      writeLog('error', event, message, extra);
    },
    logFilePath,
  };
}

export class AppMetricsCollector {
  private readonly startedAt = Date.now();
  private readonly requestRows = new Map<string, RequestMetricRow>();
  private activeRequests = 0;
  private requestErrors = 0;

  startRequest() {
    this.activeRequests += 1;
    return process.hrtime.bigint();
  }

  finishRequest(input: { method: string; route: string; statusCode: number; startedAt: bigint }) {
    const durationSeconds = Number(process.hrtime.bigint() - input.startedAt) / 1_000_000_000;
    const statusClass = `${Math.floor(input.statusCode / 100)}xx`;
    const key = createMetricKey(input.method, input.route, statusClass);
    const row =
      this.requestRows.get(key) ??
      ({
        method: input.method,
        route: input.route,
        statusClass,
        count: 0,
        durationSum: 0,
        bucketCounts: REQUEST_DURATION_BUCKETS.map(() => 0),
      } satisfies RequestMetricRow);

    row.count += 1;
    row.durationSum += durationSeconds;
    REQUEST_DURATION_BUCKETS.forEach((bucket, index) => {
      if (durationSeconds <= bucket) {
        row.bucketCounts[index] += 1;
      }
    });
    if (input.statusCode >= 500) {
      this.requestErrors += 1;
    }

    this.requestRows.set(key, row);
    this.activeRequests = Math.max(this.activeRequests - 1, 0);

    return {
      durationSeconds,
      statusClass,
    };
  }

  snapshot() {
    return {
      startedAt: this.startedAt,
      uptimeSeconds: Math.max((Date.now() - this.startedAt) / 1000, 0),
      activeRequests: this.activeRequests,
      requestErrors: this.requestErrors,
      requests: [...this.requestRows.values()],
    };
  }

  renderPrometheus(input: {
    config: ResolvedAppConfig;
    version: string;
    healthSnapshot?: {
      database?: { sizeBytes?: number };
      alerts?: { activeCount?: number; criticalCount?: number };
      jobs?: { failedCount?: number; pendingCount?: number };
      backups?: { successCount?: number };
      openPlatform?: {
        appCount?: number;
        activeAppCount?: number;
        recentCallCount?: number;
        blockedCallCount?: number;
      };
    };
  }) {
    const snapshot = this.snapshot();
    const labels = {
      service: 'goofish-sale-statistics',
      runtime_mode: input.config.runtimeMode,
      env_profile: input.config.envProfile,
      version: input.version,
    };
    const memoryUsage = process.memoryUsage();
    const rows: string[] = [];

    rows.push('# HELP sale_compass_info 应用基础信息。');
    rows.push('# TYPE sale_compass_info gauge');
    rows.push(`sale_compass_info${createLabelString(labels)} 1`);
    rows.push('# HELP sale_compass_runtime_profile Runtime deployment profile information.');
    rows.push('# TYPE sale_compass_runtime_profile gauge');
    rows.push(
      `sale_compass_runtime_profile${createLabelString({
        deployment_mode: input.config.deploymentMode,
        background_jobs_mode: input.config.backgroundJobsMode,
        queue_backend: input.config.queueBackend,
        control_plane_db_engine: input.config.controlPlaneDatabaseEngine,
      })} 1`,
    );

    rows.push('# HELP sale_compass_uptime_seconds 应用运行时长（秒）。');
    rows.push('# TYPE sale_compass_uptime_seconds gauge');
    rows.push(`sale_compass_uptime_seconds ${snapshot.uptimeSeconds.toFixed(3)}`);

    rows.push('# HELP sale_compass_http_requests_in_flight 当前正在处理的请求数量。');
    rows.push('# TYPE sale_compass_http_requests_in_flight gauge');
    rows.push(`sale_compass_http_requests_in_flight ${snapshot.activeRequests}`);

    rows.push('# HELP sale_compass_http_request_errors_total 5xx 请求总数。');
    rows.push('# TYPE sale_compass_http_request_errors_total counter');
    rows.push(`sale_compass_http_request_errors_total ${snapshot.requestErrors}`);

    rows.push('# HELP sale_compass_http_requests_total HTTP 请求总数。');
    rows.push('# TYPE sale_compass_http_requests_total counter');
    snapshot.requests.forEach((row) => {
      rows.push(
        `sale_compass_http_requests_total${createLabelString({
          method: row.method,
          route: row.route,
          status_class: row.statusClass,
        })} ${row.count}`,
      );
    });

    rows.push('# HELP sale_compass_http_request_duration_seconds HTTP 请求耗时分布。');
    rows.push('# TYPE sale_compass_http_request_duration_seconds histogram');
    snapshot.requests.forEach((row) => {
      let cumulativeCount = 0;
      REQUEST_DURATION_BUCKETS.forEach((bucket, index) => {
        cumulativeCount = row.bucketCounts[index] ?? cumulativeCount;
        rows.push(
          `sale_compass_http_request_duration_seconds_bucket${createLabelString({
            method: row.method,
            route: row.route,
            status_class: row.statusClass,
            le: bucket,
          })} ${cumulativeCount}`,
        );
      });
      rows.push(
        `sale_compass_http_request_duration_seconds_bucket${createLabelString({
          method: row.method,
          route: row.route,
          status_class: row.statusClass,
          le: '+Inf',
        })} ${row.count}`,
      );
      rows.push(
        `sale_compass_http_request_duration_seconds_sum${createLabelString({
          method: row.method,
          route: row.route,
          status_class: row.statusClass,
        })} ${row.durationSum.toFixed(6)}`,
      );
      rows.push(
        `sale_compass_http_request_duration_seconds_count${createLabelString({
          method: row.method,
          route: row.route,
          status_class: row.statusClass,
        })} ${row.count}`,
      );
    });

    rows.push('# HELP sale_compass_process_resident_memory_bytes 进程常驻内存大小。');
    rows.push('# TYPE sale_compass_process_resident_memory_bytes gauge');
    rows.push(`sale_compass_process_resident_memory_bytes ${memoryUsage.rss}`);

    rows.push('# HELP sale_compass_process_heap_used_bytes Node.js 已使用堆内存。');
    rows.push('# TYPE sale_compass_process_heap_used_bytes gauge');
    rows.push(`sale_compass_process_heap_used_bytes ${memoryUsage.heapUsed}`);

    rows.push('# HELP sale_compass_database_size_bytes SQLite 数据库文件大小。');
    rows.push('# TYPE sale_compass_database_size_bytes gauge');
    rows.push(`sale_compass_database_size_bytes ${input.healthSnapshot?.database?.sizeBytes ?? 0}`);

    rows.push('# HELP sale_compass_system_alerts_active 当前未恢复告警数量。');
    rows.push('# TYPE sale_compass_system_alerts_active gauge');
    rows.push(`sale_compass_system_alerts_active ${input.healthSnapshot?.alerts?.activeCount ?? 0}`);

    rows.push('# HELP sale_compass_system_alerts_critical 当前严重告警数量。');
    rows.push('# TYPE sale_compass_system_alerts_critical gauge');
    rows.push(`sale_compass_system_alerts_critical ${input.healthSnapshot?.alerts?.criticalCount ?? 0}`);

    rows.push('# HELP sale_compass_fulfillment_jobs_failed 当前失败履约任务数量。');
    rows.push('# TYPE sale_compass_fulfillment_jobs_failed gauge');
    rows.push(`sale_compass_fulfillment_jobs_failed ${input.healthSnapshot?.jobs?.failedCount ?? 0}`);

    rows.push('# HELP sale_compass_fulfillment_jobs_pending 当前待处理履约任务数量。');
    rows.push('# TYPE sale_compass_fulfillment_jobs_pending gauge');
    rows.push(`sale_compass_fulfillment_jobs_pending ${input.healthSnapshot?.jobs?.pendingCount ?? 0}`);

    rows.push('# HELP sale_compass_backups_success_total 成功备份次数。');
    rows.push('# TYPE sale_compass_backups_success_total gauge');
    rows.push(`sale_compass_backups_success_total ${input.healthSnapshot?.backups?.successCount ?? 0}`);

    rows.push('# HELP sale_compass_runtime_strict_mode 是否启用严格模式。');
    rows.push('# TYPE sale_compass_runtime_strict_mode gauge');
    rows.push(`sale_compass_runtime_strict_mode ${input.config.runtimeMode === 'demo' ? 0 : 1}`);

    rows.push('# HELP sale_compass_open_platform_apps_total Total registered open-platform apps.');
    rows.push('# TYPE sale_compass_open_platform_apps_total gauge');
    rows.push(`sale_compass_open_platform_apps_total ${input.healthSnapshot?.openPlatform?.appCount ?? 0}`);
    rows.push('# HELP sale_compass_open_platform_apps_active Active open-platform apps.');
    rows.push('# TYPE sale_compass_open_platform_apps_active gauge');
    rows.push(`sale_compass_open_platform_apps_active ${input.healthSnapshot?.openPlatform?.activeAppCount ?? 0}`);
    rows.push('# HELP sale_compass_open_platform_calls_recent Recent open-platform calls.');
    rows.push('# TYPE sale_compass_open_platform_calls_recent gauge');
    rows.push(`sale_compass_open_platform_calls_recent ${input.healthSnapshot?.openPlatform?.recentCallCount ?? 0}`);
    rows.push('# HELP sale_compass_open_platform_calls_blocked_recent Recent blocked open-platform calls.');
    rows.push('# TYPE sale_compass_open_platform_calls_blocked_recent gauge');
    rows.push(
      `sale_compass_open_platform_calls_blocked_recent ${input.healthSnapshot?.openPlatform?.blockedCallCount ?? 0}`,
    );

    return `${rows.join('\n')}\n`;
  }
}

export function summarizeRequestForLog(input: {
  request: FastifyRequest;
  reply: FastifyReply;
  route: string;
  durationSeconds: number;
}) {
  return {
    requestId: input.request.id,
    method: input.request.method,
    route: input.route,
    url: sanitizeUrlForLog(input.request.url),
    statusCode: input.reply.statusCode,
    durationMs: Number((input.durationSeconds * 1000).toFixed(2)),
    ipAddress: input.request.ip,
    userAgent: input.request.headers['user-agent'] ?? '',
  };
}
