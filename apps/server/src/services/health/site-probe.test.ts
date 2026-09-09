import { createServer, type Server } from 'node:http';
import { afterEach, expect, test } from 'vitest';
import { classifyProbeError, UndiciSiteProbe } from './site-probe.js';

const servers: Server[] = [];
const probes: UndiciSiteProbe[] = [];

afterEach(async () => {
  await Promise.all(probes.splice(0).map((probe) => probe.close()));
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

/** 启动仅供当前测试使用的回环 HTTP 服务。 */
async function serve(
  handler: Parameters<typeof createServer>[0],
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试端口无效');
  return `http://127.0.0.1:${String(address.port)}`;
}

test('记录成功响应总耗时并解析 OpenAI 非法正文为 unknown', async () => {
  const url = await serve((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{bad');
  });
  const probe = new UndiciSiteProbe();
  probes.push(probe);
  await expect(
    probe.probe({
      target: 'openai_status',
      url,
      timeoutMs: 1_000,
      proxyUrl: null,
    }),
  ).resolves.toMatchObject({
    reachable: true,
    httpStatus: 200,
    errorType: null,
    serviceStatus: 'unknown',
  });
});

test('将 HTTP 失败和请求超时转换为稳定失败结果', async () => {
  const failureUrl = await serve((_request, response) => {
    response.writeHead(503);
    response.end('unavailable');
  });
  const probe = new UndiciSiteProbe();
  probes.push(probe);
  await expect(
    probe.probe({
      target: 'github',
      url: failureUrl,
      timeoutMs: 1_000,
      proxyUrl: null,
    }),
  ).resolves.toMatchObject({
    reachable: false,
    httpStatus: null,
    durationMs: null,
    errorType: 'http',
  });

  const timeoutUrl = await serve(() => undefined);
  await expect(
    probe.probe({
      target: 'baidu',
      url: timeoutUrl,
      timeoutMs: 10,
      proxyUrl: null,
    }),
  ).resolves.toMatchObject({ reachable: false, errorType: 'timeout' });
});

test('稳定区分 DNS、连接、TLS 与代理错误', () => {
  expect(classifyProbeError({ code: 'ENOTFOUND' }, false)).toBe('dns');
  expect(classifyProbeError({ code: 'ECONNREFUSED' }, false)).toBe(
    'connection',
  );
  expect(
    classifyProbeError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }, false),
  ).toBe('tls');
  expect(classifyProbeError({ code: 'ECONNREFUSED' }, true)).toBe('proxy');
});
