import type { StreamResource } from '@clash-sentinel/shared';
import type {
  HealthCheckChanges,
  HealthCheckExecution,
  HealthCheckService,
} from '../health/health-check.js';
import {
  asStoredJson,
  type TaskHandler,
  type TaskSubmission,
} from './contracts.js';

/** 根据刚完成的健康检查决定是否声明一个自动切换任务。 */
export type AutoSwitchPlanner = (
  health: HealthCheckExecution,
  source: 'manual' | 'scheduled',
  parentId: string,
) => TaskSubmission | null;

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
   * @param healthCheck 手动和定时检测共用的健康编排器。
   * @param planAutoSwitch 只生成声明式后续任务的自动切换规划器。
   */
  constructor(
    private readonly healthCheck: Pick<HealthCheckService, 'run'>,
    private readonly planAutoSwitch: AutoSwitchPlanner,
  ) {}

  /**
   * 执行手动检测并保持公开任务结果为扁平 HealthSnapshot。
   *
   * @param context 当前健康检查任务上下文。
   * @returns 健康快照、精确资源变化和可选自动切换后续任务。
   */
  async execute({ task }: Parameters<TaskHandler['execute']>[0]) {
    const execution = await this.healthCheck.run('manual', task.id);
    const followUp = this.planAutoSwitch(execution, 'manual', task.id);
    return {
      result: asStoredJson(execution.snapshot),
      changedResources: this.changedResources(execution.changes),
      followUps: followUp ? [followUp] : [],
    };
  }

  /**
   * 将健康服务的写入摘要转换为前端查询资源。
   *
   * @param changes 健康检查实际成功写入的资源摘要。
   * @returns 去重前的 SSE 资源列表；审计事件保证包含 events。
   */
  private changedResources(changes: HealthCheckChanges): StreamResource[] {
    const resources: StreamResource[] = [];
    if (changes.statusUpdated) resources.push('status');
    if (changes.sitesUpdated) resources.push('sites');
    if (changes.candidatesUpdated) resources.push('candidates');
    if (changes.eventAppended) resources.push('events');
    if (changes.settingsUpdated) resources.push('settings');
    // 健康任务本身会追加审计事件。
    if (!resources.includes('events')) resources.push('events');
    return resources;
  }
}
