import { createServer, type Server as NetServer } from 'node:net';
import { rm } from 'node:fs/promises';
import { expect, test, vi } from 'vitest';
import { createIsolatedContainer } from '../test-support/container.js';
import { ApplicationRuntime } from './application-runtime.js';
import { TOKENS } from './composition/tokens.js';
import { noopLogger } from './logging.js';
import type { LegacyAdapter } from './legacy/adapter.js';
import type { LegacyStatus } from '@clash-sentinel/shared';
import type { SqliteStore } from './storage/store.js';
import type { HealthScheduler } from './services/health/health-scheduler.js';
import type { UndiciSiteProbe } from './services/health/site-probe.js';

test('完整生命周期：启动恢复、监听、请求、关闭且二次停止幂等', async () => {
  const { child, store } = await createIsolatedContainer({
    prefix: 'clash-runtime-',
    nodeEnv: 'test',
  });
  child.register(TOKENS.httpListen, {
    useValue: { port: 0, host: '127.0.0.1' },
  });

  const runtime = child.resolve(ApplicationRuntime);
  const server = await runtime.start();
  expect(server.listening).toBe(true);
  const address = server.address();
  expect(typeof address === 'object' && address && address.port).toBeTruthy();

  // NODE_ENV=test 时不启动调度器，状态保持 waiting 且没有定时器副作用。
  expect(runtime['scheduler'].getSnapshot().state).toBe('waiting');

  const port = typeof address === 'object' && address ? address.port : 0;
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
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

test.each([
  {
    unavailable: 'controller',
    warning: 'Mihomo control interface unavailable',
  },
  { unavailable: 'config', warning: 'Clash configuration unavailable' },
])(
  '启动检查遇到 $unavailable 不可用时降级提供页面',
  async ({ unavailable, warning }) => {
    const logger = { ...noopLogger, warn: vi.fn() };
    const { child } = await createIsolatedContainer({
      prefix: 'clash-runtime-degraded-',
      logger,
      nodeEnv: 'test',
    });
    child.register(TOKENS.httpListen, {
      useValue: { port: 0, host: '127.0.0.1' },
    });
    const legacy = child.resolve<LegacyAdapter>(TOKENS.legacyAdapter);
    if (unavailable === 'config')
      vi.spyOn(legacy, 'getStatus').mockRejectedValue(new Error('missing'));
    else
      vi.spyOn(legacy, 'getStatus').mockResolvedValue({
        controllerAvailable: false,
      } as LegacyStatus);

    const runtime = child.resolve(ApplicationRuntime);
    const server = await runtime.start();
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    expect((await fetch(`http://127.0.0.1:${port}/api/health`)).status).toBe(
      200,
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'app:bootstrap',
      expect.stringContaining(warning),
    );
    await runtime.stop();
  },
);

test('启动恢复失败时释放已构造的数据库和探测器句柄', async () => {
  const { child, root, environment } = await createIsolatedContainer({
    prefix: 'clash-runtime-fail-',
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
  expect(environment).toBeDefined();
});

test('停机步骤失败时继续释放后续资源且重复调用复用失败结果', async () => {
  const { child, store } = await createIsolatedContainer({
    prefix: 'clash-runtime-stop-fail-',
    nodeEnv: 'test',
  });
  const scheduler = child.resolve<HealthScheduler>(TOKENS.healthScheduler);
  const siteProbe = child.resolve<UndiciSiteProbe>(TOKENS.siteProbe);
  const schedulerError = new Error('调度器停止失败');
  const probeError = new Error('探测器关闭失败');
  const schedulerStop = vi
    .spyOn(scheduler, 'stop')
    .mockRejectedValue(schedulerError);
  const probeClose = vi.spyOn(siteProbe, 'close').mockRejectedValue(probeError);
  const storeClose = vi.spyOn(store, 'close');

  const runtime = child.resolve(ApplicationRuntime);
  const firstStop = runtime.stop();
  const secondStop = runtime.stop();
  expect(secondStop).toBe(firstStop);
  await expect(firstStop).rejects.toMatchObject({
    errors: [schedulerError, probeError],
  });
  expect(schedulerStop).toHaveBeenCalledTimes(1);
  expect(probeClose).toHaveBeenCalledTimes(1);
  expect(storeClose).toHaveBeenCalledTimes(1);

  await expect(runtime.stop()).rejects.toBeInstanceOf(AggregateError);
  expect(schedulerStop).toHaveBeenCalledTimes(1);
  expect(probeClose).toHaveBeenCalledTimes(1);
  expect(storeClose).toHaveBeenCalledTimes(1);
});

test('端口被占用时监听失败并释放已构造句柄', async () => {
  // 先占用一个真实端口，制造 EADDRINUSE。
  const blocker: NetServer = createServer();
  const blockerPort = await new Promise<number>((resolvePromise) => {
    blocker.listen(0, '127.0.0.1', () => {
      const address = blocker.address();
      resolvePromise(typeof address === 'object' && address ? address.port : 0);
    });
  });

  const { child, store, root } = await createIsolatedContainer({
    prefix: 'clash-runtime-port-',
    nodeEnv: 'test',
  });
  child.register(TOKENS.httpListen, {
    useValue: { port: blockerPort, host: '127.0.0.1' },
  });

  const runtime = child.resolve(ApplicationRuntime);
  await expect(runtime.start()).rejects.toThrow(/EADDRINUSE|listen EADDRINUSE/);
  // 监听失败不创建 HTTP 服务，stop 仍释放数据库句柄。
  await runtime.stop();
  expect(() => store.settings.getSettings()).toThrow();
  await rm(root, { recursive: true, force: true });

  await new Promise<void>((resolvePromise) => {
    blocker.close(() => resolvePromise());
  });
});
