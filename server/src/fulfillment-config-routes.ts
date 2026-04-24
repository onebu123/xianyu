// @ts-nocheck
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { routeAccessPolicy } from './access-control.js';
import type { StatisticsDatabase } from './database.js';

interface FulfillmentConfigRouteDeps {
  app: FastifyInstance;
  db: StatisticsDatabase;
  authorizeRoles: (requiredRoles: string[], resourceKey: string, actionLabel: string) => unknown;
  ensurePrivilegedWriteAllowed: (
    request: FastifyRequest,
    reply: FastifyReply,
    currentUser: any,
    actionLabel: string,
  ) => boolean;
  resolveRequestIp: (request: FastifyRequest) => string;
}

const productFulfillmentRuleParamsSchema = z.object({
  productId: z.coerce.number().int().positive(),
});

const productFulfillmentRuleSchema = z
  .object({
    fulfillmentType: z.enum(['standard', 'direct_charge', 'source_system']),
    supplierId: z.string().trim().min(1).nullable().optional(),
    externalSku: z.string().trim().min(1).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.fulfillmentType !== 'standard' && !value.supplierId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '请选择供应通道',
        path: ['supplierId'],
      });
    }
    if (value.fulfillmentType === 'source_system' && !value.externalSku) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '请输入外部 SKU',
        path: ['externalSku'],
      });
    }
  });

const cardUploadSchema = z.object({
  typeId: z.number().int().positive(),
  cards: z.array(
    z.object({
      no: z.string(),
      secret: z.string(),
    }),
  ),
});

export function registerFulfillmentConfigRoutes({
  app,
  db,
  authorizeRoles,
  ensurePrivilegedWriteAllowed,
  resolveRequestIp,
}: FulfillmentConfigRouteDeps) {
  app.get(
    '/api/fulfillment/adapters',
    { preHandler: [authorizeRoles(routeAccessPolicy.products, 'products', '查看发货适配器配置')] },
    async () => {
      return {
        directChargeAdapters: [{ key: 'sim-topup', label: '标准模拟直充供应商' }],
        sourceSystemAdapters: [{ key: 'sim-own-supply', label: '标准模拟自有货源系统' }],
      };
    },
  );

  app.get(
    '/api/products/:productId/fulfillment-rule',
    { preHandler: [authorizeRoles(routeAccessPolicy.products, 'products', '查看发货规则')] },
    async (request) => {
      const params = productFulfillmentRuleParamsSchema.parse(request.params);
      return db.getProductFulfillmentRule(params.productId);
    },
  );

  app.post(
    '/api/products/:productId/fulfillment-rule',
    { preHandler: [authorizeRoles(routeAccessPolicy.products, 'products', '配置商品发货规则')] },
    async (request, reply) => {
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '配置商品发货规则')) {
        return;
      }

      const params = productFulfillmentRuleParamsSchema.parse(request.params);
      const body = productFulfillmentRuleSchema.parse(request.body);
      db.upsertProductFulfillmentRule(params.productId, {
        fulfillmentType: body.fulfillmentType,
        supplierId: body.fulfillmentType === 'standard' ? null : body.supplierId ?? null,
        externalSku: body.fulfillmentType === 'source_system' ? body.externalSku ?? null : null,
      });
      db.recordAuditLog({
        action: 'product_fulfillment_rule_updated',
        targetType: 'product',
        targetId: String(params.productId),
        detail: `${currentUser.displayName} 为商品 ${params.productId} 修改发货规则为：${body.fulfillmentType}。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return { success: true };
    },
  );

  app.get(
    '/api/cards/inventory',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageFulfillment, 'manageFulfillment', '查看卡密库存')] },
    async () => {
      const sqlite = db.db;
      const rows = sqlite
        .prepare(`
          SELECT p.id as productId, p.name as productName, p.category,
                 c.id as typeId, c.card_type_name as typeName,
                 c.status as typeStatus,
                 (SELECT COUNT(*) FROM card_inventory_items WHERE card_type_id = c.id AND item_status='unused') as unusedCount,
                 (SELECT COUNT(*) FROM card_inventory_items WHERE card_type_id = c.id AND item_status='used') as usedCount
          FROM card_types c
          LEFT JOIN card_delivery_items cdi ON cdi.card_type_id = c.id
          LEFT JOIN products p ON cdi.product_id = p.id
          ORDER BY unusedCount ASC
        `)
        .all();
      return { list: rows };
    },
  );

  app.post(
    '/api/cards/upload',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageFulfillment, 'manageFulfillment', '导入卡密')] },
    async (request, reply) => {
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '导入卡密')) {
        return;
      }

      const body = cardUploadSchema.parse(request.body);
      const sqlite = db.db;
      sqlite.transaction(() => {
        const batchStmt = sqlite.prepare(
          `INSERT INTO card_batches (card_type_id, import_batch_no, imported_count, imported_by_user_id, status, created_at) VALUES (?, ?, ?, ?, ?, datetime('now', 'localtime'))`,
        );
        const batchInfo = batchStmt.run(body.typeId, `BATCH-${Date.now()}`, body.cards.length, currentUser.id, 'success');
        const insertStmt = sqlite.prepare(
          `INSERT INTO card_inventory_items (card_type_id, batch_id, card_no, card_secret, card_masked, item_status) VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const card of body.cards) {
          const masked = card.secret.length > 4 ? `***${card.secret.slice(-4)}` : '***';
          insertStmt.run(body.typeId, batchInfo.lastInsertRowid, card.no, card.secret, masked, 'unused');
        }
      })();

      db.recordAuditLog({
        action: 'card_inventory_imported',
        targetType: 'card',
        targetId: String(body.typeId),
        detail: `导入了 ${body.cards.length} 张卡密。 `,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return { success: true, count: body.cards.length };
    },
  );
}
