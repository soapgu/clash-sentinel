import type { SqliteStore } from '../../../storage/store.js';
import { asStoredJson, type TaskHandler } from '../contracts.js';
import { legacyFailure } from '../legacy-task-failure.js';
import {
  refreshHealthSnapshotAfterConfiguration,
  type ConfigurationOperations,
} from './configuration-task-support.js';

/** 回滚最近一次受管配置，并在成功后刷新权威入口身份。 */
export class RollbackTaskHandler implements TaskHandler {
  /** 注册表使用的稳定任务类型。 */
  readonly type = 'rollback' as const;
  /** 默认任务审计摘要使用的动作名称。 */
  readonly auditName = '回滚配置';
  /** 回滚会修改配置，失败时必须给出恢复状态。 */
  readonly critical = true;

  /** @returns rollback 不接受业务参数，因此始终返回空输入。 */
  parseInput() {
    return {};
  }

  /**
   * @param store 健康快照存储。
   * @param adapter 回滚和状态读取能力。
   */
  constructor(
    private readonly store: SqliteStore,
    private readonly adapter: Pick<
      ConfigurationOperations,
      'rollback' | 'getStatus'
    >,
  ) {}

  /** @returns 回滚结果及 status/events 失效资源。 */
  async execute({ task, logger }: Parameters<TaskHandler['execute']>[0]) {
    const startedAt = Date.now();
    logger.info('task:service', 'rollback started', { taskId: task.id });
    try {
      const result = await this.adapter.rollback();
      await refreshHealthSnapshotAfterConfiguration(
        this.store,
        this.adapter,
        false,
      );
      logger.info('task:service', 'rollback succeeded', {
        taskId: task.id,
        durationMs: Date.now() - startedAt,
      });
      return {
        result: asStoredJson(result),
        changedResources: ['status', 'events'] as const,
      };
    } catch (error) {
      logger.error('task:service', 'rollback failed', {
        taskId: task.id,
        durationMs: Date.now() - startedAt,
        error,
      });
      throw error;
    }
  }

  /**
   * @param error Legacy 或未知回滚异常。
   * @returns 包含 Legacy 恢复结论的安全失败结果。
   */
  handleFailure({ error }: { error: unknown }) {
    return legacyFailure(error, true);
  }
}
