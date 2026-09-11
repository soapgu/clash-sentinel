import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createAppLogger } from './logging.js';
import { loadServerConfig } from './config.js';
import {
  createRuntimeDependencies,
  type RuntimeDependencies,
} from './runtime.js';

let logger = createAppLogger({ redactSensitiveData: true });
let runtime: RuntimeDependencies | null = null;
let server: Server | null = null;
let shuttingDown = false;

/** 停止接收请求，等待当前动作并安全关闭全部运行时资源。 */
async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  const startedAt = Date.now();
  logger.info('app:bootstrap', 'Clash Sentinel stopping', { exitCode });
  try {
    const currentRuntime = runtime;
    const currentServer = server;
    if (currentRuntime) {
      currentRuntime.taskService.stopAccepting();
      const schedulerStopped = currentRuntime.scheduler.stop();
      currentRuntime.notifier.close();
      const serverClosed = new Promise<void>((resolvePromise) => {
        if (!currentServer?.listening) {
          resolvePromise();
          return;
        }
        currentServer.close(() => resolvePromise());
        currentServer.closeIdleConnections();
      });
      await Promise.all([
        serverClosed,
        schedulerStopped,
        currentRuntime.taskService.waitForIdle(),
      ]);
      await currentRuntime.siteProbe.close();
      currentRuntime.store.close();
    }
    logger.info('app:bootstrap', 'Clash Sentinel stopped', {
      durationMs: Date.now() - startedAt,
      exitCode,
    });
  } catch (error) {
    exitCode = 1;
    logger.error('app:bootstrap', 'shutdown failed', { error });
  } finally {
    await logger.close();
    process.exitCode = exitCode;
  }
}

process.once('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logger.error('app:bootstrap', 'unhandled rejection', { error });
  void shutdown(1);
});
process.once('uncaughtException', (error) => {
  logger.error('app:bootstrap', 'uncaught exception', { error });
  void shutdown(1);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info('app:bootstrap', 'shutdown signal received', { signal });
    void shutdown();
  });
}

/** 验证运行环境、创建依赖并开始监听。 */
async function bootstrap() {
  if (Number(process.versions.node.split('.')[0]) !== 24) {
    logger.error('app:bootstrap', 'Node.js 24 LTS required', {
      actualVersion: process.versions.node,
    });
    await shutdown(1);
    return;
  }
  let config;
  try {
    config = loadServerConfig();
  } catch (error) {
    logger.error('app:bootstrap', 'configuration load failed', { error });
    await shutdown(1);
    return;
  }
  try {
    const configuredLogger = createAppLogger({
      redactSensitiveData: config.logging.redactSensitiveData,
    });
    await logger.close();
    logger = configuredLogger;
    runtime = createRuntimeDependencies(process.env, undefined, config, logger);
    const app = createApp({
      ...runtime,
      staticRoot: fileURLToPath(new URL('../../web/dist/', import.meta.url)),
    });
    server = app.listen(3000, '127.0.0.1', () => {
      logger.info('app:bootstrap', 'Clash Sentinel started', {
        url: 'http://127.0.0.1:3000',
      });
      if (process.env.NODE_ENV !== 'test') runtime?.scheduler.start();
    });
    server.on('error', (error: NodeJS.ErrnoException) => {
      logger.error('app:bootstrap', 'server start failed', {
        errorCode: error.code ?? 'INTERNAL_ERROR',
        error,
      });
      void shutdown(1);
    });
  } catch (error) {
    logger.error('app:bootstrap', 'bootstrap failed', { error });
    await shutdown(1);
  }
}

await bootstrap();
