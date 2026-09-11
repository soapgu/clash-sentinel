import type { LegacyAdapter } from '../../legacy/adapter.js';
import type { SqliteStore } from '../../storage/store.js';
import type { AutoSwitchService } from '../auto-switch-service.js';
import type { HealthCheckService } from '../health/health-check.js';
import { ApplyTaskHandler } from './apply-task-handler.js';
import { AutoSwitchTaskHandler } from './auto-switch-task-handler.js';
import type { TaskHandlerRegistry } from './contracts.js';
import { DiagnoseTaskHandler } from './diagnose-task-handler.js';
import {
  HealthCheckTaskHandler,
  type AutoSwitchPlanner,
} from './health-check-task-handler.js';
import { ResetTaskHandler } from './reset-task-handler.js';
import { RollbackTaskHandler } from './rollback-task-handler.js';

/** 六个任务 Handler 装配时共用的最小 Legacy 能力集合。 */
export type LegacyOperations = Pick<
  LegacyAdapter,
  | 'getStatus'
  | 'readLatestDiagnosis'
  | 'diagnose'
  | 'healthCheck'
  | 'applyIp'
  | 'resetLock'
  | 'rollback'
>;

/** 创建完整 Handler 注册表需要的领域服务依赖。 */
export interface TaskHandlerDependencies {
  /** Handler 读写任务业务快照和设置的 SQLite 门面。 */
  store: SqliteStore;
  /** 诊断及配置动作使用的受限 Legacy 能力。 */
  adapter: Pick<
    LegacyAdapter,
    'diagnose' | 'applyIp' | 'resetLock' | 'rollback' | 'getStatus'
  >;
  /** 手动健康任务调用的完整健康编排器。 */
  healthCheck: Pick<HealthCheckService, 'run'>;
  /** 自动切换 Handler 使用的上下文恢复、执行和保护能力。 */
  autoSwitch: Pick<
    AutoSwitchService,
    'restorePlan' | 'execute' | 'handleFailure' | 'handleInvalidContext'
  >;
  /** 手动健康检查成功后生成可选后续任务的规划器。 */
  planAutoSwitch: AutoSwitchPlanner;
}

/**
 * 创建覆盖全部 TaskType 的不可变业务 Handler 注册表。
 *
 * @param dependencies 各 Handler 所需的领域服务集合。
 * @returns 编译期保证类型完整的 Handler 注册表。
 */
export function createTaskHandlerRegistry(
  dependencies: TaskHandlerDependencies,
): TaskHandlerRegistry {
  return {
    health_check: new HealthCheckTaskHandler(
      dependencies.healthCheck,
      dependencies.planAutoSwitch,
    ),
    diagnose: new DiagnoseTaskHandler(dependencies.store, dependencies.adapter),
    apply: new ApplyTaskHandler(dependencies.store, dependencies.adapter),
    reset: new ResetTaskHandler(dependencies.store, dependencies.adapter),
    rollback: new RollbackTaskHandler(dependencies.store, dependencies.adapter),
    auto_switch: new AutoSwitchTaskHandler(dependencies.autoSwitch),
  } satisfies TaskHandlerRegistry;
}
