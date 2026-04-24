// @ts-nocheck
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { DatabaseProvider } from './database-provider.js';
import type { StatisticsDatabase } from './database.js';
import {
  fundReconciliationStatusSchema,
  workspaceWithdrawalCreateSchema,
  workspaceWithdrawalStatusSchema,
} from './schemas.js';

interface WorkspaceFundRouteDeps {
  app: FastifyInstance;
  db: StatisticsDatabase;
  databaseProvider?: DatabaseProvider;
  authorizeWorkspace: (mode: 'view' | 'manage') => unknown;
  ensurePrivilegedWriteAllowed: (
    request: FastifyRequest,
    reply: FastifyReply,
    currentUser: any,
    actionLabel: string,
  ) => boolean;
  resolveRequestIp: (request: FastifyRequest) => string;
}

export function registerWorkspaceFundRoutes({
  app,
  db,
  databaseProvider,
  authorizeWorkspace,
  ensurePrivilegedWriteAllowed,
  resolveRequestIp,
}: WorkspaceFundRouteDeps) {
  const resolveTenantBusinessAdapter = (request: FastifyRequest) => {
    const tenant = request.currentTenant;
    if (!tenant || !databaseProvider?.isTenantBusinessPostgresEnabled()) {
      return null;
    }
    return databaseProvider.getTenantBusinessReadAdapter(tenant);
  };

  const mirrorShadowWrite = (request: FastifyRequest, operation: string, action: () => unknown) => {
    try {
      return action();
    } catch (error) {
      request.log.warn(
        { err: error, operation },
        'Tenant PostgreSQL fund write completed but SQLite shadow mirror failed.',
      );
      return null;
    }
  };

  const recordAuditLog = async (
    request: FastifyRequest,
    input: {
      action: string;
      targetType: string;
      targetId?: string | null;
      detail: string;
      result: 'success' | 'failure' | 'blocked';
      operator?: Pick<any, 'id' | 'username' | 'displayName'> | null;
      ipAddress?: string | null;
    },
  ) => {
    const tenantAdapter = resolveTenantBusinessAdapter(request);
    if (tenantAdapter) {
      await tenantAdapter.recordAuditLog(input);
      mirrorShadowWrite(request, `audit:${input.action}`, () => db.recordAuditLog(input));
      return;
    }
    db.recordAuditLog(input);
  };

  app.post(
    '/api/workspaces/:featureKey/withdrawals',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, 'create withdrawal')) {
        return;
      }

      const params = z.object({ featureKey: z.string().min(1) }).parse(request.params);
      const body = workspaceWithdrawalCreateSchema.parse(request.body);
      const tenantAdapter = resolveTenantBusinessAdapter(request);
      const payload = tenantAdapter
        ? await tenantAdapter.createFundWithdrawal({
            featureKey: params.featureKey,
            amount: body.amount,
            storeId: body.storeId,
            method: body.method,
            receivingAccount: body.receivingAccount,
          })
        : db.createFundWithdrawal({
            featureKey: params.featureKey,
            amount: body.amount,
            storeId: body.storeId,
            method: body.method,
            receivingAccount: body.receivingAccount,
          });
      if (!payload) {
        return reply
          .code(400)
          .send({ message: 'Unable to create withdrawal request. Check balance and amount.' });
      }

      if (tenantAdapter) {
        mirrorShadowWrite(request, 'createFundWithdrawal', () =>
          db.createFundWithdrawal({
            featureKey: params.featureKey,
            amount: body.amount,
            storeId: body.storeId,
            method: body.method,
            receivingAccount: body.receivingAccount,
          }),
        );
      }

      await recordAuditLog(request, {
        action: 'withdrawal_created',
        targetType: 'withdrawal',
        targetId: params.featureKey,
        detail: `${currentUser.displayName} created withdrawal request for ${body.amount}.`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/withdrawals/:withdrawalId/status',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, 'review withdrawal')) {
        return;
      }

      const params = z
        .object({
          featureKey: z.string().min(1),
          withdrawalId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const body = workspaceWithdrawalStatusSchema.parse(request.body);
      const tenantAdapter = resolveTenantBusinessAdapter(request);
      const payload = tenantAdapter
        ? await tenantAdapter.updateFundWithdrawalStatus(
            params.featureKey,
            params.withdrawalId,
            body.status,
          )
        : db.updateFundWithdrawalStatus(params.featureKey, params.withdrawalId, body.status);
      if (!payload) {
        await recordAuditLog(request, {
          action: 'withdrawal_reviewed',
          targetType: 'withdrawal',
          targetId: String(params.withdrawalId),
          detail: `${currentUser.displayName} failed to review withdrawal ${params.withdrawalId}.`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return reply.code(404).send({ message: 'Withdrawal not found.' });
      }

      if (tenantAdapter) {
        mirrorShadowWrite(request, 'updateFundWithdrawalStatus', () =>
          db.updateFundWithdrawalStatus(params.featureKey, params.withdrawalId, body.status),
        );
      }

      await recordAuditLog(request, {
        action: 'withdrawal_reviewed',
        targetType: 'withdrawal',
        targetId: String(params.withdrawalId),
        detail: `${currentUser.displayName} updated withdrawal ${params.withdrawalId} to ${body.status}.`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/reconciliations/:reconciliationId/status',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, 'update reconciliation status')) {
        return;
      }

      const params = z
        .object({
          featureKey: z.string().min(1),
          reconciliationId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const body = fundReconciliationStatusSchema.parse(request.body);
      const tenantAdapter = resolveTenantBusinessAdapter(request);
      const payload = tenantAdapter
        ? await tenantAdapter.updateFundReconciliationStatus(
            params.featureKey,
            params.reconciliationId,
            body.status,
            body.note,
          )
        : db.updateFundReconciliationStatus(
            params.featureKey,
            params.reconciliationId,
            body.status,
            body.note,
          );
      if (!payload) {
        return reply.code(404).send({ message: 'Reconciliation not found.' });
      }

      if (tenantAdapter) {
        mirrorShadowWrite(request, 'updateFundReconciliationStatus', () =>
          db.updateFundReconciliationStatus(
            params.featureKey,
            params.reconciliationId,
            body.status,
            body.note,
          ),
        );
      }

      await recordAuditLog(request, {
        action: 'reconciliation_updated',
        targetType: 'reconciliation',
        targetId: String(params.reconciliationId),
        detail: `${currentUser.displayName} updated reconciliation ${params.reconciliationId} to ${body.status}.`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );
}
