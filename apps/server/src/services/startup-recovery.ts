import type { EventRepository } from '../storage/event-repository.js';
import type { TaskRepository } from '../storage/task-repository.js';
import type { AutoSwitchService } from './auto-switch/auto-switch-service.js';

/** 启动恢复需要的同步存储和自动切换安全策略。 */
export interface StartupRecoveryOptions {
  store: {
    transaction<T>(callback: () => T): T;
    tasks: Pick<
      TaskRepository,
      'listActiveTaskIds' | 'recoverInterruptedTasks'
    >;
    events: Pick<EventRepository, 'appendEvent'>;
  };
  autoSwitch: Pick<AutoSwitchService, 'handleInvalidContext'>;
}

/**
 * 原子恢复上次进程遗留的任务，并对中断的自动切换执行安全关闭。
 *
 * @returns 被标记为 interrupted 的任务数量。
 */
export function recoverRuntimeState({
  store,
  autoSwitch,
}: StartupRecoveryOptions): number {
  return store.transaction(() => {
    const interruptedAutoSwitch = store.tasks.listActiveTaskIds('auto_switch');
    const recoveredTasks = store.tasks.recoverInterruptedTasks();
    if (interruptedAutoSwitch.length === 0) return recoveredTasks;

    autoSwitch.handleInvalidContext();
    store.events.appendEvent({
      type: 'auto_switch_interrupted',
      severity: 'critical',
      retention: 'critical',
      summary: '自动切换被服务中断，已关闭自动切换',
      details: { taskIds: interruptedAutoSwitch },
    });
    return recoveredTasks;
  });
}
