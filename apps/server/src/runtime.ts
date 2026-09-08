import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { LegacyAdapter } from './legacy/adapter.js';
import { TaskService } from './services/task-service.js';
import { SqliteStore } from './storage/store.js';

/** 生产 Koa 应用和退出流程共同持有的运行时依赖。 */
export interface RuntimeDependencies {
  /** SQLite 数据访问门面。 */
  store: SqliteStore;
  /** 串行异步任务服务。 */
  taskService: TaskService;
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
  return { store, taskService: new TaskService({ store, adapter }) };
}
