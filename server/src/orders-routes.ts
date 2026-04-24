// @ts-nocheck
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { routeAccessPolicy } from './access-control.js';
import type { ResolvedAppConfig } from './config.js';
import type { DatabaseProvider } from './database-provider.js';
import type { StatisticsDatabase } from './database.js';
import {
  afterSaleDisputeActionSchema,
  afterSaleNoteSchema,
  afterSaleRefundActionSchema,
  afterSaleResendActionSchema,
  baseFilterSchema,
  fulfillmentNoteSchema,
  fulfillmentReasonSchema,
  listQuerySchema,
} from './schemas.js';

interface OrdersRouteDeps {
  app: FastifyInstance;
  db: StatisticsDatabase;
  databaseProvider: DatabaseProvider;
  runtimeConfig: ResolvedAppConfig;
  authorizeRoles: (requiredRoles: string[], resourceKey: string, actionLabel: string) => unknown;
  ensurePrivilegedWriteAllowed: (
    request: FastifyRequest,
    reply: FastifyReply,
    currentUser: any,
    actionLabel: string,
  ) => boolean;
  resolveRequestIp: (request: FastifyRequest) => string;
  publishFulfillmentQueueTask: (payload: any) => Promise<void>;
}

const orderIdParamsSchema = z.object({ orderId: z.coerce.number().int().positive() });
const afterSaleCaseParamsSchema = z.object({ caseId: z.coerce.number().int().positive() });

