import type {
  MonitoringSnapshot,
  StreamResource,
} from '@clash-sentinel/shared';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '../../composition/tokens.js';
import type { EventRepository } from '../../storage/event-repository.js';
import type { SettingsRepository } from '../../storage/settings-repository.js';
import type { StatusNotifier } from '../status-notifier.js';
import { randomUUID } from 'node:crypto';
import { noopLogger, type AppLogger } from '../../logging.js';
import type { TaskEngine } from '../tasks/task-engine.js';

/** 启动即检查、按最新设置递归调度且不会重入的健康调度器。 */
@injectable()
export class HealthScheduler {
  private timer: NodeJS.Timeout | null = null;
  private currentRun: Promise<void> | null = null;
  private stopped = true;
  private lastStartedAt: string | null = null;
  private lastCompletedAt: string | null = null;
  /** 下一次内部调度唤醒时间；暂停时它只用于复查设置，不一定对外公开。 */
  private nextTickAt: string | null = null;
  private readonly now: () => number;
  private readonly logger: AppLogger;

  /**
   * @param settings 动态读取监测开关和周期的设置仓储。
   * @param events 追加调度失败事件的事件仓储。
   * @param notifier 向 Web 客户端发布调度运行态和快照失效通知。
   * @param taskEngine 在定时检测已有租约中执行瞬时健康任务的统一引擎。
   * @param now 返回当前 Unix 毫秒时间；测试可注入可控时钟。
   * @param logger 记录调度计划、执行、跳过和失败。
   */
  constructor(
    @inject(TOKENS.settingsRepository)
    private readonly settings: Pick<SettingsRepository, 'getSettings'>,
    @inject(TOKENS.eventRepository)
    private readonly events: Pick<EventRepository, 'appendEvent'>,
    @inject(TOKENS.statusNotificationCenter)
    private readonly notifier: StatusNotifier,
    @inject(TOKENS.taskEngine)
    private readonly taskEngine: Pick<
      TaskEngine,
      'tryRunScheduledTask' | 'getActiveTaskId'
    >,
    @inject(TOKENS.clock) now: () => number = Date.now,
    @inject(TOKENS.appLogger) logger: AppLogger = noopLogger,
  ) {
    this.now = now;
    this.logger = logger;
  }

  /**
   * 读取当前进程的定时监测运行态，不执行检测或写入存储。
   *
   * @returns 结合最新设置与调度器内存时间生成的新快照。
   */
  getSnapshot(): MonitoringSnapshot {
    const enabled = this.settings.getSettings().monitoringEnabled;
    const state = this.currentRun
      ? 'running'
      : enabled
        ? 'waiting'
        : 'disabled';
    const nextRunAt = state === 'waiting' ? this.nextTickAt : null;
    return {
      enabled,
      state,
      lastStartedAt: this.lastStartedAt,
      lastCompletedAt: this.lastCompletedAt,
      nextRunAt,
      activeTaskId: this.taskEngine.getActiveTaskId(),
    };
  }

  /** 启动调度器并立即尝试第一轮检测。 */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.logger.info('health:scheduler', 'started');
    this.runTick();
  }

  /** 停止后续定时器并等待已经开始的检测完成。 */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextTickAt = null;
    await this.currentRun;
    this.logger.info('health:scheduler', 'stopped');
  }

  /** 尝试占用定时槽；冲突时静默跳过并安排下一周期。 */
  private runTick(): void {
    if (this.stopped) return;
    const settings = this.settings.getSettings();
    if (!settings.monitoringEnabled) {
      this.logger.debug('health:scheduler', 'monitoring disabled');
      this.schedule(settings.checkIntervalMs);
      return;
    }
    const runId = randomUUID();
    const currentRun = this.taskEngine.tryRunScheduledTask(
      { type: 'health_check' },
      runId,
    );
    if (!currentRun) {
      this.logger.warn('health:scheduler', 'run skipped', {
        reason: 'operation_slot_busy',
      });
      this.schedule(settings.checkIntervalMs);
      return;
    }
    this.lastStartedAt = new Date(this.now()).toISOString();
    const startedAt = this.now();
    this.logger.info('health:scheduler', 'run started', { runId });
    this.nextTickAt = null;
    this.notifier.publish('monitoring_started', ['monitoring']);
    const changedResources: StreamResource[] = ['monitoring'];
    let failed = false;
    this.currentRun = currentRun
      .then((outcome) => {
        if (!outcome.succeeded) {
          failed = true;
          this.logger.error('health:scheduler', 'run failed', {
            runId,
            durationMs: this.now() - startedAt,
            errorCode: outcome.errorCode,
          });
          changedResources.push(...outcome.changedResources, 'status', 'sites');
          if (this.appendFailureEvent()) changedResources.push('events');
          return;
        }
        for (const resource of outcome.changedResources)
          if (!changedResources.includes(resource))
            changedResources.push(resource);
      })
      .catch((error) => {
        failed = true;
        this.logger.error('health:scheduler', 'run failed', {
          runId,
          durationMs: this.now() - startedAt,
          errorCode:
            error instanceof Error && 'code' in error
              ? String(error.code)
              : 'INTERNAL_ERROR',
        });
        // 异常前可能已经写入部分站点或健康快照，失败路径保守刷新二者。
        changedResources.push('status', 'sites');
        if (this.appendFailureEvent()) changedResources.push('events');
      })
      .finally(() => {
        this.lastCompletedAt = new Date(this.now()).toISOString();
        this.currentRun = null;
        if (!this.stopped)
          this.schedule(this.settings.getSettings().checkIntervalMs);
        this.notifier.publish('monitoring_completed', [
          ...new Set(changedResources),
        ]);
        if (!failed)
          this.logger.info('health:scheduler', 'run completed', {
            runId,
            durationMs: this.now() - startedAt,
            changedResources,
          });
      });
  }

  /** 安排下一次不早于当前轮完成后的检测。 */
  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.nextTickAt = new Date(this.now() + delayMs).toISOString();
    this.logger.debug('health:scheduler', 'run scheduled', {
      nextRunAt: this.nextTickAt,
      delayMs,
    });
    this.timer = setTimeout(() => {
      this.timer = null;
      this.nextTickAt = null;
      this.runTick();
    }, delayMs);
    this.timer.unref();
  }

  /** 记录不包含原始异常、路径或响应正文的定时轮次失败。 */
  private appendFailureEvent(): boolean {
    try {
      this.events.appendEvent({
        type: 'scheduled_health_failed',
        severity: 'error',
        retention: 'ordinary',
        summary: '定时健康检测失败',
      });
      return true;
    } catch (error) {
      this.logger.warn('health:scheduler', 'failure event append failed', {
        error,
      });
      // 调度失败事件不能阻止释放全局槽和后续轮次。
      return false;
    }
  }
}
