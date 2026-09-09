import type { SqliteStore } from '../../storage/store.js';
import type { OperationCoordinator } from '../operation-coordinator.js';
import type { HealthCheckService } from './health-check.js';

/** 定时健康检测调度器依赖。 */
export interface HealthSchedulerOptions {
  /** 动态读取监测开关和周期的 SQLite 门面。 */
  store: SqliteStore;
  /** 与全部手动 Legacy 动作共享的全局执行槽。 */
  coordinator: OperationCoordinator;
  /** 执行完整六站检测的编排器。 */
  healthCheck: Pick<HealthCheckService, 'run'>;
}

/** 启动即检查、按最新设置递归调度且不会重入的健康调度器。 */
export class HealthScheduler {
  private timer: NodeJS.Timeout | null = null;
  private currentRun: Promise<void> | null = null;
  private stopped = true;

  /** @param options 存储、全局协调器和健康编排器。 */
  constructor(private readonly options: HealthSchedulerOptions) {}

  /** 启动调度器并立即尝试第一轮检测。 */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.runTick();
  }

  /** 停止后续定时器并等待已经开始的检测完成。 */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.currentRun;
  }

  /** 尝试占用定时槽；冲突时静默跳过并安排下一周期。 */
  private runTick(): void {
    if (this.stopped) return;
    const settings = this.options.store.getSettings();
    if (!settings.monitoringEnabled) {
      this.schedule(settings.checkIntervalMs);
      return;
    }
    const lease = this.options.coordinator.tryAcquireScheduled();
    if (!lease) {
      this.schedule(settings.checkIntervalMs);
      return;
    }
    this.currentRun = this.options.healthCheck
      .run('scheduled')
      .then(() => undefined)
      .catch(() => {
        this.appendFailureEvent();
      })
      .finally(() => {
        lease.release();
        this.currentRun = null;
        if (!this.stopped)
          this.schedule(this.options.store.getSettings().checkIntervalMs);
      });
  }

  /** 安排下一次不早于当前轮完成后的检测。 */
  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.runTick();
    }, delayMs);
    this.timer.unref();
  }

  /** 记录不包含原始异常、路径或响应正文的定时轮次失败。 */
  private appendFailureEvent(): void {
    try {
      this.options.store.appendEvent({
        type: 'scheduled_health_failed',
        severity: 'error',
        retention: 'ordinary',
        summary: '定时健康检测失败',
      });
    } catch {
      // 调度失败事件不能阻止释放全局槽和后续轮次。
    }
  }
}
