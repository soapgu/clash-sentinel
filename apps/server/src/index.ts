import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createRuntimeDependencies } from './runtime.js';
if (Number(process.versions.node.split('.')[0]) !== 24) {
  console.error('请使用 Node.js 24 LTS');
  process.exit(1);
}
const runtime = createRuntimeDependencies();
const app = createApp({
  ...runtime,
  staticRoot: fileURLToPath(new URL('../../web/dist/', import.meta.url)),
});
const server = app.listen(3000, '127.0.0.1', () => {
  console.log('Clash Sentinel: http://127.0.0.1:3000');
  if (process.env.NODE_ENV !== 'test') runtime.scheduler.start();
});
let shuttingDown = false;

/** 停止接收请求，等待当前 Legacy 动作并安全关闭 SQLite。 */
async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  const schedulerStopped = runtime.scheduler.stop();
  runtime.taskService.stopAccepting();
  const serverClosed = new Promise<void>((resolvePromise) => {
    if (!server.listening) {
      resolvePromise();
      return;
    }
    server.close(() => resolvePromise());
    server.closeIdleConnections();
  });
  await Promise.all([
    serverClosed,
    schedulerStopped,
    runtime.taskService.waitForIdle(),
  ]);
  await runtime.siteProbe.close();
  runtime.store.close();
  process.exitCode = exitCode;
}

server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(
    error.code === 'EADDRINUSE'
      ? '端口 3000 已被占用，请停止占用进程后重试。'
      : '后台启动失败。',
  );
  void shutdown(1);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown();
  });
}
