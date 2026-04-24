// @ts-nocheck
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { StatisticsDatabase } from './database.js';
import {
  directChargeCallbackSchema,
  supplySourceCallbackSchema,
  supplySourceRefundSchema,
} from './schemas.js';

interface ExternalFulfillmentCallbackRouteDeps {
  app: FastifyInstance;
  db: StatisticsDatabase;
}

const supplierKeyParamsSchema = z.object({
  supplierKey: z.string().min(1),
});

const systemKeyParamsSchema = z.object({
  systemKey: z.string().min(1),
});

export function registerExternalFulfillmentCallbackRoutes({
  app,
  db,
}: ExternalFulfillmentCallbackRouteDeps) {
  app.post('/api/direct-charge/callbacks/:supplierKey', async (request, reply) => {
    const params = supplierKeyParamsSchema.parse(request.params);
    const body = directChargeCallbackSchema.parse(request.body ?? {});
    const payload = db.processDirectChargeCallback(params.supplierKey, body);
    if (!payload) {
      return reply.code(404).send({ message: '供应商不存在' });
    }
    return payload;
  });

  app.post('/api/source-supply/callbacks/:systemKey', async (request, reply) => {
    const params = systemKeyParamsSchema.parse(request.params);
    const body = supplySourceCallbackSchema.parse(request.body ?? {});
    const payload = db.processSupplySourceCallback(params.systemKey, body);
    if (!payload) {
      return reply.code(404).send({ message: '货源系统不存在。' });
    }
    return payload;
  });

  app.post('/api/source-supply/refunds/:systemKey', async (request, reply) => {
    const params = systemKeyParamsSchema.parse(request.params);
    const body = supplySourceRefundSchema.parse(request.body ?? {});
    const payload = db.processSupplySourceRefundNotice(params.systemKey, body);
    if (!payload) {
      return reply.code(404).send({ message: '货源系统不存在。' });
    }
    return payload;
  });
}
