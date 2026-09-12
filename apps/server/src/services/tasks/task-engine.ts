import type {
  ApiErrorDetails,
  StoredJsonObject,
  StoredTask,
  StreamResource,
  TaskType,
} from '@clash-sentinel/shared';
import { taskTypeSchema } from '@clash-sentinel/shared';
import { ApiError } from '../../api/errors.js';
import { noopLogger, type AppLogger } from '../../logging.js';
import type { SqliteStore } from '../../storage/store.js';
import type {
  OperationCoordinator,
  OperationLease,
} from '../operation-coordinator.js';
import type { StatusNotifier } from '../status-notifier.js';
import type {
  TaskExecutionResult,
  TaskExecutionIdentity,
  TaskFailureResult,
  TaskHandler,
  TaskHandlerRegistry,
  TaskSubmission,
} from './contracts.js';
import { TaskExecutionError } from './contracts.js';

/** 允许通过 HTTP API 创建的任务类型；自动切换只能由内部规划器创建。 */
export type ApiActionType = Exclude<TaskType, 'auto_switch'>;

/** HTTP 入队阶段传给异步任务日志的非持久化上下文。 */
export interface TaskLogContext {
  /** 与创建任务请求关联的完整请求 ID。 */
  requestId?: string;
}

/** 创建通用任务引擎需要的横切依赖。 */
export interface TaskEngineOptions {
  /** 持久化任务状态、结果和审计事件的 SQLite 门面。 */
  store: SqliteStore;
  /** 手动、定时检测和自动任务共享的单操作协调器。 */
  coordinator: OperationCoordinator;
  /** 发布任务生命周期及业务资源失效通知。 */
  notifier: StatusNotifier;
  /** 覆盖全部任务类型且在运行时不可变的 Handler 注册表。 */
  handlers: TaskHandlerRegistry;
  /** 可选统一日志器；测试省略时使用空实现。 */
  logger?: AppLogger;
}

/** 不写任务生命周期的内部执行结果。 */
export type TransientTaskOutcome =
  | { succeeded: true; changedResources: StreamResource[] }
  | {
      succeeded: false;
      changedResources: StreamResource[];
      error: unknown;
      errorCode: string;
    };

/** 只负责任务生命周期、互斥、持久化、审计、通知和关闭的通用引擎。 */
export class TaskEngine {
  /** 记录任务生命周期和引擎异常的统一日志器。 */
  private readonly logger: AppLogger;
  /** 当前由 HTTP 入队并在后台执行的完整任务链 Promise。 */
  private activeCompletion: Promise<void> | null = null;
  /** 服务进入关闭阶段后变为 false，阻止创建新任务。 */
  private accepting = true;

  /**
   * 创建任务引擎并立即验证注册表完整性。
   *
   * @param options 存储、协调器、通知器、Handler 和日志依赖。
   * @throws Handler 缺失或注册键与声明类型不一致时拒绝启动。
   */
  constructor(private readonly options: TaskEngineOptions) {
    this.logger = options.logger ?? noopLogger;
    this.validateHandlers(options.handlers);
  }

  /** @returns 当前占用全局槽的任务 UUID；空闲或定时检测时返回 null。 */
  getActiveTaskId() {
    const active = this.options.coordinator.getActive();
    return active?.kind === 'task' ? active.taskId : null;
  }

  /** @returns 手动任务、自动任务或定时检测是否正在占用全局槽。 */
  hasActiveOperation() {
    return this.options.coordinator.getActive() !== null;
  }

  /** @returns 可安全返回给 API 客户端的当前冲突信息。 */
  getConflictDetails(): ApiErrorDetails | undefined {
    return this.options.coordinator.getConflictDetails();
  }

  /**
   * 创建一个 HTTP 动作任务并安排后台执行。
   *
   * @param type 可由 API 发起的固定任务类型。
   * @param input 将持久化到任务表的动作输入。
   * @param logContext 仅用于日志关联的请求上下文。
   * @returns 已持久化为 queued 的任务，执行结果通过任务 API 查询。
   * @throws 服务关闭或全局槽已被占用时抛出 ACTION_CONFLICT。
   */
  enqueue(
    type: ApiActionType,
    input: StoredJsonObject | null = null,
    logContext: TaskLogContext = {},
  ): StoredTask {
    if (!this.accepting || this.options.coordinator.getActive()) {
      this.logger.warn('task:service', 'rejected', {
        taskType: type,
        requestId: logContext.requestId,
        reason: this.accepting ? 'operation_slot_busy' : 'service_stopping',
      });
      this.throwConflict();
    }
    const submission: TaskSubmission = {
      type,
      input,
      metadata: { requestId: logContext.requestId },
    };
    const task = this.createTask(submission);
    const lease = this.options.coordinator.tryAcquireManual(task.id);
    if (!lease) {
      this.logger.warn('task:service', 'rejected', {
        taskType: type,
        taskId: task.id,
        requestId: logContext.requestId,
        reason: 'operation_slot_busy',
      });
      this.throwConflict();
    }
    this.activeCompletion = Promise.resolve().then(async () => {
      try {
        await this.runCreatedTask(task, submission, lease);
      } finally {
        lease.release();
        this.activeCompletion = null;
      }
    });
    return task;
  }

