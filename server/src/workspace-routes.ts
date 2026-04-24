// @ts-nocheck
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { DatabaseProvider } from './database-provider.js';
import type { StatisticsDatabase } from './database.js';
import { baseFilterSchema, systemAlertStatusSchema, workspaceTaskStatusSchema } from './schemas.js';

interface WorkspaceRouteDeps {
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

export function registerWorkspaceRoutes({
  app,
  db,
  databaseProvider,
  authorizeWorkspace,
  ensurePrivilegedWriteAllowed,
  resolveRequestIp,
}: WorkspaceRouteDeps) {
  const isTenantPostgresWorkspaceFeature = (featureKey: string) =>
    !['system-accounts', 'open-logs', 'system-configs'].includes(featureKey);

  const resolveTenantBusinessAdapter = (request: FastifyRequest, featureKey?: string) => {
    const tenant = request.currentTenant;
    if (!tenant || !databaseProvider?.isTenantBusinessPostgresEnabled()) {
      return null;
    }
    if (featureKey && !isTenantPostgresWorkspaceFeature(featureKey)) {
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
        'Tenant PostgreSQL workspace write completed but SQLite shadow mirror failed.',
      );
      return null;
    }
  };

  const recordAuditLog = async (
    request: FastifyRequest,
    featureKey: string,
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
    const tenantAdapter = resolveTenantBusinessAdapter(request, featureKey);
    if (tenantAdapter) {
      await tenantAdapter.recordAuditLog(input);
      mirrorShadowWrite(request, `audit:${input.action}`, () => db.recordAuditLog(input));
      return;
    }
    db.recordAuditLog(input);
  };

  const getTenantWorkspaceDetail = async (
    request: FastifyRequest,
    featureKey: string,
    fallback: unknown,
  ) => {
    const tenantAdapter = resolveTenantBusinessAdapter(request, featureKey);
    if (!tenantAdapter) {
      return fallback;
    }

    if (
      featureKey === 'system-monitoring' &&
      typeof tenantAdapter.getSystemMonitoringDetail === 'function'
    ) {
      const payload = await tenantAdapter.getSystemMonitoringDetail(fallback);
      if (payload) {
        return payload;
      }
    }

    if (typeof tenantAdapter.getWorkspaceBusinessDetail === 'function') {
      const payload = await tenantAdapter.getWorkspaceBusinessDetail(featureKey, fallback);
      if (payload) {
        return payload;
      }
    }

    return fallback;
  };

  app.get('/api/workspaces/:featureKey', { preHandler: [authorizeWorkspace('view')] }, async (request, reply) => {
    const params = z.object({ featureKey: z.string().min(1) }).parse(request.params);
    const payload = db.getWorkspaceOverview(params.featureKey);
    if (!payload) {
      return reply.code(404).send({ message: 'Workspace feature not found.' });
    }
    const tenantAdapter = resolveTenantBusinessAdapter(request, params.featureKey);
    if (tenantAdapter) {
      return tenantAdapter.getWorkspaceOverview(params.featureKey, payload);
    }
    return payload;
  });

  app.get('/api/workspaces/:featureKey/detail', { preHandler: [authorizeWorkspace('view')] }, async (request, reply) => {
    const params = z.object({ featureKey: z.string().min(1) }).parse(request.params);
    const query = baseFilterSchema.parse(request.query);
    const payload = db.getWorkspaceBusinessDetail(params.featureKey, query);
    if (!payload) {
      return reply.code(404).send({ message: 'Workspace feature not found.' });
    }
    return getTenantWorkspaceDetail(request, params.featureKey, payload);
  });

