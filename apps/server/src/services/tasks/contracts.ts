import type {
  StoredJsonObject,
  StreamResource,
  TaskRecoveryStatus,
  TaskType,
} from '@clash-sentinel/shared';
import type { AppLogger } from '../../logging.js';
import type { OperationLease } from '../operation-coordinator.js';

/** 描述一个即将由 TaskEngine 持久化并执行的任务，不包含可执行回调。 */
export interface TaskSubmission {
  /** 注册表中用于选择 Handler 的稳定任务类型。 */
  type: TaskType;
  /** 将写入任务表的可序列化输入；省略时持久化为 null。 */
  input?: StoredJsonObject | null;
  /** 仅用于本次进程日志的上下文，不写入数据库或公开 API。 */
  metadata?: Record<string, unknown>;
  /** 创建 queued 任务时需要同时失效的业务资源。 */
  queuedResources?: StreamResource[];
}

/** Handler 可覆盖的任务审计事件内容。 */
export interface TaskAudit {
  /** 面向用户和运维人员的安全事件摘要。 */
  summary?: string;
  /** 经过存储层校验和脱敏的结构化事件详情。 */
  details?: StoredJsonObject | null;
}

/** Handler 成功后交给 TaskEngine 统一落库和通知的结果。 */
export interface TaskExecutionResult {
  /** 写入任务 result_json 并由任务查询 API 原样返回的业务结果。 */
  result: StoredJsonObject;
  /** 本次业务写入实际影响、需要客户端重新读取的资源。 */
  changedResources: readonly StreamResource[];
  /** 可选的审计摘要和详情；缺省时由 Handler 元数据生成。 */
  audit?: TaskAudit;
  /** 当前任务成功后在同一租约中顺序执行的声明式任务。 */
  followUps?: TaskSubmission[];
}

/** Handler 失败后交给 TaskEngine 统一持久化的安全结论。 */
export interface TaskFailureResult {
  /** 可持久化且可由 API 返回的稳定错误码。 */
  code: string;
  /** 不包含敏感数据的安全错误说明。 */
  message: string;
  /** 配置动作失败后的恢复结论；非配置动作使用 null。 */
  recoveryStatus: TaskRecoveryStatus | null;
  /** 失败处理过程中已经发生变化的资源。 */
  changedResources: readonly StreamResource[];
  /** 可选的失败审计内容。 */
  audit?: TaskAudit;
}

/** Handler 执行所需的最小任务身份，不要求任务已经持久化。 */
export interface TaskExecutionIdentity {
  id: string;
  type: TaskType;
  input: StoredJsonObject | null;
  persistence: 'persistent' | 'transient';
}

/** TaskEngine 调用 Handler 时提供的进程内执行上下文。 */
export interface TaskHandlerContext {
  /** 当前持久化任务或瞬时执行的最小身份。 */
  task: TaskExecutionIdentity;
  /** 经过当前 Handler 校验和归一化的任务输入。 */
  input: StoredJsonObject;
  /** 手动、定时检测和自动任务共享的全局操作租约。 */
  lease: OperationLease;
  /** Handler 记录领域日志时使用的统一日志器。 */
  logger: AppLogger;
}

/** Handler 处理执行异常时额外携带原始异常的上下文。 */
export interface TaskHandlerFailureContext extends TaskHandlerContext {
  /** 仅供服务端判断错误码和恢复状态的原始异常。 */
  error: unknown;
}

/** 单一任务类型的业务执行插件；不负责生命周期持久化和 SSE 发布。 */
export interface TaskHandler {
  /** Handler 唯一处理的任务类型，必须与注册键一致。 */
  readonly type: TaskType;
  /** TaskEngine 生成默认审计摘要时使用的中文动作名称。 */
  readonly auditName: string;
  /** 是否按关键配置动作保留审计并要求恢复状态。 */
  readonly critical: boolean;
  /**
   * 校验并归一化数据库中的任务输入。
   *
   * @param input 任务表中的原始 JSON 输入。
   * @returns 传给 execute 的安全输入。
   * @throws 输入不符合当前任务约束时抛出异常并进入统一失败流程。
   */
  parseInput(input: StoredJsonObject | null): StoredJsonObject;
  /**
   * 执行当前任务类型的领域行为。
   *
   * @param context 当前任务、已校验输入、共享租约和日志器。
   * @returns 交给引擎持久化的结果、资源变化和可选后续任务。
   */
  execute(context: TaskHandlerContext): Promise<TaskExecutionResult>;
  /**
   * 将领域异常转换成安全失败结果；省略时由引擎使用保守默认值。
   *
   * @param context 带原始异常的任务执行上下文。
   * @returns 可持久化的错误、恢复状态和资源变化。
   */
  handleFailure?(
    context: TaskHandlerFailureContext,
  ): TaskFailureResult | Promise<TaskFailureResult>;
}

/** 编译期要求每个 TaskType 恰好注册一个类型匹配的 Handler。 */
export type TaskHandlerRegistry = {
  [K in TaskType]: TaskHandler & { type: K };
};

/** 携带已完成领域恢复处理结果的内部异常，不直接暴露原始异常。 */
export class TaskExecutionError extends Error {
  /**
   * @param failure 已脱敏并可持久化的失败结果。
   * @param options 可选的内部异常 cause，仅供服务端日志追踪。
   */
  constructor(
    readonly failure: TaskFailureResult,
    options?: ErrorOptions,
  ) {
    super(failure.message, options);
    this.name = 'TaskExecutionError';
  }
}

/**
 * 将已经通过领域或共享 Schema 约束的对象标记为可持久化 JSON。
 *
 * @param value 已完成校验的领域对象。
 * @returns 供任务存储层执行大小限制和脱敏的 JSON 对象。
 */
export function asStoredJson(value: object): StoredJsonObject {
  return value as StoredJsonObject;
}
