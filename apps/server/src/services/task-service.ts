import type {
  HealthSnapshot,
  ApiErrorDetails,
  StoredJsonObject,
  StoredTask,
  StreamResource,
  TaskRecoveryStatus,
  TaskType,
} from '@clash-sentinel/shared';
import { LegacyAdapterError, type LegacyAdapter } from '../legacy/adapter.js';
import type { SqliteStore } from '../storage/store.js';
import { ApiError } from '../api/errors.js';
import type { HealthCheckService } from './health/health-check.js';
import type {
  OperationCoordinator,
  OperationLease,
} from './operation-coordinator.js';
import type { HealthCheckChanges } from './health/health-check.js';
import { noopLogger, type AppLogger } from '../logging.js';
import type {
  AutoSwitchPlan,
  AutoSwitchService,
} from './auto-switch-service.js';
import type { StatusNotifier } from './status-notifier.js';

/** Step 5 允许通过 API 启动的 Legacy 动作。 */
export type ApiActionType = Exclude<TaskType, 'auto_switch'>;

/** 具体动作交给统一任务生命周期保存的结果及资源变化。 */
interface ActionExecution {
  result: StoredJsonObject;
  changedResources: StreamResource[];
  eventSummary?: string;
  eventDetails?: StoredJsonObject | null;
  afterSuccess?: (lease: OperationLease) => Promise<void>;
}

interface TaskFailureHandling {
  recoveryStatus?: TaskRecoveryStatus | null;
  changedResources?: StreamResource[];
}

/** HTTP 入队阶段向异步任务传递的非持久化日志上下文。 */
export interface TaskLogContext {
  requestId?: string;
}

/** 任务服务实际调用的 LegacyAdapter 公开能力。 */
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

/** 单实例异步任务服务的依赖。 */
export interface TaskServiceOptions {
  /** 持久化任务、快照、诊断和事件的 SQLite 门面。 */
  store: SqliteStore;
  /** 执行固定 Legacy Shell 命令的适配器。 */
  adapter: LegacyOperations;
  /** 手动和定时检测共用的完整健康编排器。 */
  healthCheck: Pick<HealthCheckService, 'run'>;
  /** 手动任务与定时健康检测共享的全局执行槽。 */
  coordinator: OperationCoordinator;
  /** 向 Web 客户端发布任务状态和资源失效通知。 */
  /** 记录任务生命周期和关键配置动作。 */
  logger?: AppLogger;
  autoSwitch?: Pick<AutoSwitchService, 'prepare' | 'execute' | 'handleFailure'>;
  notifier: StatusNotifier;
}

/** 串行执行 API 发起的 Legacy 动作并持久化完整生命周期。 */
export class TaskService {
  private readonly store: SqliteStore;
  private readonly adapter: LegacyOperations;
  private readonly healthCheck: Pick<HealthCheckService, 'run'>;
  private readonly coordinator: OperationCoordinator;
  private readonly logger: AppLogger;
  private readonly autoSwitch: Pick<
    AutoSwitchService,
    'prepare' | 'execute' | 'handleFailure'
  >;
  private readonly notifier: StatusNotifier;
  private activeCompletion: Promise<void> | null = null;
  private accepting = true;

  /** 使用存储层和 Legacy 适配器创建任务服务。 */
  constructor(options: TaskServiceOptions) {
    this.store = options.store;
    this.adapter = options.adapter;
    this.healthCheck = options.healthCheck;
    this.coordinator = options.coordinator;
    this.logger = options.logger ?? noopLogger;
    this.notifier = options.notifier;
    this.autoSwitch =
      options.autoSwitch ??
      ({
        prepare: () => null,
        execute: async () => {
          throw new Error('自动切换服务未配置');
        },
        handleFailure: () => ({
          recoveryStatus: 'unknown',
          changedResources: [],
        }),
      } satisfies Pick<
        AutoSwitchService,
        'prepare' | 'execute' | 'handleFailure'
      >);
  }

  /** @returns 当前活动任务 UUID；空闲时返回 null。 */
  getActiveTaskId() {
    const active = this.coordinator.getActive();
    return active?.kind === 'task' ? active.taskId : null;
  }

  /** @returns 当前是否有手动动作或定时检测正在执行。 */
  hasActiveOperation() {
    return this.coordinator.getActive() !== null;
  }

  /** @returns 当前动作冲突可向 API 公开的脱敏详情。 */
  getConflictDetails(): ApiErrorDetails | undefined {
    return this.coordinator.getConflictDetails();
  }

