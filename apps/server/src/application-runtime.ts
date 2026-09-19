import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from './composition/tokens.js';
import { createApp } from './app.js';
import { recoverRuntimeState } from './services/startup-recovery.js';
import type { AutoSwitchService } from './services/auto-switch/auto-switch-service.js';
import type { HealthScheduler } from './services/health/health-scheduler.js';
import type { UndiciSiteProbe } from './services/health/site-probe.js';
import type { StatusNotificationCenter } from './services/status-notifier.js';
import type { TaskEngine } from './services/tasks/task-engine.js';
import type { SqliteStore } from './storage/store.js';
import type { AppLogger } from './logging.js';
import type { LegacyAdapter } from './legacy/adapter.js';

/** 生产应用唯一根：编排启动恢复、HTTP 监听、调度器和优雅关闭。 */
@injectable()
export class ApplicationRuntime {
  private server: Server | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(
    @inject(TOKENS.sqliteStore) private readonly store: SqliteStore,
    @inject(TOKENS.autoSwitchService)
    private readonly autoSwitch: AutoSwitchService,
    @inject(TOKENS.taskEngine) private readonly taskEngine: TaskEngine,
    @inject(TOKENS.healthScheduler)
    private readonly scheduler: HealthScheduler,
    @inject(TOKENS.statusNotificationCenter)
    private readonly notifier: StatusNotificationCenter,
    @inject(TOKENS.siteProbe) private readonly siteProbe: UndiciSiteProbe,
    @inject(TOKENS.appLogger) private readonly loggerValue: AppLogger,
    @inject(TOKENS.processEnv)
    private readonly environment: NodeJS.ProcessEnv,
    @inject(TOKENS.httpListen)
    private readonly listen: { port: number; host: string },
    @inject(TOKENS.legacyAdapter)
    private readonly legacy: LegacyAdapter,
  ) {}

  /** 入口和外部编排使用的统一日志器。 */
  get logger(): AppLogger {
    return this.loggerValue;
  }

  /**
   * 按既定顺序执行启动恢复、创建应用、监听本地端口并启动调度器。
   *
   * @returns 已开始监听的 HTTP 服务；入口据此挂接服务器错误处理。
   * @throws 启动恢复或监听失败时抛出；已创建资源由 stop() 统一释放。
   */
  async start(): Promise<Server> {
    const recoveredTasks = recoverRuntimeState({
      store: this.store,
      autoSwitch: this.autoSwitch,
    });
    this.loggerValue.info('storage:sqlite', 'runtime state recovered', {
      recoveredTasks,
    });

    // 状态命令只读；本机 Clash 暂不可用时仍提供 Web 页面和诊断入口。
    try {
      const status = await this.legacy.getStatus();
      if (!status.controllerAvailable)
        this.loggerValue.warn(
          'app:bootstrap',
          'Mihomo control interface unavailable; starting in degraded mode',
        );
    } catch {
      this.loggerValue.warn(
        'app:bootstrap',
        'Clash configuration unavailable; starting in degraded mode',
      );
    }

    const app = createApp({
      store: this.store,
      taskEngine: this.taskEngine,
      scheduler: this.scheduler,
      notifier: this.notifier,
      logger: this.loggerValue,
      staticRoot: fileURLToPath(new URL('../../web/dist/', import.meta.url)),
    });
    const server = await new Promise<Server>((resolvePromise, reject) => {
      const listening = app.listen(this.listen.port, this.listen.host, () => {
        resolvePromise(listening);
      });
      listening.once('error', reject);
    });
    this.server = server;
    const address = server.address();
    const port =
      typeof address === 'object' && address ? address.port : this.listen.port;
    this.loggerValue.info('app:bootstrap', 'Clash Sentinel started', {
      url: `http://${this.listen.host}:${port}`,
    });
    if (this.environment.NODE_ENV !== 'test') this.scheduler.start();
    return server;
  }

  /** 幂等停止：保留既定关闭顺序，不遗留数据库、HTTP、SSE 或探测句柄。 */
  stop(): Promise<void> {
    this.stopPromise ??= this.stopResources();
    return this.stopPromise;
  }

  /** 执行一次完整停机；单项失败不阻止后续资源释放。 */
  private async stopResources(): Promise<void> {
    const errors: unknown[] = [];
    const capture = (operation: () => void): void => {
      try {
        operation();
      } catch (error) {
        errors.push(error);
      }
    };

    capture(() => this.taskEngine.stopAccepting());

    let schedulerStopped = Promise.resolve();
    try {
      schedulerStopped = this.scheduler.stop();
    } catch (error) {
      errors.push(error);
    }
    capture(() => this.notifier.close());

    const currentServer = this.server;
    const serverClosed = new Promise<void>((resolvePromise) => {
      if (!currentServer?.listening) {
        resolvePromise();
        return;
      }
      currentServer.close(() => resolvePromise());
      currentServer.closeIdleConnections();
    });
    let taskIdle = Promise.resolve();
    try {
      taskIdle = this.taskEngine.waitForIdle();
    } catch (error) {
      errors.push(error);
    }
    const concurrentResults = await Promise.allSettled([
      serverClosed,
      schedulerStopped,
      taskIdle,
    ]);
    for (const result of concurrentResults) {
      if (result.status === 'rejected') errors.push(result.reason);
    }

    try {
      await this.siteProbe.close();
    } catch (error) {
      errors.push(error);
    }
    capture(() => this.store.close());

    if (errors.length > 0)
      throw new AggregateError(errors, 'application shutdown failed');
  }
}
