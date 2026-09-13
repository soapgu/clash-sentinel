import type { HealthSnapshot } from '@clash-sentinel/shared';
import type { LegacyAdapter } from '../../../legacy/adapter.js';
import type { HealthRepository } from '../../../storage/health-repository.js';

/** apply/reset/rollback Handler 可以使用的最小配置操作集合。 */
export type ConfigurationOperations = Pick<
  LegacyAdapter,
  'getStatus' | 'applyIp' | 'resetLock' | 'rollback'
>;

/** 配置动作成功后重新读取身份，并将旧健康结论保守地置为 unknown。 */
export async function refreshHealthSnapshotAfterConfiguration(
  store: Pick<HealthRepository, 'getHealthSnapshot' | 'upsertHealthSnapshot'>,
  adapter: Pick<LegacyAdapter, 'getStatus'>,
  clearCooldown: boolean,
) {
  const status = await adapter.getStatus();
  const previous = store.getHealthSnapshot();
  const snapshot: HealthSnapshot = {
    status: 'unknown',
    profile: status.profile,
    lock: status.lock,
    internetSuccess: null,
    internetTotal: null,
    consecutiveFailures: 0,
    recommendedIp: null,
    autoSwitchCooldownUntil: clearCooldown
      ? null
      : (previous?.autoSwitchCooldownUntil ?? null),
    updatedAt: new Date().toISOString(),
  };
  store.upsertHealthSnapshot(snapshot);
}
