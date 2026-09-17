import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import type { DependencyContainer } from 'tsyringe';
import type { ServerConfig } from '../src/config.js';
import { noopLogger, type AppLogger } from '../src/logging.js';
import { createAppContainer } from '../src/composition/container.js';
import { TOKENS } from '../src/composition/tokens.js';
import type { SqliteStore } from '../src/storage/store.js';

/** 容器测试统一使用的脱敏配置。 */
export const TEST_CONFIG: ServerConfig = {
  logging: { redactSensitiveData: true },
  storage: { redactSensitiveData: true },
};

/** 当前测试创建且需要关闭并删除的隔离容器。 */
const cleanups: Array<{
  child: DependencyContainer;
  root: string;
  store: SqliteStore;
}> = [];

afterEach(async () => {
  const errors: unknown[] = [];
  for (const item of cleanups.splice(0)) {
    try {
      await item.child.dispose();
    } catch (error) {
      errors.push(error);
    }
    try {
      item.store.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      await rm(item.root, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0)
    throw new AggregateError(errors, 'test container cleanup failed');
});

/**
 * 创建指向临时目录的容器环境变量，不触碰真实状态、报告和配置。
 *
 * @param prefix 临时目录前缀，用于区分测试来源。
 * @param nodeEnv 可选 NODE_ENV 值；生命周期测试传 'test' 以跳过调度器。
 */
export async function createContainerEnvironment(
  prefix: string,
  nodeEnv?: string,
) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const environment: NodeJS.ProcessEnv = {
    CLASH_SENTINEL_DB_PATH: join(root, 'container.db'),
    CLASH_SENTINEL_LEGACY_SCRIPT_PATH: join(root, 'legacy.sh'),
    CLASH_APP_DIR: join(root, 'clash'),
    CLASH_ENTRY_STATE_DIR: join(root, 'state'),
    CLASH_ENTRY_REPORT_DIR: join(root, 'reports'),
    CLASH_ENTRY_BACKUP_DIR: join(root, 'backups'),
    CLASH_RUNTIME_CONFIG: join(root, 'runtime.yaml'),
  };
  if (nodeEnv) environment.NODE_ENV = nodeEnv;
  return { root, environment };
}

/**
 * 创建完整依赖图的隔离测试容器并注册自动清理。
 *
 * @param options.prefix 临时目录前缀。
 * @param options.nodeEnv 可选 NODE_ENV 值。
 * @param options.logger 测试日志器，默认空实现。
 * @returns 已解析 Store 的 child container 及其临时目录和环境。
 */
export async function createIsolatedContainer(
  options: { prefix: string; nodeEnv?: string; logger?: AppLogger } = {
    prefix: 'clash-container-',
  },
) {
  const { root, environment } = await createContainerEnvironment(
    options.prefix,
    options.nodeEnv,
  );
  const child: DependencyContainer = createAppContainer({
    environment,
    config: TEST_CONFIG,
    logger: options.logger ?? noopLogger,
  });
  const store = child.resolve<SqliteStore>(TOKENS.sqliteStore);
  cleanups.push({ child, root, store });
  return { child, store, root, environment };
}
