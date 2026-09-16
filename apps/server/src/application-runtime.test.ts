import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { ServerConfig } from './config.js';
import { noopLogger } from './logging.js';
import { createAppContainer } from './composition/container.js';
import { ApplicationRuntime } from './application-runtime.js';
import { TOKENS } from './composition/tokens.js';
import type { SqliteStore } from './storage/store.js';
import type { UndiciSiteProbe } from './services/health/site-probe.js';

const cleanups: Array<{ root: string; store: SqliteStore }> = [];

afterEach(async () => {
  for (const item of cleanups.splice(0)) {
    item.store.close();
    await rm(item.root, { recursive: true, force: true });
  }
});

/** 创建指向临时目录的环境变量，不触碰真实状态、报告和配置。 */
async function createTestEnvironment() {
  const root = await mkdtemp(join(tmpdir(), 'clash-runtime-'));
  const environment = {
    NODE_ENV: 'test',
    CLASH_SENTINEL_DB_PATH: join(root, 'runtime.db'),
    CLASH_SENTINEL_LEGACY_SCRIPT_PATH: join(root, 'legacy.sh'),
    CLASH_APP_DIR: join(root, 'clash'),
    CLASH_ENTRY_STATE_DIR: join(root, 'state'),
    CLASH_ENTRY_REPORT_DIR: join(root, 'reports'),
    CLASH_ENTRY_BACKUP_DIR: join(root, 'backups'),
    CLASH_RUNTIME_CONFIG: join(root, 'runtime.yaml'),
  };
  return { root, environment };
}

const TEST_CONFIG: ServerConfig = {
  logging: { redactSensitiveData: true },
  storage: { redactSensitiveData: true },
};

test('完整生命周期：启动恢复、监听、请求、关闭且二次停止幂等', async () => {
  const { root, environment } = await createTestEnvironment();
  const child = createAppContainer({
    environment,
    config: TEST_CONFIG,
    logger: noopLogger,
  });
  child.register(TOKENS.httpListen, {
    useValue: { port: 0, host: '127.0.0.1' },
  });
  const store = child.resolve<SqliteStore>(TOKENS.sqliteStore);
  cleanups.push({ root, store });

  const runtime = child.resolve(ApplicationRuntime);
  const server = await runtime.start();
  expect(server.listening).toBe(true);
  const address = server.address();
  expect(typeof address === 'object' && address && address.port).toBeTruthy();

  // NODE_ENV=test 时不启动调度器，状态保持 waiting 且没有定时器副作用。
  expect(runtime['scheduler'].getSnapshot().state).toBe('waiting');

  const response = await fetch(
    `http://127.0.0.1:${address && typeof address === 'object' ? address.port : 0}/api/health`,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { ok: boolean };
  expect(body.ok).toBe(true);

  await runtime.stop();
  expect(server.listening).toBe(false);
  // 数据库已关闭：再次访问仓储抛出 SQLite 关闭错误。
  expect(() => store.settings.getSettings()).toThrow();
  // 二次停止保持幂等，不重复关闭或抛错。
  await expect(runtime.stop()).resolves.toBeUndefined();
});

test('启动恢复失败时释放已构造的数据库和探测器句柄', async () => {
  const { root, environment } = await createTestEnvironment();
  const child = createAppContainer({
    environment,
    config: TEST_CONFIG,
    logger: noopLogger,
  });
  const realStore = child.resolve<SqliteStore>(TOKENS.sqliteStore);
  const storeClosed = vi.fn();
  const brokenStore = {
    ...realStore,
    transaction: () => {
      throw new Error('恢复事务失败');
    },
    close: () => storeClosed(),
  } as unknown as SqliteStore;
  child.register(TOKENS.sqliteStore, { useValue: brokenStore });
  const probeClosed = vi.fn();
  child.register(TOKENS.siteProbe, {
    useValue: { close: probeClosed } as unknown as UndiciSiteProbe,
  });
  // 真实 Store 由测试代为关闭；fake 不再持有它。
  realStore.close();
  await rm(root, { recursive: true, force: true });

  const runtime = child.resolve(ApplicationRuntime);
  await expect(runtime.start()).rejects.toThrow('恢复事务失败');
  // 失败路径不创建 HTTP 服务，stop 仅需释放存储与探测器。
  await runtime.stop();
  expect(storeClosed).toHaveBeenCalledTimes(1);
  expect(probeClosed).toHaveBeenCalledTimes(1);
});