export function registerOrdersRoutes({
  app,
  db,
  databaseProvider,
  runtimeConfig,
  authorizeRoles,
  ensurePrivilegedWriteAllowed,
  resolveRequestIp,
  publishFulfillmentQueueTask,
}: OrdersRouteDeps) {
  const resolveTenantBusinessRead = async (
    request: FastifyRequest,
    capability: string,
    args: unknown[],
    fallback: () => unknown,
  ) => {
    const tenant = request.currentTenant;
    if (!tenant || !databaseProvider.isTenantBusinessPostgresEnabled()) {
      return fallback();
    }

    const adapter = databaseProvider.getTenantBusinessReadAdapter(tenant);
    if (!adapter || typeof adapter[capability] !== 'function') {
      app.log.warn(
        {
          event: 'tenant_business_read_adapter_capability_missing',
          capability,
          tenantId: tenant.id,
          route: request.url,
        },
        'Tenant PostgreSQL read capability missing, falling back to SQLite shadow storage.',
      );
      return fallback();
    }

    return adapter[capability](...args);
  };

  app.get(
    '/api/orders/overview',
    { preHandler: [authorizeRoles(routeAccessPolicy.orders, 'orders', '查看订单概览')] },
    async (request) => {
      const query = baseFilterSchema.parse(request.query);
      return resolveTenantBusinessRead(request, 'getOrdersOverview', [query], () =>
        db.getOrdersOverview(query),
      );
    },
  );

  app.get(
    '/api/orders',
    { preHandler: [authorizeRoles(routeAccessPolicy.orders, 'orders', '查看订单列表')] },
    async (request) => {
      const query = listQuerySchema.parse(request.query);
      return resolveTenantBusinessRead(
        request,
        'getOrdersList',
        [query, { page: query.page, pageSize: query.pageSize }],
        () => db.getOrdersList(query, { page: query.page, pageSize: query.pageSize }),
      );
    },
  );

  app.get(
    '/api/orders/:orderId',
    { preHandler: [authorizeRoles(routeAccessPolicy.orders, 'orders', '查看订单详情')] },
    async (request, reply) => {
      const params = orderIdParamsSchema.parse(request.params);
      const payload = await resolveTenantBusinessRead(request, 'getOrderDetail', [params.orderId], () =>
        db.getOrderDetail(params.orderId),
      );
      if (!payload) {
        return reply.code(404).send({ message: '订单不存在' });
      }
      return payload;
    },
  );

  app.get(
    '/api/orders/workbench/fulfillment',
    { preHandler: [authorizeRoles(routeAccessPolicy.orders, 'orders', '查看履约工作')] },
    async (request) => {
      const query = baseFilterSchema.parse(request.query);
      return resolveTenantBusinessRead(request, 'getOrderFulfillmentWorkbench', [query], () =>
        db.getOrderFulfillmentWorkbench(query),
      );
    },
  );

  app.post(
    '/api/orders/:orderId/fulfillment/retry',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageFulfillment, 'orders', '重试履约任务')] },
    async (request, reply) => {
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '重试履约任务')) {
        return;
      }

      const params = orderIdParamsSchema.parse(request.params);
      const payload =
        runtimeConfig.backgroundJobsMode === 'worker'
          ? db.queueOrderFulfillmentRetry(params.orderId)
          : db.retryOrderFulfillment(params.orderId);
      if (!payload) {
        db.recordAuditLog({
          action: 'fulfillment_retried',
          targetType: 'order',
          targetId: String(params.orderId),
          detail: `${currentUser.displayName} 重试履约失败，订单不支持该动作。`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return reply.code(404).send({ message: '订单不存在或当前状态不可重试' });
      }

      db.recordAuditLog({
        action: 'fulfillment_retried',
        targetType: 'order',
        targetId: String(params.orderId),
        detail: `${currentUser.displayName} 重试了订单履约。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      await publishFulfillmentQueueTask(payload);
      return payload;
    },
  );

  app.post(
    '/api/orders/:orderId/fulfillment/resend',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageFulfillment, 'orders', '补发履约结果')] },
    async (request, reply) => {
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '补发履约结果')) {
        return;
      }

      const params = orderIdParamsSchema.parse(request.params);
      const payload =
        runtimeConfig.backgroundJobsMode === 'worker'
          ? db.queueOrderFulfillmentResend(params.orderId)
          : db.resendOrderFulfillment(params.orderId);
      if (!payload) {
        db.recordAuditLog({
          action: 'fulfillment_resent',
          targetType: 'order',
          targetId: String(params.orderId),
          detail: `${currentUser.displayName} 补发履约失败，订单不支持该动作。`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return reply.code(404).send({ message: '订单不存在或当前状态不可补发' });
      }

      db.recordAuditLog({
        action: 'fulfillment_resent',
        targetType: 'order',
        targetId: String(params.orderId),
        detail: `${currentUser.displayName} 执行了订单补发。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      await publishFulfillmentQueueTask(payload);
      return payload;
    },
  );

  app.post(
    '/api/orders/:orderId/fulfillment/terminate',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageFulfillment, 'orders', '终止履约')] },
    async (request, reply) => {
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '终止履约')) {
        return;
      }

      const params = orderIdParamsSchema.parse(request.params);
      const body = fulfillmentReasonSchema.parse(request.body ?? {});
      const payload = db.terminateOrderFulfillment(params.orderId, body.reason, currentUser.displayName);
      if (!payload) {
        db.recordAuditLog({
          action: 'fulfillment_terminated',
          targetType: 'order',
          targetId: String(params.orderId),
          detail: `${currentUser.displayName} 终止履约失败，订单不存在或已关闭。`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return reply.code(404).send({ message: '订单不存在或当前状态不可终止' });
      }

      db.recordAuditLog({
        action: 'fulfillment_terminated',
        targetType: 'order',
        targetId: String(params.orderId),
        detail: `${currentUser.displayName} 终止了订单履约，原因：${body.reason}。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/orders/:orderId/fulfillment/note',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageFulfillment, 'orders', '记录履约备注')] },
    async (request, reply) => {
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '记录履约备注')) {
        return;
      }

      const params = orderIdParamsSchema.parse(request.params);
      const body = fulfillmentNoteSchema.parse(request.body ?? {});
      const payload = db.noteOrderFulfillment(params.orderId, body.note, currentUser.displayName);
      if (!payload) {
        db.recordAuditLog({
          action: 'fulfillment_noted',
          targetType: 'order',
          targetId: String(params.orderId),
          detail: `${currentUser.displayName} 记录履约备注失败，订单不存在。`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return reply.code(404).send({ message: '订单不存在' });
      }

      db.recordAuditLog({
        action: 'fulfillment_noted',
        targetType: 'order',
        targetId: String(params.orderId),
        detail: `${currentUser.displayName} 更新了订单履约备注。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.get(
    '/api/after-sales/workbench',
    { preHandler: [authorizeRoles(routeAccessPolicy.afterSale, 'after-sale', '查看售后工作')] },
    async (request) => {
      const query = baseFilterSchema.parse(request.query);
      return resolveTenantBusinessRead(request, 'getAfterSaleWorkbench', [query], () =>
        db.getAfterSaleWorkbench(query),
      );
    },
  );

  app.get(
    '/api/after-sales',
    { preHandler: [authorizeRoles(routeAccessPolicy.afterSale, 'after-sale', '查看售后列表')] },
    async (request) => {
      const query = listQuerySchema.parse(request.query);
      return resolveTenantBusinessRead(request, 'getAfterSaleCases', [query, query], () =>
        db.getAfterSaleCases(query, query),
      );
    },
  );

  app.get(
    '/api/after-sales/:caseId',
    { preHandler: [authorizeRoles(routeAccessPolicy.afterSale, 'after-sale', '查看售后详情')] },
    async (request, reply) => {
      const params = afterSaleCaseParamsSchema.parse(request.params);
      const payload = await resolveTenantBusinessRead(request, 'getAfterSaleDetail', [params.caseId], () =>
        db.getAfterSaleDetail(params.caseId),
      );
      if (!payload) {
        return reply.code(404).send({ message: '售后单不存在' });
      }
      return payload;
    },
  );

  app.post(
    '/api/after-sales/:caseId/refund/review',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageAfterSale, 'after-sale', '处理退款售后')] },
    async (request, reply) => {
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '处理退款售后')) {
        return;
      }

      const params = afterSaleCaseParamsSchema.parse(request.params);
      const body = afterSaleRefundActionSchema.parse(request.body ?? {});
      const payload = db.reviewAfterSaleRefund(
        params.caseId,
        body.decision,
        body.approvedAmount,
        body.note,
        currentUser.displayName,
      );
      if (!payload) {
        db.recordAuditLog({
          action: 'after_sale_refund_reviewed',
          targetType: 'after_sale',
          targetId: String(params.caseId),
          detail: `${currentUser.displayName} 处理退款售后失败，售后单不存在或状态不允许当前动作。`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return reply.code(404).send({ message: '售后单不存在或当前状态不允许该动作' });
      }

      db.recordAuditLog({
        action: 'after_sale_refund_reviewed',
        targetType: 'after_sale',
        targetId: String(params.caseId),
        detail: `${currentUser.displayName} 执行退款售后动作：${body.decision}。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/after-sales/:caseId/resend/execute',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageAfterSale, 'after-sale', '处理补发售后')] },
    async (request, reply) => {
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '处理补发售后')) {
        return;
      }

      const params = afterSaleCaseParamsSchema.parse(request.params);
      const body = afterSaleResendActionSchema.parse(request.body ?? {});
      const payload = db.executeAfterSaleResend(params.caseId, body.decision, body.note, currentUser.displayName);
      if (!payload) {
        db.recordAuditLog({
          action: 'after_sale_resend_executed',
          targetType: 'after_sale',
          targetId: String(params.caseId),
          detail: `${currentUser.displayName} 处理补发售后失败，售后单不存在或状态不允许当前动作。`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return reply.code(404).send({ message: '售后单不存在或当前状态不允许该动作' });
      }

      db.recordAuditLog({
        action: 'after_sale_resend_executed',
        targetType: 'after_sale',
        targetId: String(params.caseId),
        detail: `${currentUser.displayName} 执行补发售后动作：${body.decision}。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/after-sales/:caseId/dispute/conclude',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageAfterSale, 'after-sale', '登记争议结论')] },
    async (request, reply) => {
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '登记争议结论')) {
        return;
      }

      const params = afterSaleCaseParamsSchema.parse(request.params);
      const body = afterSaleDisputeActionSchema.parse(request.body ?? {});
      const payload = db.concludeAfterSaleDispute(
        params.caseId,
        body.decision,
        body.note,
        body.compensationAmount,
        currentUser.displayName,
      );
      if (!payload) {
        db.recordAuditLog({
          action: 'after_sale_dispute_concluded',
          targetType: 'after_sale',
          targetId: String(params.caseId),
          detail: `${currentUser.displayName} 登记争议结论失败，售后单不存在或状态不允许当前动作。`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return reply.code(404).send({ message: '售后单不存在或当前状态不允许该动作' });
      }

      db.recordAuditLog({
        action: 'after_sale_dispute_concluded',
        targetType: 'after_sale',
        targetId: String(params.caseId),
        detail: `${currentUser.displayName} 登记争议结论：${body.decision}。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/after-sales/:caseId/note',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageAfterSale, 'after-sale', '记录售后备注')] },
    async (request, reply) => {
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '记录售后备注')) {
        return;
      }

      const params = afterSaleCaseParamsSchema.parse(request.params);
      const body = afterSaleNoteSchema.parse(request.body ?? {});
      const payload = db.noteAfterSaleCase(params.caseId, body.note, currentUser.displayName);
      if (!payload) {
        db.recordAuditLog({
          action: 'after_sale_noted',
          targetType: 'after_sale',
          targetId: String(params.caseId),
          detail: `${currentUser.displayName} 记录售后备注失败，售后单不存在。`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return reply.code(404).send({ message: '售后单不存在' });
      }

      db.recordAuditLog({
        action: 'after_sale_noted',
        targetType: 'after_sale',
        targetId: String(params.caseId),
        detail: `${currentUser.displayName} 已记录售后备注。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.get(
    '/api/orders/export',
    { preHandler: [authorizeRoles(routeAccessPolicy.exportOrders, 'orders', '导出订单报表')] },
    async (request, reply) => {
      const currentUser = request.currentUser;
      const query = listQuerySchema.parse(request.query);
      const csv = await resolveTenantBusinessRead(request, 'exportOrdersCsv', [query], () =>
        db.exportOrdersCsv(query),
      );
      db.recordAuditLog({
        action: 'orders_exported',
        targetType: 'orders',
        targetId: 'csv',
        detail: `${currentUser.displayName} 导出了订单报表 CSV。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', 'attachment; filename="orders-report.csv"');
      return `\uFEFF${csv}`;
    },
  );
}
