import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { LegacyAdapter } from './legacy/adapter.js';
import { ClashProxyConfig } from './services/health/proxy-config.js';
import { HealthCheckService } from './services/health/health-check.js';
import { HealthScheduler } from './services/health/health-scheduler.js';
import { UndiciSiteProbe } from './services/health/site-probe.js';
import { OperationCoordinator } from './services/operation-coordinator.js';
import { TaskService } from './services/task-service.js';
import { SqliteStore } from './storage/store.js';

/** 生产 Koa 应用和退出流程共同持有的运行时依赖。 */
export interface RuntimeDependencies {
  /** SQLite 数据访问门面。 */
  store: SqliteStore;
  /** 串行异步任务服务。 */
  taskService: TaskService;
  /** 启动即运行且可安全停止的健康调度器。 */
  scheduler: HealthScheduler;
  /** 关闭时需要释放连接池的 HTTP 探测器。 */
  siteProbe: UndiciSiteProbe;
}

/**
 * 根据安全默认值和环境变量创建生产存储与 Legacy 任务服务。
 *
 * @param environment 运行环境变量，测试可注入独立配置。
 * @param cwd 项目工作目录。
 * @returns 可注式关闭的生产运行时依赖。
 */
export function createRuntimeDependencies(
  environment: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): RuntimeDependencies {
  const appDir =
    environment.CLASH_APP_DIR ||
    resolve(
      homedir(),
      'Library/Application Support/io.github.clash-verge-rev.clash-verge-rev',
    );
  const store = new SqliteStore({
    databasePath:
      environment.CLASH_SENTINEL_DB_PATH ||
      resolve(cwd, '.state/clash-sentinel.db'),
  });
  const adapter = new LegacyAdapter({
    scriptPath:
      environment.CLASH_SENTINEL_LEGACY_SCRIPT_PATH ||
      resolve(cwd, 'scripts/legacy/clash-entry-ip.sh'),
    appDir,
    stateDir:
      environment.CLASH_ENTRY_STATE_DIR || resolve(cwd, '.state/legacy'),
    reportDir:
      environment.CLASH_ENTRY_REPORT_DIR || resolve(cwd, 'reports/legacy'),
    backupDir:
      environment.CLASH_ENTRY_BACKUP_DIR || resolve(appDir, 'entry-ip-backups'),
    logDir:
      environment.CLASH_SENTINEL_LEGACY_LOG_DIR || resolve(cwd, 'logs/legacy'),
    environment,
  });
  const coordinator = new OperationCoordinator();
  const siteProbe = new UndiciSiteProbe();
  const runtimeConfigPath =
    environment.CLASH_RUNTIME_CONFIG || resolve(appDir, 'clash-verge.yaml');
  const healthCheck = new HealthCheckService({
    store,
    siteProbe,
    proxyConfig: new ClashProxyConfig(runtimeConfigPath),
    legacy: adapter,
  });
  const taskService = new TaskService({
    store,
    adapter,
    healthCheck,
    coordinator,
  });
  return {
    store,
    taskService,
    scheduler: new HealthScheduler({ store, coordinator, healthCheck }),
    siteProbe,
  };
}