  /**
   * 在调用方已经持有的全局租约中执行一个普通任务。
   *
   * @param submission 待创建任务的声明式类型、输入和日志元数据。
   * @param lease 当前健康检测持有且将切换到新任务 ID 的租约。
   * @returns 任务及其后续任务实际改变的去重资源。
   */
  async runWithLease(
    submission: TaskSubmission,
    lease: OperationLease,
  ): Promise<StreamResource[]> {
    if (!this.accepting) return [];
    const task = this.createTask(submission);
    lease.replaceWithTask(task.id);
    return await this.runCreatedTask(task, submission, lease);
  }

  /**
   * 在已有租约中执行不持久化根任务的 Handler；成功后续任务仍正常持久化。
   */
  async runTransientWithLease(
    submission: TaskSubmission,
    lease: OperationLease,
    executionId: string,
  ): Promise<TransientTaskOutcome> {
    const task: TaskExecutionIdentity = {
      id: executionId,
      type: submission.type,
      input: submission.input ?? null,
      persistence: 'transient',
    };
    const handler = this.options.handlers[task.type];
    let execution: TaskExecutionResult;
    try {
      const input = handler.parseInput(task.input);
      execution = await handler.execute({
        task,
        input,
        lease,
        logger: this.logger,
      });
    } catch (error) {
      const failure = await this.resolveFailure(handler, task, lease, error);
      return {
        succeeded: false,
        changedResources: [...new Set(failure.changedResources)],
        error,
        errorCode: failure.code,
      };
    }
    const changedResources = [...new Set(execution.changedResources)];
    for (const followUp of execution.followUps ?? []) {
      const followUpResources = await this.runWithLease(followUp, lease);
      for (const resource of followUpResources)
        if (!changedResources.includes(resource))
          changedResources.push(resource);
    }
    return { succeeded: true, changedResources };
  }

  /** 停止接收新任务；已经开始的任务链继续执行到安全终点。 */
  stopAccepting() {
    this.accepting = false;
  }

  /** @returns 当前 HTTP 后台任务链完成时解决的 Promise；空闲时立即完成。 */
  async waitForIdle() {
    await this.activeCompletion;
  }

  /**
   * 使用指定 Handler 执行已创建任务，并顺序运行声明式后续任务。
   *
   * @param task 已持久化的 queued 任务。
   * @param submission 创建任务时使用的进程内元数据。
   * @param lease 整条任务链共享的全局操作租约。
   * @returns 当前任务链累计改变的资源。
   */
  private async runCreatedTask(
    task: StoredTask,
    submission: TaskSubmission,
    lease: OperationLease,
  ): Promise<StreamResource[]> {
    const handler = this.options.handlers[task.type];
    const identity: TaskExecutionIdentity = {
      id: task.id,
      type: task.type,
      input: task.input,
      persistence: 'persistent',
    };
    const outcome = await this.runTask(
      task,
      identity,
      handler,
      submission,
      lease,
    );
    if (!outcome.succeeded) return outcome.changedResources;
    const resources = [...outcome.changedResources];
    for (const followUp of outcome.execution.followUps ?? []) {
      const followUpResources = await this.runWithLease(followUp, lease);
      for (const resource of followUpResources)
        if (!resources.includes(resource)) resources.push(resource);
    }
    return resources;
  }

  /**
   * 持久化 queued 任务并发布创建通知。
   *
   * @param submission 不包含执行函数的声明式任务。
   * @returns 新创建的任务记录。
   */
  private createTask(submission: TaskSubmission) {
    const task = this.options.store.createTask(
      submission.type,
      submission.input ?? null,
    );
    this.logger.info('task:service', 'queued', {
      taskType: task.type,
      taskId: task.id,
      ...submission.metadata,
    });
    this.options.notifier.publish('task_queued', [
      this.taskResource(task.id),
      ...(submission.queuedResources ?? []),
    ]);
    return task;
  }

