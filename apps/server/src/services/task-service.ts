import type {
  HealthSnapshot,
  StoredJsonObject,
  StoredTask,
  TaskType,
} from '@clash-sentinel/shared';
import { LegacyAdapterError, type LegacyAdapter } from '../legacy/adapter.js';
import type { SqliteStore } from '../storage/store.js';
import { ApiError } from '../api/errors.js';

/** Step 5 允许通过 API 启动的 Legacy 动作。 */
export type ApiActionType = Exclude<TaskType, 'auto_switch'>;

/** 任务服务实际调用的 LegacyAdapter 公开能力。 */
export type LegacyOperations = Pick<
  LegacyAdapter,
  | 'getStatus'
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
}

/** 串行执行 API 发起的 Legacy 动作并持久化完整生命周期。 */
export class TaskService {
  private readonly store: SqliteStore;
  private readonly adapter: LegacyOperations;
  private activeTaskId: string | null = null;
  private activeCompletion: Promise<void> | null = null;
  private accepting = true;

  /** 使用存储层和 Legacy 适配器创建任务服务。 */
  constructor(options: TaskServiceOptions) {
    this.store = options.store;
    this.adapter = options.adapter;
  }

  /** @returns 当前活动任务 UUID；空闲时返回 null。 */
  getActiveTaskId() {
    return this.activeTaskId;
  }

  /** @returns 当前是否有动作正在排队或执行。 */
  hasActiveTask() {
    return this.activeTaskId !== null;
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
  ): StoredTask {
    if (!this.accepting || this.activeTaskId)
      throw new ApiError(409, 'ACTION_CONFLICT', '已有操作正在执行', {
        ...(this.activeTaskId
          ? { activeTaskId: this.activeTaskId }
          : undefined),
      });
    const task = this.store.createTask(type, input);
    this.activeTaskId = task.id;
    this.activeCompletion = Promise.resolve().then(() => this.execute(task));
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
  private async execute(task: StoredTask) {
    try {
      this.store.startTask(task.id);
      const result = await this.executeAction(task);
      this.store.completeTask(task.id, result);
      this.appendEventSafely(task, true);
    } catch (error) {
      const code =
        error instanceof LegacyAdapterError ? error.code : 'INTERNAL_ERROR';
      const message =
        error instanceof LegacyAdapterError
          ? error.message
          : '后台任务执行失败';
      try {
        this.store.failTask(task.id, code, message);
      } catch {
        // 数据库已经关闭或任务已进入终态时不能再改变真实结果。
      }
      this.appendEventSafely(task, false, code);
    } finally {
      if (this.activeTaskId === task.id) {
        this.activeTaskId = null;
        this.activeCompletion = null;
      }
    }
  }

  /** 根据固定任务类型调用适配器并保存对应快照或诊断。 */
  private async executeAction(task: StoredTask): Promise<StoredJsonObject> {
    switch (task.type) {
      case 'health_check': {
        const health = await this.adapter.healthCheck();
        const status = await this.adapter.getStatus();
        return this.asJson(
          this.store.upsertHealthSnapshot({
            status: health.status,
            profile: status.profile,
            lock: status.lock,
            internetSuccess: health.internetSuccess,
            internetTotal: health.internetTotal,
            consecutiveFailures: health.consecutiveFailures,
            recommendedIp: health.recommendedIp,
            autoSwitchCooldownUntil:
              this.store.getHealthSnapshot()?.autoSwitchCooldownUntil ?? null,
            updatedAt: this.normalizeTime(health.checkedAt),
          }),
        );
      }
      case 'diagnose':
        return this.asJson(
          this.store.replaceDiagnosis(await this.adapter.diagnose()),
        );
      case 'apply': {
        const ip = String(task.input?.ip ?? '');
        const result = await this.adapter.applyIp(ip);
        await this.refreshIdentity(false);
        return this.asJson(result);
      }
      case 'reset': {
        const result = await this.adapter.resetLock();
        await this.refreshIdentity(true);
        this.store.updateSettings({
          autoSwitchEnabled: false,
          autoSwitchProfileUid: null,
        });
        return this.asJson(result);
      }
      case 'rollback': {
        const result = await this.adapter.rollback();
        await this.refreshIdentity(false);
        return this.asJson(result);
      }
      default:
        throw new Error('不支持的任务类型');
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

  /** 将 Legacy 日期文本规范化为健康快照要求的 ISO 8601。 */
  private normalizeTime(value: string) {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) throw new Error('健康检查时间无效');
    return new Date(parsed).toISOString();
  }

  /** 追加任务结果事件，事件失败不篡改已经落盘的任务终态。 */
  private appendEventSafely(
    task: StoredTask,
    succeeded: boolean,
    errorCode?: string,
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
        details: errorCode ? { errorCode } : null,
        taskId: task.id,
      });
    } catch {
      // 事件属于辅助审计信息，写入失败不能反转任务真实终态。
    }
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
}
