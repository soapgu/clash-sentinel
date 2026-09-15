import { LegacyAdapter } from './legacy/adapter.js';
import { DEFAULT_PROJECT_ROOT, resolveRuntimePaths } from './project-paths.js';
import { ClashProxyConfig } from './services/health/proxy-config.js';
import { HealthCheckService } from './services/health/health-check.js';
import { HealthScheduler } from './services/health/health-scheduler.js';
import { UndiciSiteProbe } from './services/health/site-probe.js';
import { StatusNotificationCenter } from './services/status-notifier.js';
import { TaskEngine } from './services/tasks/task-engine.js';
import { AutoSwitchTaskHandler } from './services/tasks/handlers/auto-switch-task-handler.js';
import { ApplyTaskHandler } from './services/tasks/handlers/apply-task-handler.js';
import { DiagnoseTaskHandler } from './services/tasks/handlers/diagnose-task-handler.js';
import { HealthCheckTaskHandler } from './services/tasks/handlers/health-check-task-handler.js';
import { ResetTaskHandler } from './services/tasks/handlers/reset-task-handler.js';
import { RollbackTaskHandler } from './services/tasks/handlers/rollback-task-handler.js';
import type { TaskHandlerRegistry } from './services/tasks/contracts.js';
import { SqliteStore } from './storage/store.js';
import { createAppLogger, type AppLogger } from './logging.js';
import { loadServerConfig, type ServerConfig } from './config.js';
import { AutoSwitchService } from './services/auto-switch/auto-switch-service.js';
import { recoverRuntimeState } from './services/startup-recovery.js';

/** 生产 Koa 应用和退出流程共同持有的运行时依赖。 */
export interface RuntimeDependencies {
  /** SQLite 数据访问门面。 */
  store: SqliteStore;
  /** 统一执行手动和自动任务生命周期的任务引擎。 */
  taskEngine: TaskEngine;
  /** 启动即运行且可安全停止的健康调度器。 */
  scheduler: HealthScheduler;
  /** 当前进程内的 SSE 通知和连接生命周期中心。 */
  notifier: StatusNotificationCenter;
  /** 关闭时需要释放连接池的 HTTP 探测器。 */
  siteProbe: UndiciSiteProbe;
  /** 服务端全部模块共享的自然文本日志器。 */
  logger: AppLogger;
}

/** 由六个领域 Handler 组成且覆盖全部任务类型的不可变注册表。 */
function createHandlers(
  store: SqliteStore,
  adapter: LegacyAdapter,
  healthCheck: HealthCheckService,
  autoSwitch: AutoSwitchService,
): TaskHandlerRegistry {
  return {
    health_check: new HealthCheckTaskHandler(healthCheck),
    diagnose: new DiagnoseTaskHandler(store.diagnoses, adapter),
    apply: new ApplyTaskHandler(store.health, adapter),
    reset: new ResetTaskHandler(store.health, store.settings, adapter),
    rollback: new RollbackTaskHandler(store.health, adapter),
    auto_switch: new AutoSwitchTaskHandler(autoSwitch),
  } satisfies TaskHandlerRegistry;
}

/**
 * 根据安全默认值和环境变量创建生产存储与 Legacy 任务服务。
 *
 * @param environment 运行环境变量，测试可注入独立配置。
 * @param projectRoot 项目根目录，默认由当前模块位置推导而非进程 cwd。
 * @returns 可注式关闭的生产运行时依赖。
 */
export function createRuntimeDependencies(
  environment: NodeJS.ProcessEnv = process.env,
  projectRoot = DEFAULT_PROJECT_ROOT,
  config: ServerConfig = loadServerConfig(environment, projectRoot),
  logger: AppLogger = createAppLogger({
    environment,
    redactSensitiveData: config.logging.redactSensitiveData,
  }),
): RuntimeDependencies {
  const paths = resolveRuntimePaths(environment, projectRoot);
  const store = new SqliteStore({
    databasePath: paths.databasePath,
    logger,
    redactSensitiveData: config.storage.redactSensitiveData,
  });
  const adapter = new LegacyAdapter({
    scriptPath: paths.legacyScriptPath,
    appDir: paths.appDir,
    stateDir: paths.legacyStateDir,
    reportDir: paths.legacyReportDir,
    backupDir: paths.legacyBackupDir,
    environment,
    logger,
  });
  const autoSwitch = new AutoSwitchService(
    store.settings,
    store.health,
    store.diagnoses,
    adapter,
    undefined,
    logger,
  );
  let recoveredTasks: number;
  try {
    recoveredTasks = recoverRuntimeState({ store, autoSwitch });
  } catch (error) {
    store.close();
    throw error;
  }
  logger.info('storage:sqlite', 'runtime state recovered', { recoveredTasks });
  const notifier = new StatusNotificationCenter(() => new Date(), logger);
  const siteProbe = new UndiciSiteProbe();
  const healthCheck = new HealthCheckService(
    store.settings,
    store.health,
    store.sites,
    store.diagnoses,
    store.events,
    siteProbe,
    new ClashProxyConfig(paths.runtimeConfigPath),
    adapter,
    undefined,
    logger,
  );
  const taskEngine = new TaskEngine(
    store.tasks,
    store.events,
    notifier,
    createHandlers(store, adapter, healthCheck, autoSwitch),
    logger,
  );
  return {
    store,
    taskEngine,
    scheduler: new HealthScheduler(
      store.settings,
      store.events,
      notifier,
      taskEngine,
      undefined,
      logger,
    ),
    notifier,
    siteProbe,
    logger,
  };
}