  /**
   * 创建并异步执行一个动作；检查和占用全局槽之间没有异步间隙。
   *
   * @param type 固定 API 动作类型。
   * @param input 可选脱敏任务输入。
   * @returns 已持久化的 queued 任务。
   * @throws {ApiError} 已有任务或服务正在关闭时抛出动作冲突。
   */
  enqueue(
    type: ApiActionType,
    input: StoredJsonObject | null = null,
    logContext: TaskLogContext = {},
  ): StoredTask {
    if (!this.accepting || this.coordinator.getActive()) {
      this.logger.warn('task:service', 'rejected', {
        taskType: type,
        requestId: logContext.requestId,
        reason: this.accepting ? 'operation_slot_busy' : 'service_stopping',
      });
      this.throwConflict();
    }
    const task = this.createTask(type, input, {
      requestId: logContext.requestId,
    });
    const lease = this.coordinator.tryAcquireManual(task.id);
    if (!lease) {
      this.logger.warn('task:service', 'rejected', {
        taskType: type,
        taskId: task.id,
        requestId: logContext.requestId,
        reason: 'operation_slot_busy',
      });
      this.throwConflict();
    }
    this.activeCompletion = Promise.resolve().then(() =>
      this.execute(task, lease, logContext),
    );
    return task;
  }

  /** 停止接收新任务，已运行任务继续完成。 */
  stopAccepting() {
    this.accepting = false;
  }

  /** 等待当前动作完成，空闲时立即返回。 */
  async waitForIdle() {
    await this.activeCompletion;
  }

  /** 在现有健康检测租约中创建并执行普通 auto_switch 任务。 */
  async runAutoSwitch(
    health: Awaited<ReturnType<HealthCheckService['run']>>,
    source: 'manual' | 'scheduled',
    lease: OperationLease,
    parentId: string,
  ): Promise<StreamResource[]> {
    if (!this.accepting) return [];
    const plan = this.autoSwitch.prepare(health, source, parentId);
    if (!plan) return [];
    const task = this.createTask(
      'auto_switch',
      plan.input,
      { trigger: source, parentId },
      ['monitoring'],
    );
    lease.replaceWithTask(task.id);
    const outcome = await this.runTask(
      task,
      () => this.executeAction(task, plan),
      {
        metadata: { trigger: source, parentId },
        onFailure: (error, recoveryStatus) =>
          this.autoSwitch.handleFailure(plan, error, recoveryStatus),
      },
    );
    this.logger.info('health:scheduler', 'automatic handling completed', {
      taskId: task.id,
      trigger: source,
      parentId,
      succeeded: outcome.succeeded,
    });
    return outcome.changedResources;
  }

  /** 执行动作、持久化领域结果并最终释放全局槽。 */
  private async execute(
    task: StoredTask,
    lease: OperationLease,
    logContext: TaskLogContext,
  ) {
    try {
      const outcome = await this.runTask(task, () => this.executeAction(task), {
        metadata: { requestId: logContext.requestId },
      });
      if (outcome.succeeded) await outcome.execution.afterSuccess?.(lease);
    } finally {
      lease.release();
      this.activeCompletion = null;
    }
  }

  /** 根据固定任务类型调用适配器并保存对应快照或诊断。 */
  private async executeAction(
    task: StoredTask,
    autoSwitchPlan?: AutoSwitchPlan,
  ): Promise<ActionExecution> {
    switch (task.type) {
      case 'health_check': {
        const execution = await this.healthCheck.run('manual', task.id);
        return {
          result: this.asJson(execution.snapshot),
          changedResources: this.healthCheckResources(execution.changes),
          afterSuccess: async (lease) => {
            await this.runAutoSwitch(execution, 'manual', lease, task.id);
          },
        };
      }
      case 'diagnose':
        return {
          result: this.asJson(
            this.store.replaceDiagnosis(await this.adapter.diagnose()),
          ),
          changedResources: ['candidates', 'events'],
        };
      case 'apply': {
        const ip = String(task.input?.ip ?? '');
        return await this.executeCriticalAction(
          task,
          'apply',
          async () => {
            const result = await this.adapter.applyIp(ip);
            await this.refreshIdentity(false);
            return {
              result: this.asJson(result),
              changedResources: ['status', 'events'],
            };
          },
          { targetIp: ip },
        );
      }
      case 'reset': {
        return await this.executeCriticalAction(task, 'reset', async () => {
          const result = await this.adapter.resetLock();
          await this.refreshIdentity(true);
          this.store.updateSettings({
            autoSwitchEnabled: false,
            autoSwitchProfileUid: null,
          });
          this.logger.info('settings:service', 'settings updated', {
            taskId: task.id,
            changedFields: ['autoSwitchEnabled', 'autoSwitchProfileUid'],
            reason: 'reset',
          });
          return {
            result: this.asJson(result),
            changedResources: ['status', 'settings', 'events'],
          };
        });
      }
      case 'rollback': {
        return await this.executeCriticalAction(task, 'rollback', async () => {
          const result = await this.adapter.rollback();
          await this.refreshIdentity(false);
          return {
            result: this.asJson(result),
            changedResources: ['status', 'events'],
          };
        });
      }
      case 'auto_switch':
        if (autoSwitchPlan)
          return await this.autoSwitch.execute(autoSwitchPlan);
        throw new Error('auto_switch 缺少健康检测计划');
      default:
        throw new Error('不支持的任务类型');
    }
  }

