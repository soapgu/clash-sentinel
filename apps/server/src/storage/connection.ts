import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { noopLogger, type AppLogger } from '../logging.js';
import { DEFAULT_PROJECT_ROOT } from '../project-paths.js';
import { runMigrations } from './migrations.js';

/** SQLite 存储初始化选项。 */
export interface SqliteStoreOptions {
  databasePath?: string;
  projectRoot?: string;
  logger?: AppLogger;
  redactSensitiveData?: boolean;
}

/** 解析稳定且不依赖进程 cwd 的 SQLite 文件路径。 */
export function resolveDatabasePath(
  options: SqliteStoreOptions = {},
  environment: NodeJS.ProcessEnv = process.env,
) {
  const configured =
    options.databasePath ??
    environment.CLASH_SENTINEL_DB_PATH ??
    '.state/clash-sentinel.db';
  if (configured === ':memory:') return configured;
  return resolve(options.projectRoot ?? DEFAULT_PROJECT_ROOT, configured);
}

/** 管理单个 SQLite 连接的生命周期、迁移和事务。 */
export class SqliteConnection {
  readonly database: Database.Database;
  private readonly logger: AppLogger;

  constructor(options: SqliteStoreOptions = {}) {
    this.logger = options.logger ?? noopLogger;
    const path = resolveDatabasePath(options);
    let database: Database.Database | undefined;
    try {
      if (path !== ':memory:')
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      database = new Database(path);
      database.pragma('foreign_keys = ON');
      database.pragma('journal_mode = WAL');
      database.pragma('busy_timeout = 5000');
      database.pragma('synchronous = NORMAL');
      runMigrations(database);
      this.database = database;
      this.logger.info('storage:sqlite', 'database opened', {
        inMemory: path === ':memory:',
      });
    } catch (error) {
      database?.close();
      this.logger.error('storage:sqlite', 'database initialization failed', {
        error,
      });
      throw error;
    }
  }

  transaction<T>(callback: () => T): T {
    return this.database.transaction(callback)();
  }

  close() {
    this.database.close();
    this.logger.info('storage:sqlite', 'database closed');
  }
}
