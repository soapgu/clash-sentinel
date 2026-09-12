import type { StreamResource } from '@clash-sentinel/shared';
import type {
  HealthCheckChanges,
  HealthCheckService,
} from '../health/health-check.js';
import type { AutoSwitchPlanner } from '../auto-switch-service.js';
import { asStoredJson, type TaskHandler } from './contracts.js';

/** 创建手动健康检查任务 Handler 所需的领域端口。 */
export interface HealthCheckTaskHandlerOptions {
  /** 执行并持久化完整健康检测的编排器。 */
  healthCheck: Pick<HealthCheckService, 'run'>;
  /** 根据检测结果声明可选自动任务的领域规划器。 */
  autoSwitchPlanner: AutoSwitchPlanner;
}

/** 执行手动健康检查，并声明可能需要在同一租约中运行的自动任务。 */
export class HealthCheckTaskHandler implements TaskHandler {
  /** 注册表使用的稳定任务类型。 */
  readonly type = 'health_check' as const;
  /** 默认任务审计摘要使用的动作名称。 */
  readonly auditName = '健康检查';
  /** 健康检查本身不修改 Clash 配置。 */
  readonly critical = false;

  /** @returns 健康检查任务不接受业务参数，因此始终返回空输入。 */
  parseInput() {
    return {};
  }

  /**
   * @param options 健康检测编排器和自动切换规划器。
   */
  constructor(private readonly options: HealthCheckTaskHandlerOptions) {}

  /**
   * 执行手动检测并保持公开任务结果为扁平 HealthSnapshot。
   *
   * @param context 当前健康检查任务上下文。
   * @returns 健康快照、精确资源变化和可选自动切换后续任务。
   */
  async execute({ task }: Parameters<TaskHandler['execute']>[0]) {
    const source = task.persistence === 'transient' ? 'scheduled' : 'manual';
    const execution = await this.options.healthCheck.run(source, task.id);
    const followUp = this.options.autoSwitchPlanner.prepare(
      execution,
      source,
      task.id,
    );
    return {
      result: asStoredJson(execution.snapshot),
      changedResources: this.changedResources(
        execution.changes,
        task.persistence === 'persistent',
      ),
      followUps: followUp ? [followUp] : [],
    };
  }

  /**
   * 将健康服务的写入摘要转换为前端查询资源。
   *
   * @param changes 健康检查实际成功写入的资源摘要。
   * @returns 去重前的 SSE 资源列表；审计事件保证包含 events。
   */
  private changedResources(
    changes: HealthCheckChanges,
    taskAuditAppended: boolean,
  ): StreamResource[] {
    const resources: StreamResource[] = [];
    if (changes.statusUpdated) resources.push('status');
    if (changes.sitesUpdated) resources.push('sites');
    if (changes.candidatesUpdated) resources.push('candidates');
    if (changes.eventAppended) resources.push('events');
    if (changes.settingsUpdated) resources.push('settings');
    // 持久化健康任务会由 TaskEngine 追加审计事件。
    if (taskAuditAppended && !resources.includes('events'))
      resources.push('events');
    return resources;
  }
}