  /** 创建任意任务并统一记录 queued 日志与 SSE 通知。 */
  private createTask(
    type: TaskType,
    input: StoredJsonObject | null = null,
    metadata: Record<string, unknown> = {},
    changedResources: StreamResource[] = [],
  ) {
    const task = this.store.createTask(type, input);
    this.logger.info('task:service', 'queued', {
      taskType: type,
      taskId: task.id,
      ...metadata,
    });
    this.notifier.publish('task_queued', [
      this.taskResource(task.id),
      ...changedResources,
    ]);
    return task;
  }

  /** 统一执行所有任务的开始、终态、审计、日志和 SSE 生命周期。 */
  private async runTask<T extends ActionExecution>(
    task: StoredTask,
    operation: () => Promise<T>,
    options: {
      metadata?: Record<string, unknown>;
      onFailure?: (
        error: unknown,
        recoveryStatus: TaskRecoveryStatus | null,
      ) => TaskFailureHandling | Promise<TaskFailureHandling>;
    } = {},
  ): Promise<
    | { succeeded: true; execution: T; changedResources: StreamResource[] }
    | { succeeded: false; error: unknown; changedResources: StreamResource[] }
  > {
    const startedAt = Date.now();
    try {
      this.store.startTask(task.id);
      this.logger.info('task:service', 'started', {
        taskType: task.type,
        taskId: task.id,
        ...options.metadata,
      });
      this.notifier.publish('task_started', [this.taskResource(task.id)]);
      const execution = await operation();
      this.store.completeTask(task.id, execution.result);
      const eventAppended = this.appendEventSafely(
        task,
        true,
        undefined,
        null,
        execution.eventSummary,
        execution.eventDetails,
      );
      const changedResources = [...execution.changedResources];
      if (eventAppended && !changedResources.includes('events'))
        changedResources.push('events');
      this.notifier.publish('task_succeeded', [
        this.taskResource(task.id),
        ...changedResources,
      ]);
      this.logger.info('task:service', 'succeeded', {
        taskType: task.type,
        taskId: task.id,
        durationMs: Date.now() - startedAt,
        changedResources,
      });
      return { succeeded: true, execution, changedResources };
    } catch (error) {
      const code =
        error instanceof LegacyAdapterError ? error.code : 'INTERNAL_ERROR';
      const message =
        error instanceof LegacyAdapterError
          ? error.message
          : '后台任务执行失败';
      let recoveryStatus = this.failureRecoveryStatus(task, error);
      let changedResources: StreamResource[] = [];
      if (options.onFailure) {
        try {
          const handling = await options.onFailure(error, recoveryStatus);
          recoveryStatus = handling.recoveryStatus ?? recoveryStatus;
          changedResources = handling.changedResources ?? [];
        } catch (handlingError) {
          recoveryStatus = 'unknown';
          this.logger.error('task:service', 'failure handling failed', {
            taskType: task.type,
            taskId: task.id,
            error: handlingError,
          });
        }
      }
      let failedPersisted = false;
      try {
        this.store.failTask(task.id, code, message, recoveryStatus);
        failedPersisted = true;
      } catch {
        // 数据库关闭或任务已进入终态时不再篡改真实状态。
      }
      const eventAppended = this.appendEventSafely(
        task,
        false,
        code,
        recoveryStatus,
      );
      if (eventAppended && !changedResources.includes('events'))
        changedResources.push('events');
      if (failedPersisted)
        this.notifier.publish('task_failed', [
          this.taskResource(task.id),
          ...changedResources,
        ]);
      this.logger.error('task:service', 'failed', {
        taskType: task.type,
        taskId: task.id,
        durationMs: Date.now() - startedAt,
        errorCode: code,
        recoveryStatus,
        error,
      });
      return { succeeded: false, error, changedResources };
    }
  }

