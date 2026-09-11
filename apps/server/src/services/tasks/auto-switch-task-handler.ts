import type { AutoSwitchService } from '../auto-switch-service.js';
import { TaskExecutionError, type TaskHandler } from './contracts.js';
import { legacyFailure } from './handler-helpers.js';

/** 从持久化上下文恢复并执行自动切换领域流程。 */
export class AutoSwitchTaskHandler implements TaskHandler {
  /** 注册表使用的内部任务类型。 */
  readonly type = 'auto_switch' as const;
  /** 默认任务审计摘要使用的动作名称。 */
  readonly auditName = '自动切换';
  /** 自动切换会修改配置，失败时必须给出恢复状态。 */
  readonly critical = true;

  /**
   * 验证自动任务包含可供服务恢复执行上下文的持久化输入。
   *
   * @param input 任务表中的自动切换上下文。
   * @returns 非空持久化输入。
   * @throws 输入为空时进入安全失败流程。
   */
  parseInput(input: Parameters<TaskHandler['parseInput']>[0]) {
    if (!input) throw new Error('自动切换任务缺少输入');
    return input;
  }

  /** @param service 自动切换的规划恢复、执行和失败保护能力。 */
  constructor(
    private readonly service: Pick<
      AutoSwitchService,
      'restorePlan' | 'execute' | 'handleFailure' | 'handleInvalidContext'
    >,
  ) {}

  /**
   * 复核持久化上下文、执行自动切换并生成定制审计信息。
   *
   * @param context 当前自动任务及已校验输入。
   * @returns 自动切换结果、资源变化和业务审计摘要。
   * @throws TaskExecutionError 领域失败已完成恢复处理时抛出安全结果。
   */
  async execute({
    task,
    input,
    logger,
  }: Parameters<TaskHandler['execute']>[0]) {
    const plan = this.service.restorePlan(input);
    try {
      const execution = await this.service.execute(plan);
      logger.info('health:scheduler', 'automatic handling completed', {
        taskId: task.id,
        trigger: plan.source,
        parentId: plan.parentId,
        succeeded: true,
      });
      return {
        result: execution.result,
        changedResources: execution.changedResources,
        audit: {
          summary: execution.eventSummary,
          details: execution.eventDetails,
        },
      };
    } catch (error) {
      const base = legacyFailure(error, true);
      const handling = this.service.handleFailure(
        plan,
        error,
        base.recoveryStatus,
      );
      throw new TaskExecutionError(
        {
          ...base,
          recoveryStatus: handling.recoveryStatus,
          changedResources: handling.changedResources,
        },
        { cause: error },
      );
    }
  }

  /**
   * 处理连执行计划都无法恢复的异常，并保守关闭自动切换。
   *
   * @returns recoveryStatus=unknown 且包含 settings 的安全失败结果。
   */
  handleFailure({
    error,
  }: Parameters<NonNullable<TaskHandler['handleFailure']>>[0]) {
    const handling = this.service.handleInvalidContext();
    return {
      ...legacyFailure(error, true),
      recoveryStatus: handling.recoveryStatus,
      changedResources: handling.changedResources,
    };
  }
}
