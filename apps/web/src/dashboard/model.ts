export type DashboardAction =
  'health-check' | 'diagnose' | 'apply' | 'reset' | 'rollback';

export type DashboardStreamState = 'connecting' | 'connected' | 'offline';

export interface Confirmation {
  action: Extract<DashboardAction, 'apply' | 'reset' | 'rollback'> | 'auto';
  ip?: string;
}
