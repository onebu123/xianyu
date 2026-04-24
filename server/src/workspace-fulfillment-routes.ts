// @ts-nocheck
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { DatabaseProvider } from './database-provider.js';
import type { StatisticsDatabase } from './database.js';
import {
  cardImportSchema,
  cardRecycleSchema,
  directChargeManualReviewSchema,
  supplySourceManualReviewSchema,
  supplySourceSyncSchema,
} from './schemas.js';

interface WorkspaceFulfillmentRouteDeps {
  app: FastifyInstance;
  db: StatisticsDatabase;
  databaseProvider?: DatabaseProvider;
  authorizeWorkspace: (mode: 'view' | 'manage') => unknown;
  backgroundJobsMode: 'embedded' | 'worker' | 'disabled';
  publishFulfillmentQueueTask: (payload: any) => Promise<void>;
}

export function registerWorkspaceFulfillmentRoutes({
  app,
  db,
  databaseProvider,
  authorizeWorkspace,
  backgroundJobsMode,
  publishFulfillmentQueueTask,
}: WorkspaceFulfillmentRouteDeps) {
  const strictTenantPgWrites = process.env.APP_STRICT_TENANT_PG_WRITES === 'true';
  const tenantPgFirstCapabilities = new Set([
    'toggleDirectChargeSupplierStatus',
    'rotateDirectChargeSupplierToken',
    'queueDirectChargeJobDispatch',
    'queueDirectChargeJobManualReview',
    'toggleSupplySourceSystemStatus',
    'rotateSupplySourceSystemToken',
    'toggleCardDeliveryItem',
    'toggleCardComboStatus',
    'toggleCardTemplateRandom',
    'restoreCardType',
    'importCardInventory',
    'toggleCardInventorySample',
    'queueCardFulfillment',
    'queueCardDeliveryJob',
    'queueCardOutboundResend',
    'runSupplySourceSync',
    'retrySupplySourceSyncRun',
    'dispatchSupplySourceOrder',
    'retrySupplySourceOrder',
    'markSupplySourceOrderManualReview',
  ]);

  const resolveTenantBusinessAdapter = (request: any) => {
    const tenant = request.currentTenant;
    if (!tenant || !databaseProvider?.isTenantBusinessPostgresEnabled()) {
      return null;
    }
    return databaseProvider.getTenantBusinessReadAdapter(tenant);
  };

  const mirrorShadowWrite = (request: any, operation: string, action: () => unknown) => {
    try {
      return action();
    } catch (error) {
      request.log.warn(
        { err: error, operation },
        'Tenant PostgreSQL fulfillment write completed but SQLite shadow mirror failed.',
      );
      return null;
    }
  };

  const callTenantBusinessWrite = async (
    request: any,
    capability: string,
    args: unknown[],
    fallback: () => unknown,
  ) => {
    if (!tenantPgFirstCapabilities.has(capability)) {
      return {
        payload: fallback(),
        tenantAdapter: null,
      };
    }

    const tenantAdapter = resolveTenantBusinessAdapter(request);
    if (!tenantAdapter || typeof tenantAdapter[capability] !== 'function') {
      app.log.warn(
        {
          event: 'tenant_business_write_adapter_capability_missing',
          capability,
          tenantId: request.currentTenant?.id ?? null,
          route: request.url,
        },
        'Tenant PostgreSQL write capability missing, falling back to SQLite shadow storage.',
      );
      return {
        payload: fallback(),
        tenantAdapter: null,
      };
    }

    try {
      return {
        payload: await tenantAdapter[capability](...args),
        tenantAdapter,
      };
    } catch (error) {
      app.log.warn(
        {
          event: 'tenant_business_write_adapter_failed',
          capability,
          tenantId: request.currentTenant?.id ?? null,
          route: request.url,
          error,
        },
        'Tenant PostgreSQL write failed, falling back to SQLite shadow storage.',
      );
      if (strictTenantPgWrites) {
        throw error;
      }
      return {
        payload: fallback(),
        tenantAdapter: null,
      };
    }
  };

  const mergeWorkerQueueShadowPayload = (payload: any, shadowPayload: any) => {
    if (!payload || !shadowPayload) {
      return payload ?? shadowPayload;
    }
    return {
      ...payload,
      accepted: shadowPayload.accepted ?? payload.accepted ?? false,
      queued: shadowPayload.queued ?? payload.queued ?? false,
      idempotent: shadowPayload.idempotent ?? payload.idempotent ?? false,
      queueTaskId: shadowPayload.queueTaskId ?? payload.queueTaskId ?? null,
    };
  };

  app.post('/api/workspaces/:featureKey/suppliers/:supplierId/toggle', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const params = z
      .object({
        featureKey: z.string().min(1),
        supplierId: z.coerce.number().int().positive(),
      })
      .parse(request.params);
    const { payload, tenantAdapter } = await callTenantBusinessWrite(
      request,
      'toggleDirectChargeSupplierStatus',
      [params.featureKey, params.supplierId],
      () => db.toggleDirectChargeSupplierStatus(params.featureKey, params.supplierId),
    );
    if (!payload) {
      return reply.code(404).send({ message: '供应商不存在' });
    }
    if (tenantAdapter) {
      mirrorShadowWrite(request, 'toggleDirectChargeSupplierStatus', () =>
        db.toggleDirectChargeSupplierStatus(params.featureKey, params.supplierId),
      );
    }
    return payload;
  });

  app.post('/api/workspaces/:featureKey/suppliers/:supplierId/token/rotate', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const params = z
      .object({
        featureKey: z.string().min(1),
        supplierId: z.coerce.number().int().positive(),
      })
      .parse(request.params);
    const { payload, tenantAdapter } = await callTenantBusinessWrite(
      request,
      'rotateDirectChargeSupplierToken',
      [params.featureKey, params.supplierId],
      () => db.rotateDirectChargeSupplierToken(params.featureKey, params.supplierId),
    );
    if (!payload) {
      return reply.code(404).send({ message: '供应商不存在' });
    }
    if (tenantAdapter) {
      mirrorShadowWrite(request, 'rotateDirectChargeSupplierToken', () =>
        db.rotateDirectChargeSupplierToken(params.featureKey, params.supplierId),
      );
    }
    return payload;
  });

  app.post('/api/workspaces/:featureKey/direct-charge-jobs/:jobId/dispatch', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const params = z
      .object({
        featureKey: z.string().min(1),
        jobId: z.coerce.number().int().positive(),
      })
      .parse(request.params);
    let payload;
    if (backgroundJobsMode === 'worker') {
      const tenantWrite = await callTenantBusinessWrite(
        request,
        'queueDirectChargeJobDispatch',
        [params.featureKey, params.jobId, 'dispatch'],
        () => db.queueDirectChargeJobDispatch(params.featureKey, params.jobId, 'dispatch'),
      );
      payload = tenantWrite.payload;
      if (tenantWrite.tenantAdapter) {
        const shadowPayload = mirrorShadowWrite(request, 'queueDirectChargeJobDispatch', () =>
          db.queueDirectChargeJobDispatch(params.featureKey, params.jobId, 'dispatch'),
        );
        payload = mergeWorkerQueueShadowPayload(payload, shadowPayload);
      }
    } else {
      payload = db.dispatchDirectChargeJob(params.featureKey, params.jobId);
    }
    if (!payload) {
      return reply.code(404).send({ message: '直充任务不存在' });
    }
    await publishFulfillmentQueueTask(payload);
    return payload;
  });

  app.post('/api/workspaces/:featureKey/direct-charge-jobs/:jobId/retry', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const params = z
      .object({
        featureKey: z.string().min(1),
        jobId: z.coerce.number().int().positive(),
      })
      .parse(request.params);
    let payload;
    if (backgroundJobsMode === 'worker') {
      const tenantWrite = await callTenantBusinessWrite(
        request,
        'queueDirectChargeJobDispatch',
        [params.featureKey, params.jobId, 'retry'],
        () => db.queueDirectChargeJobDispatch(params.featureKey, params.jobId, 'retry'),
      );
      payload = tenantWrite.payload;
      if (tenantWrite.tenantAdapter) {
        const shadowPayload = mirrorShadowWrite(request, 'queueDirectChargeJobDispatch', () =>
          db.queueDirectChargeJobDispatch(params.featureKey, params.jobId, 'retry'),
        );
        payload = mergeWorkerQueueShadowPayload(payload, shadowPayload);
      }
    } else {
      payload = db.retryDirectChargeJob(params.featureKey, params.jobId);
    }
    if (!payload) {
      return reply.code(404).send({ message: '直充任务不存在' });
    }
    await publishFulfillmentQueueTask(payload);
    return payload;
  });

  app.post('/api/workspaces/:featureKey/direct-charge-jobs/:jobId/manual-review', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const params = z
      .object({
        featureKey: z.string().min(1),
        jobId: z.coerce.number().int().positive(),
      })
      .parse(request.params);
    const body = directChargeManualReviewSchema.parse(request.body ?? {});
    let payload;
    if (backgroundJobsMode === 'worker') {
      const tenantWrite = await callTenantBusinessWrite(
        request,
        'queueDirectChargeJobManualReview',
        [params.featureKey, params.jobId, body.reason],
        () => db.queueDirectChargeJobManualReview(params.featureKey, params.jobId, body.reason),
      );
      payload = tenantWrite.payload;
      if (tenantWrite.tenantAdapter) {
        const shadowPayload = mirrorShadowWrite(request, 'queueDirectChargeJobManualReview', () =>
          db.queueDirectChargeJobManualReview(params.featureKey, params.jobId, body.reason),
        );
        payload = mergeWorkerQueueShadowPayload(payload, shadowPayload);
      }
    } else {
      payload = db.markDirectChargeJobManualReview(params.featureKey, params.jobId, body.reason);
    }
    if (!payload) {
      return reply.code(404).send({ message: '直充任务不存在或当前状态不可转人工' });
    }
    await publishFulfillmentQueueTask(payload);
    return payload;
  });

  app.post('/api/workspaces/:featureKey/source-systems/:systemId/toggle', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const params = z
      .object({
        featureKey: z.string().min(1),
        systemId: z.coerce.number().int().positive(),
      })
      .parse(request.params);
    const { payload, tenantAdapter } = await callTenantBusinessWrite(
      request,
      'toggleSupplySourceSystemStatus',
      [params.featureKey, params.systemId],
      () => db.toggleSupplySourceSystemStatus(params.featureKey, params.systemId),
    );
    if (!payload) {
      return reply.code(404).send({ message: '货源系统不存在。' });
    }
    if (tenantAdapter) {
      mirrorShadowWrite(request, 'toggleSupplySourceSystemStatus', () =>
        db.toggleSupplySourceSystemStatus(params.featureKey, params.systemId),
      );
    }
    return payload;
  });

  app.post('/api/workspaces/:featureKey/source-systems/:systemId/token/rotate', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const params = z
      .object({
        featureKey: z.string().min(1),
        systemId: z.coerce.number().int().positive(),
      })
      .parse(request.params);
    const { payload, tenantAdapter } = await callTenantBusinessWrite(
      request,
      'rotateSupplySourceSystemToken',
      [params.featureKey, params.systemId],
      () => db.rotateSupplySourceSystemToken(params.featureKey, params.systemId),
    );
    if (!payload) {
      return reply.code(404).send({ message: '货源系统不存在。' });
    }
    if (tenantAdapter) {
      mirrorShadowWrite(request, 'rotateSupplySourceSystemToken', () =>
        db.rotateSupplySourceSystemToken(params.featureKey, params.systemId),
      );
    }
    return payload;
  });

  app.post('/api/workspaces/:featureKey/source-systems/:systemId/sync', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const params = z
      .object({
        featureKey: z.string().min(1),
        systemId: z.coerce.number().int().positive(),
      })
      .parse(request.params);
    const body = supplySourceSyncSchema.parse(request.body ?? {});
    const { payload, tenantAdapter } = await callTenantBusinessWrite(
      request,
      'runSupplySourceSync',
      [params.featureKey, params.systemId, body.syncType],
      () => db.runSupplySourceSync(params.featureKey, params.systemId, body.syncType),
    );
    if (!payload) {
      return reply.code(404).send({ message: '货源系统不存在或当前不支持同步。' });
    }
    if (tenantAdapter) {
      mirrorShadowWrite(request, 'runSupplySourceSync', () =>
        db.runSupplySourceSync(params.featureKey, params.systemId, body.syncType),
      );
    }
    return payload;
  });

  app.post('/api/workspaces/:featureKey/source-sync-runs/:runId/retry', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const params = z
      .object({
        featureKey: z.string().min(1),
        runId: z.coerce.number().int().positive(),
      })
      .parse(request.params);
    const { payload, tenantAdapter } = await callTenantBusinessWrite(
      request,
      'retrySupplySourceSyncRun',
      [params.featureKey, params.runId],
      () => db.retrySupplySourceSyncRun(params.featureKey, params.runId),
    );
    if (!payload) {
      return reply.code(404).send({ message: '同步记录不存在或当前不支持重试。' });
    }
    if (tenantAdapter) {
      mirrorShadowWrite(request, 'retrySupplySourceSyncRun', () =>
        db.retrySupplySourceSyncRun(params.featureKey, params.runId),
      );
    }
    return payload;
  });

  app.post('/api/workspaces/:featureKey/source-orders/:sourceOrderId/dispatch', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const params = z
      .object({
        featureKey: z.string().min(1),
        sourceOrderId: z.coerce.number().int().positive(),
      })
      .parse(request.params);
    const { payload, tenantAdapter } = await callTenantBusinessWrite(
      request,
      'dispatchSupplySourceOrder',
      [params.featureKey, params.sourceOrderId],
      () => db.dispatchSupplySourceOrder(params.featureKey, params.sourceOrderId),
    );
    if (!payload) {
      return reply.code(404).send({ message: '货源订单不存在。' });
    }
    if (tenantAdapter) {
      mirrorShadowWrite(request, 'dispatchSupplySourceOrder', () =>
        db.dispatchSupplySourceOrder(params.featureKey, params.sourceOrderId),
      );
    }
    return payload;
  });

  app.post('/api/workspaces/:featureKey/source-orders/:sourceOrderId/retry', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const params = z
      .object({
        featureKey: z.string().min(1),
        sourceOrderId: z.coerce.number().int().positive(),
      })
      .parse(request.params);
    const { payload, tenantAdapter } = await callTenantBusinessWrite(
      request,
      'retrySupplySourceOrder',
      [params.featureKey, params.sourceOrderId],
      () => db.retrySupplySourceOrder(params.featureKey, params.sourceOrderId),
    );
    if (!payload) {
      return reply.code(404).send({ message: '货源订单不存在。' });
    }
    if (tenantAdapter) {
      mirrorShadowWrite(request, 'retrySupplySourceOrder', () =>
        db.retrySupplySourceOrder(params.featureKey, params.sourceOrderId),
      );
    }
    return payload;
  });

  app.post('/api/workspaces/:featureKey/source-orders/:sourceOrderId/manual-review', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const params = z
      .object({
        featureKey: z.string().min(1),
        sourceOrderId: z.coerce.number().int().positive(),
      })
      .parse(request.params);
    const body = supplySourceManualReviewSchema.parse(request.body ?? {});
    const { payload, tenantAdapter } = await callTenantBusinessWrite(
      request,
      'markSupplySourceOrderManualReview',
      [params.featureKey, params.sourceOrderId, body.reason],
      () => db.markSupplySourceOrderManualReview(params.featureKey, params.sourceOrderId, body.reason),
    );
    if (!payload) {
      return reply.code(404).send({ message: '货源订单不存在或当前状态不可转人工。' });
    }
    if (tenantAdapter) {
      mirrorShadowWrite(request, 'markSupplySourceOrderManualReview', () =>
        db.markSupplySourceOrderManualReview(params.featureKey, params.sourceOrderId, body.reason),
      );
    }
    return payload;
  });

  app.post('/api/workspaces/:featureKey/delivery-items/:deliveryId/toggle', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const params = z
      .object({
        featureKey: z.string().min(1),
        deliveryId: z.coerce.number().int().positive(),
      })
      .parse(request.params);
    const { payload, tenantAdapter } = await callTenantBusinessWrite(
      request,
      'toggleCardDeliveryItem',
      [params.featureKey, params.deliveryId],
      () => db.toggleCardDeliveryItem(params.featureKey, params.deliveryId),
    );
    if (!payload) {
      return reply.code(404).send({ message: '发货设置不存在' });
    }
    if (tenantAdapter) {
      mirrorShadowWrite(request, 'toggleCardDeliveryItem', () =>
        db.toggleCardDeliveryItem(params.featureKey, params.deliveryId),
      );
    }
    return payload;
  });

  app.post('/api/workspaces/:featureKey/combos/:comboId/toggle', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const params = z
      .object({
        featureKey: z.string().min(1),
        comboId: z.coerce.number().int().positive(),
      })
      .parse(request.params);
    const { payload, tenantAdapter } = await callTenantBusinessWrite(
      request,
      'toggleCardComboStatus',
      [params.featureKey, params.comboId],
      () => db.toggleCardComboStatus(params.featureKey, params.comboId),
    );
    if (!payload) {
      return reply.code(404).send({ message: '组合不存在' });
    }
    if (tenantAdapter) {
      mirrorShadowWrite(request, 'toggleCardComboStatus', () =>
        db.toggleCardComboStatus(params.featureKey, params.comboId),
      );
    }
    return payload;
  });

  app.post('/api/workspaces/:featureKey/templates/:templateId/random-toggle', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const params = z
      .object({
        featureKey: z.string().min(1),
        templateId: z.coerce.number().int().positive(),
      })
      .parse(request.params);
    const { payload, tenantAdapter } = await callTenantBusinessWrite(
      request,
      'toggleCardTemplateRandom',
      [params.featureKey, params.templateId],
      () => db.toggleCardTemplateRandom(params.featureKey, params.templateId),
    );
    if (!payload) {
      return reply.code(404).send({ message: '模板不存在' });
    }
    if (tenantAdapter) {
      mirrorShadowWrite(request, 'toggleCardTemplateRandom', () =>
        db.toggleCardTemplateRandom(params.featureKey, params.templateId),
      );
    }
    return payload;
  });

  app.post('/api/workspaces/:featureKey/card-types/:cardTypeId/restore', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const params = z
      .object({
        featureKey: z.string().min(1),
        cardTypeId: z.coerce.number().int().positive(),
      })
      .parse(request.params);
    const { payload, tenantAdapter } = await callTenantBusinessWrite(
      request,
      'restoreCardType',
      [params.featureKey, params.cardTypeId],
      () => db.restoreCardType(params.featureKey, params.cardTypeId),
    );
    if (!payload) {
      return reply.code(404).send({ message: '卡种不存在' });
    }
    if (tenantAdapter) {
      mirrorShadowWrite(request, 'restoreCardType', () =>
        db.restoreCardType(params.featureKey, params.cardTypeId),
      );
    }
    return payload;
  });

  app.post('/api/workspaces/:featureKey/card-types/:cardTypeId/import', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const params = z
      .object({
        featureKey: z.string().min(1),
        cardTypeId: z.coerce.number().int().positive(),
      })
      .parse(request.params);
    const body = cardImportSchema.parse(request.body ?? {});
    const { payload, tenantAdapter } = await callTenantBusinessWrite(
      request,
      'importCardInventory',
      [params.featureKey, params.cardTypeId, body.lines],
      () => db.importCardInventory(params.featureKey, params.cardTypeId, body.lines),
    );
    if (!payload) {
      return reply.code(404).send({ message: '卡种不存在或当前模块不支持导入' });
    }
    if (tenantAdapter) {
      mirrorShadowWrite(request, 'importCardInventory', () =>
        db.importCardInventory(params.featureKey, params.cardTypeId, body.lines),
      );
    }
    return payload;
  });

  app.post('/api/workspaces/:featureKey/card-types/:cardTypeId/inventory-sample/toggle', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const params = z
      .object({
        featureKey: z.string().min(1),
        cardTypeId: z.coerce.number().int().positive(),
      })
      .parse(request.params);
    const { payload, tenantAdapter } = await callTenantBusinessWrite(
      request,
      'toggleCardInventorySample',
      [params.featureKey, params.cardTypeId],
      () => db.toggleCardInventorySample(params.featureKey, params.cardTypeId),
    );
    if (!payload) {
      return reply.code(404).send({ message: '可切换的样卡不存在' });
    }
    if (tenantAdapter) {
      mirrorShadowWrite(request, 'toggleCardInventorySample', () =>
        db.toggleCardInventorySample(params.featureKey, params.cardTypeId),
      );
    }
    return payload;
  });

  app.post('/api/workspaces/:featureKey/orders/:orderId/fulfill', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const params = z
      .object({
        featureKey: z.string().min(1),
        orderId: z.coerce.number().int().positive(),
      })
      .parse(request.params);
    let payload;
    if (backgroundJobsMode === 'worker') {
      const tenantWrite = await callTenantBusinessWrite(
        request,
        'queueCardFulfillment',
        [params.featureKey, params.orderId],
        () => db.queueCardFulfillment(params.featureKey, params.orderId),
      );
      payload = tenantWrite.payload;
      if (tenantWrite.tenantAdapter) {
        const shadowPayload = mirrorShadowWrite(request, 'queueCardFulfillment', () =>
          db.queueCardFulfillment(params.featureKey, params.orderId),
        );
        payload = mergeWorkerQueueShadowPayload(payload, shadowPayload);
      }
    } else {
      payload = db.fulfillCardOrder(params.featureKey, params.orderId);
    }
    if (!payload) {
      return reply.code(404).send({ message: '订单不存在或未接入卡密发货' });
    }
    await publishFulfillmentQueueTask(payload);
    return payload;
  });

  app.post('/api/workspaces/:featureKey/jobs/:jobId/run', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const params = z
      .object({
        featureKey: z.string().min(1),
        jobId: z.coerce.number().int().positive(),
      })
      .parse(request.params);
    let payload;
    if (backgroundJobsMode === 'worker') {
      const tenantWrite = await callTenantBusinessWrite(
        request,
        'queueCardDeliveryJob',
        [params.featureKey, params.jobId],
        () => db.queueCardDeliveryJob(params.featureKey, params.jobId),
      );
      payload = tenantWrite.payload;
      if (tenantWrite.tenantAdapter) {
        const shadowPayload = mirrorShadowWrite(request, 'queueCardDeliveryJob', () =>
          db.queueCardDeliveryJob(params.featureKey, params.jobId),
        );
        payload = mergeWorkerQueueShadowPayload(payload, shadowPayload);
      }
    } else {
      payload = db.runCardDeliveryJob(params.featureKey, params.jobId);
    }
    if (!payload) {
      return reply.code(404).send({ message: '发货任务不存在' });
    }
    await publishFulfillmentQueueTask(payload);
    return payload;
  });

  app.post('/api/workspaces/:featureKey/outbound-records/:outboundRecordId/resend', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const params = z
      .object({
        featureKey: z.string().min(1),
        outboundRecordId: z.coerce.number().int().positive(),
      })
      .parse(request.params);
    let payload;
    if (backgroundJobsMode === 'worker') {
      const tenantWrite = await callTenantBusinessWrite(
        request,
        'queueCardOutboundResend',
        [params.featureKey, params.outboundRecordId],
        () => db.queueCardOutboundResend(params.featureKey, params.outboundRecordId),
      );
      payload = tenantWrite.payload;
      if (tenantWrite.tenantAdapter) {
        const shadowPayload = mirrorShadowWrite(request, 'queueCardOutboundResend', () =>
          db.queueCardOutboundResend(params.featureKey, params.outboundRecordId),
        );
        payload = mergeWorkerQueueShadowPayload(payload, shadowPayload);
      }
    } else {
      payload = db.resendCardOutbound(params.featureKey, params.outboundRecordId);
    }
    if (!payload) {
      return reply.code(404).send({ message: '出库记录不存在或当前状态不可补发' });
    }
    await publishFulfillmentQueueTask(payload);
    return payload;
  });

  app.post('/api/workspaces/:featureKey/outbound-records/:outboundRecordId/recycle', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const params = z
      .object({
        featureKey: z.string().min(1),
        outboundRecordId: z.coerce.number().int().positive(),
      })
      .parse(request.params);
    const body = cardRecycleSchema.parse(request.body ?? {});
    const payload = db.recycleCardOutbound(params.featureKey, params.outboundRecordId, body.action);
    if (!payload) {
      return reply.code(404).send({ message: '出库记录不存在或当前状态不可回收' });
    }
    return payload;
  });
}
