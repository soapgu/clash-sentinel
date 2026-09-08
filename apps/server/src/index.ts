import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
if (Number(process.versions.node.split('.')[0]) !== 24) {
  console.error('请使用 Node.js 24 LTS');
  process.exit(1);
}
const app = createApp(
  fileURLToPath(new URL('../../web/dist/', import.meta.url)),
);
const server = app.listen(3000, '127.0.0.1', () =>
  console.log('Clash Sentinel: http://127.0.0.1:3000'),
);
server.on('error', (error: NodeJS.ErrnoException) => {
  console.error(
    error.code === 'EADDRINUSE'
      ? '端口 3000 已被占用，请停止占用进程后重试。'
      : '后台启动失败。',
  );
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
  });
}
