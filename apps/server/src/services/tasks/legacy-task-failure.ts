import { LegacyAdapterError } from '../../legacy/adapter.js';
import type { TaskFailureResult } from './contracts.js';

/** 将 Legacy 或未知异常转换成任务引擎可持久化的安全失败结果。 */
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
