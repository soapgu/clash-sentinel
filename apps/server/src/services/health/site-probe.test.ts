import { createServer, type Server } from 'node:http';
import { afterEach, expect, test, vi } from 'vitest';
import { ProxyAgent } from 'undici';
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
  vi.restoreAllMocks();
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

test('复用当前代理连接池并在代理地址变化时关闭旧实例', async () => {
  const probe = new UndiciSiteProbe();
  const dispatcher = probe as unknown as {
    dispatcher(proxyUrl: string | null): unknown;
  };

  const first = dispatcher.dispatcher('http://127.0.0.1:7001') as ProxyAgent;
  const firstClose = vi.spyOn(first, 'close').mockResolvedValue();
  expect(dispatcher.dispatcher('http://127.0.0.1:7001')).toBe(first);
  expect(firstClose).not.toHaveBeenCalled();

  const second = dispatcher.dispatcher('http://127.0.0.1:7002') as ProxyAgent;
  expect(second).not.toBe(first);
  await vi.waitFor(() => expect(firstClose).toHaveBeenCalledOnce());

  const secondClose = vi.spyOn(second, 'close').mockResolvedValue();
  await probe.close();
  expect(secondClose).toHaveBeenCalledOnce();
});

test('关闭时等待当前及仍在回收的代理连接池', async () => {
  const pending: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  vi.spyOn(ProxyAgent.prototype, 'close').mockImplementation(
    () =>
      new Promise<void>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  );
  const probe = new UndiciSiteProbe();
  const dispatcher = probe as unknown as {
    dispatcher(proxyUrl: string | null): unknown;
  };

  dispatcher.dispatcher('http://127.0.0.1:7001');
  dispatcher.dispatcher('http://127.0.0.1:7002');
  await vi.waitFor(() => expect(pending).toHaveLength(1));

  let closed = false;
  const closing = probe.close().then(() => {
    closed = true;
  });
  await vi.waitFor(() => expect(pending).toHaveLength(2));
  expect(closed).toBe(false);

  pending[1]?.resolve();
  await Promise.resolve();
  expect(closed).toBe(false);

  pending[0]?.reject(new Error('模拟旧代理关闭失败'));
  await expect(closing).resolves.toBeUndefined();
  expect(closed).toBe(true);
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
