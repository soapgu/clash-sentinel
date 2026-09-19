import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { dashboardQueries, refreshDashboard } from '../../queries.js';
import { errorSummary } from '../formatters.js';
import { directTargets } from '../site-meta.js';

export function useDashboardData() {
  const client = useQueryClient();
  const health = useQuery(dashboardQueries.health);
  const monitoring = useQuery(dashboardQueries.monitoring);
  const status = useQuery(dashboardQueries.status);
  const sites = useQuery(dashboardQueries.sites);
  const candidates = useQuery(dashboardQueries.candidates);
  const events = useQuery(dashboardQueries.events);
  const settings = useQuery(dashboardQueries.settings);
  const [now, setNow] = useState(Date.now());
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const results = [
    health,
    monitoring,
    status,
    sites,
    candidates,
    events,
    settings,
  ];
  const fetching = results.some((query) => query.isFetching);
  const initialLoading = results.some((query) => query.isPending);
  const errors = results.map((query) => query.error);
  const hasError = errors.some(Boolean);

  useEffect(() => {
    if (!fetching && !hasError) setLastSyncedAt(Date.now());
  }, [fetching, hasError]);

  const siteMap = sites.data?.data.sites;
  const directReachable = directTargets.filter(
    (target) => siteMap?.[target]?.reachable,
  ).length;
  const refresh = useCallback(async () => {
    setNow(Date.now());
    await refreshDashboard(client);
  }, [client]);

  return {
    health: health.data?.data,
    monitoring: monitoring.data?.data.monitoring,
    snapshot: status.data?.data.snapshot,
    siteMap,
    diagnosis: candidates.data?.data.diagnosis,
    events: events.data?.data.items,
    settings: settings.data?.data.settings,
    activeTaskId: monitoring.data?.data.monitoring.activeTaskId,
    now,
    lastSyncedAt,
    fetching,
    initialLoading,
    offline: health.isError,
    partialError: hasError ? errorSummary(errors) : null,
    directReachable,
    refresh,
  };
}
