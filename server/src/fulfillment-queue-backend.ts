import { Redis } from 'ioredis';

import type { ResolvedAppConfig } from './config.js';
import type { StatisticsDatabase } from './database.js';
import { createAppLogger } from './observability.js';

type AppLogger = Pick<ReturnType<typeof createAppLogger>, 'info' | 'warn' | 'error'>;

const REDIS_POP_SCRIPT = `
local key = KEYS[1]
local now = ARGV[1]
local limit = tonumber(ARGV[2])
local items = redis.call('ZRANGEBYSCORE', key, '-inf', now, 'LIMIT', 0, limit)
if #items > 0 then
  redis.call('ZREM', key, unpack(items))
end
return items
`;

function parseAvailableAt(value: string | null | undefined) {
  if (!value?.trim()) {
    return Date.now();
  }

  const parsed = Date.parse(value.replace(' ', 'T'));
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export interface FulfillmentQueueRuntimeStatus {
  kind: 'sqlite' | 'redis';
  configured: boolean;
  ready: boolean;
  connected: boolean;
  readyKey?: string;
  lastCheckedAt: string | null;
  lastError: string | null;
}

export interface FulfillmentQueueBackend {
  readonly kind: 'sqlite' | 'redis';
  ensureReady(): Promise<void>;
  enqueue(taskId: number, availableAt?: string | null): Promise<void>;
  reserveDueTaskIds(limit: number): Promise<number[]>;
  getRuntimeStatus(): FulfillmentQueueRuntimeStatus;
  close(): Promise<void>;
}

class SqliteFulfillmentQueueBackend implements FulfillmentQueueBackend {
  readonly kind = 'sqlite' as const;

  constructor(private readonly db: StatisticsDatabase) {}

  async ensureReady() {}

  async enqueue() {}

  async reserveDueTaskIds(limit: number) {
    return this.db.listPendingFulfillmentQueueTaskIds(limit);
  }

  getRuntimeStatus(): FulfillmentQueueRuntimeStatus {
    return {
      kind: this.kind,
      configured: true,
      ready: true,
      connected: true,
      lastCheckedAt: new Date().toISOString(),
      lastError: null,
    };
  }

  async close() {}
}

class RedisFulfillmentQueueBackend implements FulfillmentQueueBackend {
  readonly kind = 'redis' as const;
  private readonly redis: Redis;
  private readonly readyKey: string;
  private initialized = false;
  private connectPromise: Promise<void> | null = null;
  private lastCheckedAt: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly config: ResolvedAppConfig,
    private readonly db: StatisticsDatabase,
    private readonly logger: AppLogger,
  ) {
    this.redis = new Redis(config.redisUrl!, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    this.readyKey = `${config.redisPrefix}:fulfillment:ready`;
  }

  private async ensureInitialized() {
    if (this.initialized) {
      return;
    }
    if (!this.connectPromise) {
      this.connectPromise = this.redis
        .connect()
        .then(() => {
          this.initialized = true;
          this.lastCheckedAt = new Date().toISOString();
          this.lastError = null;
          this.logger.info('fulfillment_queue_backend_ready', 'Redis fulfillment queue backend connected', {
            queueBackend: this.kind,
            redisPrefix: this.config.redisPrefix,
          });
        })
        .catch((error: unknown) => {
          this.connectPromise = null;
          this.lastCheckedAt = new Date().toISOString();
          this.lastError = error instanceof Error ? error.message : 'unknown';
          throw error;
        });
    }
    await this.connectPromise;
  }

  async ensureReady() {
    await this.ensureInitialized();
    await this.redis.ping();
    this.lastCheckedAt = new Date().toISOString();
    this.lastError = null;
  }

  async enqueue(taskId: number, availableAt?: string | null) {
    await this.ensureInitialized();
    await this.redis.zadd(this.readyKey, String(parseAvailableAt(availableAt)), String(taskId));
  }

  async reserveDueTaskIds(limit: number) {
    await this.ensureInitialized();

    const dueTaskIds = this.db.listPendingFulfillmentQueueTaskIds(Math.max(limit * 2, limit));
    if (dueTaskIds.length > 0) {
      const pipeline = this.redis.pipeline();
      for (const taskId of dueTaskIds) {
        pipeline.zadd(this.readyKey, String(Date.now()), String(taskId));
      }
      await pipeline.exec();
    }

    const rows = (await this.redis.eval(
      REDIS_POP_SCRIPT,
      1,
      this.readyKey,
      String(Date.now()),
      String(Math.max(limit, 1)),
    )) as Array<string | number>;

    return rows
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0);
  }

  getRuntimeStatus(): FulfillmentQueueRuntimeStatus {
    return {
      kind: this.kind,
      configured: Boolean(this.config.redisUrl),
      ready: this.initialized && this.lastError === null,
      connected: this.initialized,
      readyKey: this.readyKey,
      lastCheckedAt: this.lastCheckedAt,
      lastError: this.lastError,
    };
  }

  async close() {
    if (!this.initialized && !this.connectPromise) {
      return;
    }
    await this.connectPromise;
    await this.redis.quit();
    this.initialized = false;
    this.connectPromise = null;
  }
}

export function createFulfillmentQueueBackend(input: {
  config: ResolvedAppConfig;
  db: StatisticsDatabase;
  logger: AppLogger;
}): FulfillmentQueueBackend {
  if (input.config.queueBackend === 'redis' && input.config.redisUrl) {
    return new RedisFulfillmentQueueBackend(input.config, input.db, input.logger);
  }

  return new SqliteFulfillmentQueueBackend(input.db);
}