  /**
   * 统一推进单个任务的开始、成功或失败终态。
   *
   * @param task 当前任务记录。
   * @param handler 只实现当前类型业务行为的处理器。
   * @param submission 任务日志和创建通知使用的元数据。
   * @param lease 当前任务持有的全局租约。
   * @returns 成功执行结果或失败资源摘要；异常不会逃逸破坏任务链。
   */
  private async runTask(
    task: StoredTask,
    identity: TaskExecutionIdentity,
    handler: TaskHandler,
    submission: TaskSubmission,
    lease: OperationLease,
  ): Promise<
    | {
        succeeded: true;
        execution: TaskExecutionResult;
        changedResources: StreamResource[];
      }
    | { succeeded: false; error: unknown; changedResources: StreamResource[] }
  > {
    const startedAt = Date.now();
    try {
      this.options.store.startTask(task.id);
      this.logger.info('task:service', 'started', {
        taskType: task.type,
        taskId: task.id,
        ...submission.metadata,
      });
      this.options.notifier.publish('task_started', [
        this.taskResource(task.id),
      ]);
      const input = handler.parseInput(task.input);
      const execution = await handler.execute({
        task: identity,
        input,
        lease,
        logger: this.logger,
      });
      this.options.store.completeTask(task.id, execution.result);
      const eventAppended = this.appendEventSafely(
        task,
        handler,
        true,
        execution.audit,
      );
      const changedResources = [...new Set(execution.changedResources)];
      if (eventAppended && !changedResources.includes('events'))
        changedResources.push('events');
      this.options.notifier.publish('task_succeeded', [
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
      const failure = await this.resolveFailure(
        handler,
        identity,
        lease,
        error,
      );
      let failedPersisted = false;
      try {
        this.options.store.failTask(
          task.id,
          failure.code,
          failure.message,
          failure.recoveryStatus,
        );
        failedPersisted = true;
      } catch {
        // 数据库关闭或任务已进入终态时不再篡改真实状态。
      }
      const changedResources = [...new Set(failure.changedResources)];
      const eventAppended = this.appendEventSafely(
        task,
        handler,
        false,
        failure.audit,
        failure.code,
        failure.recoveryStatus,
      );
      if (eventAppended && !changedResources.includes('events'))
        changedResources.push('events');
      if (failedPersisted)
        this.options.notifier.publish('task_failed', [
          this.taskResource(task.id),
          ...changedResources,
        ]);
      this.logger.error('task:service', 'failed', {
        taskType: task.type,
        taskId: task.id,
        durationMs: Date.now() - startedAt,
        errorCode: failure.code,
        recoveryStatus: failure.recoveryStatus,
        error,
      });
      return { succeeded: false, error, changedResources };
    }
  }

  /**
   * 将任意业务异常转换成安全且可持久化的失败结果。
   *
   * @param handler 当前任务 Handler。
   * @param task 当前任务记录。
   * @param lease 当前共享租约。
   * @param error Handler 抛出的原始异常。
   * @returns Handler 已处理结果或引擎的保守默认结果。
   */
  private async resolveFailure(
    handler: TaskHandler,
    task: TaskExecutionIdentity,
    lease: OperationLease,
    error: unknown,
  ): Promise<TaskFailureResult> {
    if (error instanceof TaskExecutionError) return error.failure;
    if (handler.handleFailure)
      try {
        return await handler.handleFailure({
          task,
          input: task.input ?? {},
          lease,
          logger: this.logger,
          error,
        });
      } catch (handlingError) {
        this.logger.error('task:service', 'failure handling failed', {
          taskType: task.type,
          taskId: task.id,
          error: handlingError,
        });
      }
    return {
      code: 'INTERNAL_ERROR',
      message: '后台任务执行失败',
      recoveryStatus: handler.critical ? 'unknown' : null,
      changedResources: [],
    };
  }

  /**
   * 追加任务终态审计；审计失败不回滚真实任务终态。
   *
   * @returns 审计事件是否成功写入，用于决定是否失效 events。
   */
  private appendEventSafely(
    task: StoredTask,
    handler: TaskHandler,
    succeeded: boolean,
    audit?: { summary?: string; details?: StoredJsonObject | null },
    errorCode?: string,
    recoveryStatus: TaskFailureResult['recoveryStatus'] = null,
  ) {
    try {
      this.options.store.appendEvent({
        type: `${task.type}_${succeeded ? 'succeeded' : 'failed'}`,
        severity: succeeded ? 'info' : 'error',
        retention: handler.critical ? 'critical' : 'ordinary',
        summary:
          audit?.summary ??
          `${handler.auditName}${succeeded ? '已完成' : '失败'}`,
        details:
          audit?.details ?? (errorCode ? { errorCode, recoveryStatus } : null),
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

  /**
   * 验证注册表覆盖所有任务类型且注册键与 Handler 声明一致。
   *
   * @param handlers 运行时将使用的完整注册表。
   * @throws 注册缺失、冗余或类型错配时抛出启动错误。
   */
  private validateHandlers(handlers: TaskHandlerRegistry) {
    const registered = Object.keys(handlers);
    const expected = taskTypeSchema.options;
    if (
      registered.length !== expected.length ||
      expected.some((type) => !(type in handlers))
    )
      throw new Error('任务处理器注册不完整');
    for (const [type, handler] of Object.entries(handlers))
      if (handler.type !== type)
        throw new Error(`任务处理器注册错误: ${type} != ${handler.type}`);
  }

  /** @returns 指向指定任务查询缓存的 SSE 资源标识。 */
  private taskResource(taskId: string): `task:${string}` {
    return `task:${taskId}`;
  }

  /** @throws 始终抛出不包含本机敏感状态的统一动作冲突。 */
  private throwConflict(): never {
    const active = this.options.coordinator.getActive();
    throw new ApiError(
      409,
      'ACTION_CONFLICT',
      active?.kind === 'scheduled_health'
        ? '定时健康检测正在执行'
        : '已有操作正在执行',
      this.options.coordinator.getConflictDetails(),
    );
  }
}
