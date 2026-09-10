import { queryOptions, type QueryClient } from '@tanstack/react-query';
import type { StreamBaseResource } from '@clash-sentinel/shared';
import { api } from './api.js';

export const queryKeys = {
  health: ['health'] as const,
  monitoring: ['monitoring'] as const,
  status: ['status'] as const,
  sites: ['sites'] as const,
  candidates: ['candidates'] as const,
  events: ['events'] as const,
  settings: ['settings'] as const,
};

export const dashboardQueries = {
  health: queryOptions({ queryKey: queryKeys.health, queryFn: api.health }),
  monitoring: queryOptions({
    queryKey: queryKeys.monitoring,
    queryFn: api.monitoring,
  }),
  status: queryOptions({ queryKey: queryKeys.status, queryFn: api.status }),
  sites: queryOptions({ queryKey: queryKeys.sites, queryFn: api.sites }),
  candidates: queryOptions({
    queryKey: queryKeys.candidates,
    queryFn: api.candidates,
  }),
  events: queryOptions({ queryKey: queryKeys.events, queryFn: api.events }),
  settings: queryOptions({
    queryKey: queryKeys.settings,
    queryFn: api.settings,
  }),
};

export const streamQueryKeys: Record<StreamBaseResource, readonly string[]> = {
  monitoring: queryKeys.monitoring,
  status: queryKeys.status,
  sites: queryKeys.sites,
  candidates: queryKeys.candidates,
  events: queryKeys.events,
  settings: queryKeys.settings,
};

export const snapshotQueryKeys = Object.values(streamQueryKeys);
export const allDashboardQueryKeys = [queryKeys.health, ...snapshotQueryKeys];

/** 重新读取全部看板 GET 快照，不触发任何业务动作。 */
export async function refreshDashboard(client: QueryClient) {
  await Promise.all(
    allDashboardQueryKeys.map((queryKey) =>
      client.invalidateQueries({ queryKey, exact: true }),
    ),
  );
}
