import type {
  HealthSnapshot,
  StoredJsonObject,
  TaskRecoveryStatus,
} from '@clash-sentinel/shared';
import {
  LegacyAdapterError,
  type LegacyAdapter,
} from '../../legacy/adapter.js';
import type { SqliteStore } from '../../storage/store.js';
import type { TaskFailureResult } from './contracts.js';

/** apply/reset/rollback Handler 可以使用的最小配置操作集合。 */
export type ConfigurationOperations = Pick<
  LegacyAdapter,
  'getStatus' | 'applyIp' | 'resetLock' | 'rollback'
>;

/**
 * 将 Legacy 或未知异常转换成任务引擎可持久化的安全失败结果。
 *
 * @param error 领域执行抛出的原始异常。
 * @param critical 是否属于必须报告恢复状态的配置动作。
 * @param changedResources 失败前或恢复过程中已经变化的资源。
 * @returns 不泄露脚本输出的稳定错误和恢复结论。
 */
export function legacyFailure(
  error: unknown,
  critical: boolean,
  changedResources: TaskFailureResult['changedResources'] = [],
): TaskFailureResult {
  return {
    code: error instanceof LegacyAdapterError ? error.code : 'INTERNAL_ERROR',
    message:
      error instanceof LegacyAdapterError ? error.message : '后台任务执行失败',
    recoveryStatus: critical
      ? error instanceof LegacyAdapterError
        ? (error.recoveryStatus ?? 'unknown')
        : 'unknown'
      : null,
    changedResources,
  };
}

/**
 * 配置动作成功后重新读取订阅身份，并保守地将健康状态置为 unknown。
 *
 * @param store 保存最新健康快照的存储门面。
 * @param adapter 读取当前 Legacy 状态的能力。
 * @param clearCooldown 是否同时清除自动切换冷却截止时间。
 */
export async function refreshIdentity(
  store: SqliteStore,
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

/**
 * 从任务 JSON 输入中提取必填非空字符串。
 *
 * @param input 已持久化的任务输入。
 * @param key 要读取的字段名。
 * @returns 非空字符串值。
 * @throws 字段缺失、为空或类型错误时抛出安全校验异常。
 */
export function stringInput(input: StoredJsonObject | null, key: string) {
  const value = input?.[key];
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`任务输入缺少 ${key}`);
  return value;
}

/**
 * 提取配置动作异常携带的恢复状态。
 *
 * @param error Legacy 或未知异常。
 * @returns Legacy 明确状态，未知异常保守返回 unknown。
 */
export function recoveryStatus(error: unknown): TaskRecoveryStatus {
  return error instanceof LegacyAdapterError
    ? (error.recoveryStatus ?? 'unknown')
    : 'unknown';
}
