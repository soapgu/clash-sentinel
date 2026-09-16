import 'reflect-metadata';
import type { Server } from 'node:http';
import type { DependencyContainer } from 'tsyringe';
import { createAppContainer } from './composition/container.js';
import { ApplicationRuntime } from './application-runtime.js';
import { createAppLogger, type AppLogger } from './logging.js';

let logger: AppLogger = createAppLogger({ redactSensitiveData: true });
let runtime: ApplicationRuntime | null = null;
let child: DependencyContainer | null = null;
let shuttingDown = false;

/** 停止接收请求，等待当前动作并安全关闭全部运行时资源。 */
async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  const startedAt = Date.now();
  logger.info('app:bootstrap', 'Clash Sentinel stopping', { exitCode });
  try {
    await runtime?.stop();
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
    await child?.dispose();
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
  process.on(signal, () => {
    if (shuttingDown) {
      logger.warn('app:bootstrap', 'forced shutdown signal received', {
        signal,
      });
      process.exit(signal === 'SIGINT' ? 130 : 143);
    }
    logger.info('app:bootstrap', 'shutdown signal received', { signal });
    void shutdown();
  });
}

/** 验证运行环境、组装容器并启动唯一应用根。 */
async function bootstrap() {
  if (Number(process.versions.node.split('.')[0]) !== 24) {
    logger.error('app:bootstrap', 'Node.js 24 LTS required', {
      actualVersion: process.versions.node,
    });
    await shutdown(1);
    return;
  }
  let container: DependencyContainer;
  try {
    container = createAppContainer();
  } catch (error) {
    logger.error('app:bootstrap', 'configuration load failed', { error });
    await shutdown(1);
    return;
  }
  child = container;
  try {
    runtime = container.resolve(ApplicationRuntime);
    logger = runtime.logger;
    const server: Server = await runtime.start();
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
