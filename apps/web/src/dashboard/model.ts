export type DashboardAction =
  'health-check' | 'diagnose' | 'apply' | 'reset' | 'rollback';

export type DashboardStreamState = 'connecting' | 'connected' | 'offline';

export type Confirmation =
  { action: 'apply'; ip?: string } | { action: 'reset' | 'rollback' | 'auto' };
