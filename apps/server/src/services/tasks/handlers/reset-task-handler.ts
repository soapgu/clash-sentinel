import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../../composition/tokens.js';
import type { HealthRepository } from '../../../storage/health-repository.js';
import type { SettingsRepository } from '../../../storage/settings-repository.js';
import { asStoredJson, type TaskHandler } from '../contracts.js';
import { legacyFailure } from '../legacy-task-failure.js';
import {
  refreshHealthSnapshotAfterConfiguration,
  type ConfigurationOperations,
} from './configuration-task-support.js';

/** 解除入口锁定，并同步关闭与旧锁定绑定的自动切换设置。 */
@injectable()
export class ResetTaskHandler implements TaskHandler {
  /** 注册表使用的稳定任务类型。 */
  readonly type = 'reset' as const;
  /** 默认任务审计摘要使用的动作名称。 */
  readonly auditName = '解除入口锁定';
  /** 解除锁定会修改配置，失败时必须给出恢复状态。 */
  readonly critical = true;

  /** @returns reset 不接受业务参数，因此始终返回空输入。 */
  parseInput() {
    return {};
  }

  /**
   * @param health 快照存储。
   * @param settings 设置存储。
   * @param adapter 重置和状态读取能力。
   */
  constructor(
    @inject(TOKENS.healthRepository)
    private readonly health: Pick<
      HealthRepository,
      'getHealthSnapshot' | 'upsertHealthSnapshot'
    >,
    @inject(TOKENS.settingsRepository)
    private readonly settings: Pick<SettingsRepository, 'updateSettings'>,
    @inject(TOKENS.legacyAdapter)
    private readonly adapter: Pick<
      ConfigurationOperations,
      'resetLock' | 'getStatus'
    >,
  ) {}

  /**
   * 解除锁定、刷新身份并关闭自动切换。
   *
   * @returns 操作结果及 status/settings/events 失效资源。
   */
  async execute({ task, logger }: Parameters<TaskHandler['execute']>[0]) {
    const startedAt = Date.now();
    logger.info('task:service', 'reset started', { taskId: task.id });
    try {
      const result = await this.adapter.resetLock();
      await refreshHealthSnapshotAfterConfiguration(
        this.health,
        this.adapter,
        true,
      );
      this.settings.updateSettings({
        autoSwitchEnabled: false,
        autoSwitchProfileUid: null,
      });
      logger.info('settings:service', 'settings updated', {
        taskId: task.id,
        changedFields: ['autoSwitchEnabled', 'autoSwitchProfileUid'],
        reason: 'reset',
      });
      logger.info('task:service', 'reset succeeded', {
        taskId: task.id,
        durationMs: Date.now() - startedAt,
      });
      return {
        result: asStoredJson(result),
        changedResources: ['status', 'settings', 'events'] as const,
      };
    } catch (error) {
      logger.error('task:service', 'reset failed', {
        taskId: task.id,
        durationMs: Date.now() - startedAt,
        error,
      });
      throw error;
    }
  }

  /**
   * @param error Legacy 或未知重置异常。
   * @returns 包含 Legacy 恢复结论的安全失败结果。
   */
  handleFailure({ error }: { error: unknown }) {
    return legacyFailure(error, true);
  }
}
