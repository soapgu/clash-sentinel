import type { SqliteStore } from '../../../storage/store.js';
import { asStoredJson, type TaskHandler } from '../contracts.js';
import { legacyFailure } from '../legacy-task-failure.js';
import {
  refreshHealthSnapshotAfterConfiguration,
  type ConfigurationOperations,
} from './configuration-task-support.js';

/** 执行候选 IP 应用，并在成功后刷新权威入口身份快照。 */
export class ApplyTaskHandler implements TaskHandler {
  /** 注册表使用的稳定任务类型。 */
  readonly type = 'apply' as const;
  /** 默认任务审计摘要使用的动作名称。 */
  readonly auditName = '应用候选 IP';
  /** 应用会修改配置，失败时必须给出恢复状态。 */
  readonly critical = true;

  /**
   * 校验应用任务必须包含非空目标 IP。
   *
   * @param input 数据库中保存的任务输入。
   * @returns 仅包含已校验 IP 的任务输入。
   * @throws 缺少目标 IP 时拒绝执行。
   */
  parseInput(input: Parameters<TaskHandler['parseInput']>[0]) {
    const ip = input?.ip;
    if (typeof ip !== 'string' || ip.length === 0)
      throw new Error('任务输入缺少 ip');
    return { ip };
  }

  /**
   * @param store 健康快照存储。
   * @param adapter 应用配置及读取状态的 Legacy 能力。
   */
  constructor(
    private readonly store: SqliteStore,
    private readonly adapter: Pick<
      ConfigurationOperations,
      'applyIp' | 'getStatus'
    >,
  ) {}

  /**
   * 应用目标 IP、刷新身份并返回精确资源变化。
   *
   * @param context 当前任务、已校验输入和统一日志器。
   * @returns 可持久化操作结果及 status/events 失效资源。
   */
  async execute({
    task,
    input,
    logger,
  }: Parameters<TaskHandler['execute']>[0]) {
    const ip = input.ip as string;
    const startedAt = Date.now();
    logger.info('task:service', 'apply started', {
      taskId: task.id,
      targetIp: ip,
    });
    try {
      const result = await this.adapter.applyIp(ip);
      await refreshHealthSnapshotAfterConfiguration(
        this.store,
        this.adapter,
        false,
      );
      logger.info('task:service', 'apply succeeded', {
        taskId: task.id,
        durationMs: Date.now() - startedAt,
      });
      return {
        result: asStoredJson(result),
        changedResources: ['status', 'events'] as const,
      };
    } catch (error) {
      logger.error('task:service', 'apply failed', {
        taskId: task.id,
        durationMs: Date.now() - startedAt,
        error,
      });
      throw error;
    }
  }

  /**
   * 将应用阶段异常转换成包含恢复状态的安全结果。
   *
   * @param error Legacy 或未知执行异常。
   * @returns TaskEngine 可直接持久化的失败结果。
   */
  handleFailure({ error }: { error: unknown }) {
    return legacyFailure(error, true);
  }
}
