import { AsyncLocalStorage } from 'node:async_hooks';

import type { PlatformUserRecord, TenantMembershipRecord, TenantRecord } from './types.js';
import type { StatisticsDatabase } from './database.js';

export interface RequestRuntimeContext {
  scope: 'private' | 'platform' | 'tenant' | null;
  businessDb: StatisticsDatabase;
  tenant: TenantRecord | null;
  platformUser: PlatformUserRecord | null;
  membership: TenantMembershipRecord | null;
}

const requestContextStorage = new AsyncLocalStorage<RequestRuntimeContext>();

export function runWithRequestContext<T>(
  context: RequestRuntimeContext,
  callback: () => T,
) {
  return requestContextStorage.run(context, callback);
}

export function getRequestContext() {
  return requestContextStorage.getStore() ?? null;
}
