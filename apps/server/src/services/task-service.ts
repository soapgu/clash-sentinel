import type {
  HealthSnapshot,
  ApiErrorDetails,
  StoredJsonObject,
  StoredTask,
  StreamResource,
  TaskType,
  TaskRecoveryStatus,
} from '@clash-sentinel/shared';
import { LegacyAdapterError, type LegacyAdapter } from '../legacy/adapter.js';
import type { SqliteStore } from '../storage/store.js';
import { ApiError } from '../api/errors.js';
import type { HealthCheckService } from './health/health-check.js';
import type {
  OperationCoordinator,
  OperationLease,
} from './operation-coordinator.js';
import type { StatusNotifier } from './status-notifier.js';
import type { HealthCheckChanges } from './health/health-check.js';
import { noopLogger, type AppLogger } from '../logging.js';

/** Step 5 允许通过 API 启动的 Legacy 动作。 */
export type ApiActionType = Exclude<TaskType, 'auto_switch'>;

/** 具体动作交给统一任务生命周期保存的结果及资源变化。 */
interface ActionExecution {
  result: StoredJsonObject;
  changedResources: StreamResource[];
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
  notifier: StatusNotifier;
  /** 记录任务生命周期和关键配置动作。 */
  logger?: AppLogger;
}

/** 串行执行 API 发起的 Legacy 动作并持久化完整生命周期。 */
export class TaskService {
  private readonly store: SqliteStore;
  private readonly adapter: LegacyOperations;
  private readonly healthCheck: Pick<HealthCheckService, 'run'>;
  private readonly coordinator: OperationCoordinator;
  private readonly notifier: StatusNotifier;
  private readonly logger: AppLogger;
  private activeCompletion: Promise<void> | null = null;
  private accepting = true;

  /** 使用存储层和 Legacy 适配器创建任务服务。 */
  constructor(options: TaskServiceOptions) {
    this.store = options.store;
    this.adapter = options.adapter;
    this.healthCheck = options.healthCheck;
    this.coordinator = options.coordinator;
    this.notifier = options.notifier;
    this.logger = options.logger ?? noopLogger;
  }

  /** @returns 当前活动任务 UUID；空闲时返回 null。 */
  getActiveTaskId() {
    const active = this.coordinator.getActive();
    return active?.kind === 'manual_task' ? active.taskId : null;
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
    const task = this.store.createTask(type, input);
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
    this.logger.info('task:service', 'queued', {
      taskType: task.type,
      taskId: task.id,
      requestId: logContext.requestId,
    });
    this.notifier.publish('task_queued', [this.taskResource(task.id)]);
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

  /** 执行动作、持久化领域结果并最终释放全局槽。 */
  private async execute(
    task: StoredTask,
    lease: OperationLease,
    logContext: TaskLogContext,
  ) {
    const startedAt = Date.now();
    try {
      this.store.startTask(task.id);
      this.logger.info('task:service', 'started', {
        taskType: task.type,
        taskId: task.id,
        requestId: logContext.requestId,
      });
      this.notifier.publish('task_started', [this.taskResource(task.id)]);
      const execution = await this.executeAction(task);
      this.store.completeTask(task.id, execution.result);
      this.appendEventSafely(task, true);
      this.notifier.publish('task_succeeded', [
        this.taskResource(task.id),
        ...execution.changedResources,
      ]);
      this.logger.info('task:service', 'succeeded', {
        taskType: task.type,
        taskId: task.id,
        durationMs: Date.now() - startedAt,
        changedResources: execution.changedResources,
      });
    } catch (error) {
      const code =
        error instanceof LegacyAdapterError ? error.code : 'INTERNAL_ERROR';
      const message =
        error instanceof LegacyAdapterError
          ? error.message
          : '后台任务执行失败';
      let failedPersisted = false;
      const recoveryStatus = this.failureRecoveryStatus(task, error);
      try {
        this.store.failTask(task.id, code, message, recoveryStatus);
        failedPersisted = true;
      } catch {
        // 数据库已经关闭或任务已进入终态时不能再改变真实结果。
      }
      this.appendEventSafely(task, false, code, recoveryStatus);
      if (failedPersisted)
        this.notifier.publish('task_failed', [
          this.taskResource(task.id),
          'events',
        ]);
      this.logger.error('task:service', 'failed', {
        taskType: task.type,
        taskId: task.id,
        durationMs: Date.now() - startedAt,
        errorCode: code,
        recoveryStatus,
        error,
      });
    } finally {
      lease.release();
      this.activeCompletion = null;
    }
  }

  /** 根据固定任务类型调用适配器并保存对应快照或诊断。 */
  private async executeAction(task: StoredTask): Promise<ActionExecution> {
    switch (task.type) {
      case 'health_check': {
        const execution = await this.healthCheck.run('manual', task.id);
        return {
          result: this.asJson(execution.snapshot),
          changedResources: this.healthCheckResources(execution.changes),
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
      default:
        throw new Error('不支持的任务类型');
    }
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

  /** 追加任务结果事件，事件失败不篡改已经落盘的任务终态。 */
  private appendEventSafely(
    task: StoredTask,
    succeeded: boolean,
    errorCode?: string,
    recoveryStatus: TaskRecoveryStatus | null = null,
  ) {
    const critical = ['apply', 'reset', 'rollback'].includes(task.type);
    try {
      this.store.appendEvent({
        type: `${task.type}_${succeeded ? 'succeeded' : 'failed'}`,
        severity: succeeded ? 'info' : 'error',
        retention: critical ? 'critical' : 'ordinary',
        summary: succeeded
          ? `${this.actionName(task.type)}已完成`
          : `${this.actionName(task.type)}失败`,
        details: errorCode ? { errorCode, recoveryStatus } : null,
        taskId: task.id,
      });
    } catch (error) {
      this.logger.warn('task:service', 'audit event append failed', {
        taskType: task.type,
        taskId: task.id,
        error,
      });
      // 事件属于辅助审计信息，写入失败不能反转任务真实终态。
    }
  }

  /** 仅配置类任务公开恢复状态；未知异常不能假定配置已恢复。 */
  private failureRecoveryStatus(
    task: StoredTask,
    error: unknown,
  ): TaskRecoveryStatus | null {
    if (!['apply', 'reset', 'rollback'].includes(task.type)) return null;
    if (error instanceof LegacyAdapterError)
      return error.recoveryStatus ?? 'unknown';
    return 'unknown';
  }

  /** 将任务类型转换为面向用户的事件名称。 */
  private actionName(type: TaskType) {
    const names: Record<TaskType, string> = {
      health_check: '健康检查',
      diagnose: '严格诊断',
      apply: '应用候选 IP',
      reset: '解除入口锁定',
      rollback: '回滚配置',
      auto_switch: '自动切换',
    };
    return names[type];
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
    // 手动任务成功本身会追加审计事件。
    if (!resources.includes('events')) resources.push('events');
    return resources;
  }

  /** 将已校验的任务 UUID 转换为共享 SSE 任务资源。 */
  private taskResource(taskId: string): `task:${string}` {
    return `task:${taskId}`;
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
