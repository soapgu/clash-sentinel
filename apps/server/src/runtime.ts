import { LegacyAdapter } from './legacy/adapter.js';
import { DEFAULT_PROJECT_ROOT, resolveRuntimePaths } from './project-paths.js';
import { ClashProxyConfig } from './services/health/proxy-config.js';
import { HealthCheckService } from './services/health/health-check.js';
import { HealthScheduler } from './services/health/health-scheduler.js';
import { UndiciSiteProbe } from './services/health/site-probe.js';
import { OperationCoordinator } from './services/operation-coordinator.js';
import { StatusNotificationCenter } from './services/status-notifier.js';
import { TaskService } from './services/task-service.js';
import { SqliteStore } from './storage/store.js';
import { createAppLogger, type AppLogger } from './logging.js';
import { loadServerConfig, type ServerConfig } from './config.js';

/** 生产 Koa 应用和退出流程共同持有的运行时依赖。 */
export interface RuntimeDependencies {
  /** SQLite 数据访问门面。 */
  store: SqliteStore;
  /** 串行异步任务服务。 */
  taskService: TaskService;
  /** 启动即运行且可安全停止的健康调度器。 */
  scheduler: HealthScheduler;
  /** 当前进程内的 SSE 通知和连接生命周期中心。 */
  notifier: StatusNotificationCenter;
  /** 关闭时需要释放连接池的 HTTP 探测器。 */
  siteProbe: UndiciSiteProbe;
  /** 服务端全部模块共享的自然文本日志器。 */
  logger: AppLogger;
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
  const coordinator = new OperationCoordinator();
  const notifier = new StatusNotificationCenter(() => new Date(), logger);
  const siteProbe = new UndiciSiteProbe();
  const healthCheck = new HealthCheckService({
    store,
    siteProbe,
    proxyConfig: new ClashProxyConfig(paths.runtimeConfigPath),
    legacy: adapter,
    logger,
  });
  const taskService = new TaskService({
    store,
    adapter,
    healthCheck,
    coordinator,
    notifier,
    logger,
  });
  return {
    store,
    taskService,
    scheduler: new HealthScheduler({
      store,
      coordinator,
      healthCheck,
      notifier,
      logger,
    }),
    notifier,
    siteProbe,
    logger,
  };
}