  app.post('/api/workspaces/:featureKey/alerts/:alertId/status', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const currentUser = request.currentUser;
    if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, 'update system alert status')) {
      return;
    }
    const params = z
      .object({
        featureKey: z.string().min(1),
        alertId: z.coerce.number().int().positive(),
      })
      .parse(request.params);
    const body = systemAlertStatusSchema.parse(request.body ?? {});
    const tenantAdapter = resolveTenantBusinessAdapter(request, params.featureKey);
    const payload = tenantAdapter
      ? await tenantAdapter.updateSystemAlertStatus(params.featureKey, params.alertId, body.status)
      : db.updateSystemAlertStatus(params.featureKey, params.alertId, body.status);
    if (!payload) {
      return reply.code(404).send({ message: 'System alert not found.' });
    }
    if (tenantAdapter) {
      mirrorShadowWrite(request, 'updateSystemAlertStatus', () =>
        db.updateSystemAlertStatus(params.featureKey, params.alertId, body.status),
      );
    }
    await recordAuditLog(request, params.featureKey, {
      action: 'system_alert_updated',
      targetType: 'ops_alert',
      targetId: String(params.alertId),
      detail: `${currentUser.displayName} updated system alert ${params.alertId} to ${body.status}.`,
      result: 'success',
      operator: currentUser,
      ipAddress: resolveRequestIp(request),
    });
    return payload;
  });

  app.post('/api/workspaces/:featureKey/backups/run', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const currentUser = request.currentUser;
    if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, 'run database backup')) {
      return;
    }
    const params = z.object({ featureKey: z.string().min(1) }).parse(request.params);
    const tenantAdapter = resolveTenantBusinessAdapter(request, params.featureKey);
    const payload = tenantAdapter
      ? await tenantAdapter.runSystemBackup(params.featureKey, currentUser.displayName)
      : db.runSystemBackup(params.featureKey, currentUser.displayName);
    if (!payload) {
      return reply.code(404).send({ message: 'This workspace does not support database backup.' });
    }
    if (tenantAdapter && payload.runStatus === 'success') {
      mirrorShadowWrite(request, 'runSystemBackup', () =>
        db.runSystemBackup(params.featureKey, currentUser.displayName),
      );
    }
    if (payload.runStatus === 'failed') {
      return reply.code(500).send({ message: payload.detail });
    }
    await recordAuditLog(request, params.featureKey, {
      action: 'system_backup_run',
      targetType: 'ops_backup',
      targetId: payload.backupNo,
      detail: `${currentUser.displayName} ran backup ${payload.backupNo}.`,
      result: 'success',
      operator: currentUser,
      ipAddress: resolveRequestIp(request),
    });
    return payload;
  });

  app.post('/api/workspaces/:featureKey/log-archives/run', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const currentUser = request.currentUser;
    if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, 'run log archive')) {
      return;
    }
    const params = z.object({ featureKey: z.string().min(1) }).parse(request.params);
    const tenantAdapter = resolveTenantBusinessAdapter(request, params.featureKey);
    const payload = tenantAdapter
      ? await tenantAdapter.runSystemLogArchive(params.featureKey, currentUser.displayName)
      : db.runSystemLogArchive(params.featureKey, currentUser.displayName);
    if (!payload) {
      return reply.code(404).send({ message: 'This workspace does not support log archive.' });
    }
    if (tenantAdapter) {
      mirrorShadowWrite(request, 'runSystemLogArchive', () =>
        db.runSystemLogArchive(params.featureKey, currentUser.displayName),
      );
    }
    await recordAuditLog(request, params.featureKey, {
      action: 'system_log_archive_run',
      targetType: 'ops_archive',
      targetId: payload.archiveNo,
      detail: `${currentUser.displayName} created log archive ${payload.archiveNo}.`,
      result: 'success',
      operator: currentUser,
      ipAddress: resolveRequestIp(request),
    });
    return payload;
  });

  app.post('/api/workspaces/:featureKey/recovery-drills/run', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const currentUser = request.currentUser;
    if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, 'run recovery drill')) {
      return;
    }
    const params = z.object({ featureKey: z.string().min(1) }).parse(request.params);
    const tenantAdapter = resolveTenantBusinessAdapter(request, params.featureKey);
    const payload = tenantAdapter
      ? await tenantAdapter.runSystemRecoveryDrill(params.featureKey, currentUser.displayName)
      : db.runSystemRecoveryDrill(params.featureKey, currentUser.displayName);
    if (!payload) {
      return reply.code(404).send({ message: 'This workspace does not support recovery drill.' });
    }
    if (tenantAdapter && payload.status === 'success') {
      mirrorShadowWrite(request, 'runSystemRecoveryDrill', () =>
        db.runSystemRecoveryDrill(params.featureKey, currentUser.displayName),
      );
    }
    if (payload.status === 'failed') {
      return reply.code(500).send({ message: payload.detail });
    }
    await recordAuditLog(request, params.featureKey, {
      action: 'system_recovery_drill_run',
      targetType: 'ops_recovery',
      targetId: payload.drillNo,
      detail: `${currentUser.displayName} completed recovery drill ${payload.drillNo}.`,
      result: 'success',
      operator: currentUser,
      ipAddress: resolveRequestIp(request),
    });
    return payload;
  });

  app.post('/api/workspaces/:featureKey/actions/:actionId/run', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const currentUser = request.currentUser;
    const params = z
      .object({
        featureKey: z.string().min(1),
        actionId: z.coerce.number().int().positive(),
      })
      .parse(request.params);
    const tenantAdapter = resolveTenantBusinessAdapter(request, params.featureKey);
    const payload = tenantAdapter
      ? await tenantAdapter.runWorkspaceAction(params.featureKey, params.actionId)
      : db.runWorkspaceAction(params.featureKey, params.actionId);
    if (!payload) {
      return reply.code(404).send({ message: 'Workspace action not found.' });
    }
    if (tenantAdapter) {
      mirrorShadowWrite(request, 'runWorkspaceAction', () => db.runWorkspaceAction(params.featureKey, params.actionId));
    }
    await recordAuditLog(request, params.featureKey, {
      action: 'workspace_action_run',
      targetType: 'workspace_action',
      targetId: String(params.actionId),
      detail: `${currentUser?.displayName ?? 'Unknown user'} ran workspace action ${params.featureKey}:${params.actionId}.`,
      result: 'success',
      operator: currentUser,
      ipAddress: resolveRequestIp(request),
    });
    return payload;
  });

  app.post('/api/workspaces/:featureKey/rules/:ruleId/toggle', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const currentUser = request.currentUser;
    const params = z
      .object({
        featureKey: z.string().min(1),
        ruleId: z.coerce.number().int().positive(),
      })
      .parse(request.params);
    const tenantAdapter = resolveTenantBusinessAdapter(request, params.featureKey);
    const payload = tenantAdapter
      ? await tenantAdapter.toggleWorkspaceRule(params.featureKey, params.ruleId)
      : db.toggleWorkspaceRule(params.featureKey, params.ruleId);
    if (!payload) {
      return reply.code(404).send({ message: 'Workspace rule not found.' });
    }
    if (tenantAdapter) {
      mirrorShadowWrite(request, 'toggleWorkspaceRule', () => db.toggleWorkspaceRule(params.featureKey, params.ruleId));
    }
    await recordAuditLog(request, params.featureKey, {
      action: 'workspace_rule_toggled',
      targetType: 'workspace_rule',
      targetId: String(params.ruleId),
      detail: `${currentUser?.displayName ?? 'Unknown user'} toggled workspace rule ${params.featureKey}:${params.ruleId}.`,
      result: 'success',
      operator: currentUser,
      ipAddress: resolveRequestIp(request),
    });
    return payload;
  });

  app.post('/api/workspaces/:featureKey/tasks/:taskId/status', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const currentUser = request.currentUser;
    const params = z
      .object({
        featureKey: z.string().min(1),
        taskId: z.coerce.number().int().positive(),
      })
      .parse(request.params);
    const body = workspaceTaskStatusSchema.parse(request.body);
    const tenantAdapter = resolveTenantBusinessAdapter(request, params.featureKey);
    const payload = tenantAdapter
      ? await tenantAdapter.updateWorkspaceTaskStatus(params.featureKey, params.taskId, body.status)
      : db.updateWorkspaceTaskStatus(params.featureKey, params.taskId, body.status);
    if (!payload) {
      return reply.code(404).send({ message: 'Workspace task not found.' });
    }
    if (tenantAdapter) {
      mirrorShadowWrite(request, 'updateWorkspaceTaskStatus', () =>
        db.updateWorkspaceTaskStatus(params.featureKey, params.taskId, body.status),
      );
    }
    await recordAuditLog(request, params.featureKey, {
      action: 'workspace_task_status_updated',
      targetType: 'workspace_task',
      targetId: String(params.taskId),
      detail: `${currentUser?.displayName ?? 'Unknown user'} updated workspace task ${params.featureKey}:${params.taskId} to ${body.status}.`,
      result: 'success',
      operator: currentUser,
      ipAddress: resolveRequestIp(request),
    });
    return payload;
  });
}