  /** 追加任务审计事件，辅助事件失败不改变任务真实终态。 */
  private appendEventSafely(
    task: StoredTask,
    succeeded: boolean,
    errorCode?: string,
    recoveryStatus: TaskRecoveryStatus | null = null,
    summary?: string,
    details?: StoredJsonObject | null,
  ) {
    const critical = ['apply', 'reset', 'rollback', 'auto_switch'].includes(
      task.type,
    );
    try {
      this.store.appendEvent({
        type: `${task.type}_${succeeded ? 'succeeded' : 'failed'}`,
        severity: succeeded ? 'info' : 'error',
        retention: critical ? 'critical' : 'ordinary',
        summary:
          summary ??
          (succeeded
            ? `${this.actionName(task.type)}已完成`
            : `${this.actionName(task.type)}失败`),
        details: details ?? (errorCode ? { errorCode, recoveryStatus } : null),
        taskId: task.id,
      });
      return true;
    } catch (error) {
      this.logger.warn('task:service', 'audit event append failed', {
        taskType: task.type,
        taskId: task.id,
        error,
      });
      return false;
    }
  }

  /** 根据任务类型和适配器结论计算失败后的恢复状态。 */
  private failureRecoveryStatus(
    task: StoredTask,
    error: unknown,
  ): TaskRecoveryStatus | null {
    if (!['apply', 'reset', 'rollback', 'auto_switch'].includes(task.type))
      return null;
    if (error instanceof LegacyAdapterError)
      return error.recoveryStatus ?? 'unknown';
    return 'unknown';
  }

  private actionName(type: TaskType) {
    return {
      health_check: '健康检查',
      diagnose: '严格诊断',
      apply: '应用候选 IP',
      reset: '解除入口锁定',
      rollback: '回滚配置',
      auto_switch: '自动切换',
    }[type];
  }

  private taskResource(taskId: string): `task:${string}` {
    return `task:${taskId}`;
  }

  /** 为 apply、reset、rollback 记录独立于任务状态的高风险操作日志。 */
  private async executeCriticalAction(
    task: StoredTask,
    action: 'apply' | 'reset' | 'rollback',
    operation: () => Promise<ActionExecution>,
    metadata: Record<string, unknown> = {},
  ) {
    const startedAt = Date.now();
    this.logger.info('task:service', `${action} started`, {
      taskId: task.id,
      ...metadata,
    });
    try {
      const execution = await operation();
      this.logger.info('task:service', `${action} succeeded`, {
        taskId: task.id,
        durationMs: Date.now() - startedAt,
      });
      return execution;
    } catch (error) {
      this.logger.error('task:service', `${action} failed`, {
        taskId: task.id,
        durationMs: Date.now() - startedAt,
        errorCode:
          error instanceof LegacyAdapterError ? error.code : 'INTERNAL_ERROR',
        error,
      });
      throw error;
    }
  }

  /** 配置动作后刷新订阅身份并把综合健康状态保守地置为 unknown。 */
  private async refreshIdentity(clearCooldown: boolean) {
    const status = await this.adapter.getStatus();
    const previous = this.store.getHealthSnapshot();
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
    this.store.upsertHealthSnapshot(snapshot);
  }

  /** 将已由共享 Schema 约束的领域对象转换为存储扩展 JSON。 */
  private asJson(value: object): StoredJsonObject {
    return value as StoredJsonObject;
  }

  /** 将健康检查实际变化转换为任务成功后需要重新读取的资源。 */
  private healthCheckResources(changes: HealthCheckChanges): StreamResource[] {
    const resources: StreamResource[] = [];
    if (changes.statusUpdated) resources.push('status');
    if (changes.sitesUpdated) resources.push('sites');
    if (changes.candidatesUpdated) resources.push('candidates');
    if (changes.eventAppended) resources.push('events');
    if (changes.settingsUpdated) resources.push('settings');
    // 手动任务成功本身会追加审计事件。
    if (!resources.includes('events')) resources.push('events');
    return resources;
  }

  /** 抛出不包含本机状态细节的统一动作冲突。 */
  private throwConflict(): never {
    const active = this.coordinator.getActive();
    throw new ApiError(
      409,
      'ACTION_CONFLICT',
      active?.kind === 'scheduled_health'
        ? '定时健康检测正在执行'
        : '已有操作正在执行',
      this.coordinator.getConflictDetails(),
    );
  }
}
