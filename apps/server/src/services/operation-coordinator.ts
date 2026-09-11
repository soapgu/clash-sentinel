import type { ApiErrorDetails } from '@clash-sentinel/shared';

/** 当前占用全局 Legacy 执行槽的操作。 */
export type ActiveOperation =
  { kind: 'task'; taskId: string } | { kind: 'scheduled_health' };

/** 一次全局执行槽租约；完成工作后必须释放。 */
export interface OperationLease {
  /** 在不释放互斥槽的前提下，将当前健康轮次切换为指定任务。 */
  replaceWithTask(taskId: string): void;
  /** 幂等释放当前租约。 */
  release(): void;
}

/** 在手动任务与定时健康检测之间提供单进程互斥。 */
export class OperationCoordinator {
  private active: ActiveOperation | null = null;
  private activeToken: symbol | null = null;
  private idlePromise: Promise<void> = Promise.resolve();
  private resolveIdle: (() => void) | null = null;

  /** @returns 当前活动操作；空闲时返回 null。 */
  getActive(): ActiveOperation | null {
    return this.active;
  }

  /** @returns 当前冲突响应允许公开的脱敏详情。 */
  getConflictDetails(): ApiErrorDetails | undefined {
    if (this.active?.kind === 'task')
      return { activeTaskId: this.active.taskId };
    if (this.active?.kind === 'scheduled_health')
      return { activeOperation: 'scheduled_health' };
    return undefined;
  }

  /**
   * 为已创建的手动任务占用全局槽。
   *
   * @param taskId 可通过 API 查询的任务 UUID。
   * @returns 成功租约；槽已被占用时返回 null。
   */
  tryAcquireManual(taskId: string): OperationLease | null {
    return this.acquire({ kind: 'task', taskId });
  }

  /** @returns 定时健康检测租约；槽已被占用时返回 null。 */
  tryAcquireScheduled(): OperationLease | null {
    return this.acquire({ kind: 'scheduled_health' });
  }

  /** 等待当前活动操作释放全局槽。 */
  async waitForIdle(): Promise<void> {
    await this.idlePromise;
  }

  /** 创建带唯一令牌的租约，防止过期释放误伤后续操作。 */
  private acquire(operation: ActiveOperation): OperationLease | null {
    if (this.active) return null;
    const token = Symbol(operation.kind);
    this.active = operation;
    this.activeToken = token;
    this.idlePromise = new Promise<void>((resolve) => {
      this.resolveIdle = resolve;
    });
    let released = false;
    return {
      replaceWithTask: (taskId) => {
        if (released || this.activeToken !== token) return;
        this.active = { kind: 'task', taskId };
      },
      release: () => {
        if (released) return;
        released = true;
        if (this.activeToken !== token) return;
        this.active = null;
        this.activeToken = null;
        const resolve = this.resolveIdle;
        this.resolveIdle = null;
        resolve?.();
      },
    };
  }
}
