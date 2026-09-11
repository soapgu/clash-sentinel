import { describe, expect, test, vi } from 'vitest';
import { healthResponseSchema } from '@clash-sentinel/shared';
import {
  ApiClientError,
  HEALTH_REQUEST_TIMEOUT_MS,
  SNAPSHOT_REQUEST_TIMEOUT_MS,
  requestJson,
} from './api.js';

const okBody = { ok: true, data: { service: 'clash-sentinel', status: 'ok' } };

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('统一 API 请求层', () => {
  test('健康探针和普通快照使用分层超时常量', () => {
    expect(HEALTH_REQUEST_TIMEOUT_MS).toBe(3_000);
    expect(SNAPSHOT_REQUEST_TIMEOUT_MS).toBe(12_000);
  });

  test('携带超时信号并使用共享 Schema 校验成功响应', async () => {
    const fetcher = vi.fn(async () => response(okBody));
    const signal = new AbortController().signal;
    const timeoutSignal = vi.fn(() => signal);
    await expect(
      requestJson('/api/health', healthResponseSchema, {
        timeoutMs: 3_000,
        fetcher,
        timeoutSignal,
      }),
    ).resolves.toEqual(okBody);
    expect(timeoutSignal).toHaveBeenCalledWith(3_000);
    expect(fetcher).toHaveBeenCalledWith('/api/health', {
      headers: { Accept: 'application/json' },
      signal,
    });
  });

  test('保留后端结构化错误、错误码和请求 ID', async () => {
    const requestId = '11111111-1111-4111-8111-111111111111';
    const fetcher = vi.fn(async () =>
      response(
        {
          ok: false,
          error: {
            code: 'REQUEST_TIMEOUT',
            message: '请求处理超时，请稍后重试',
            details: {
              activeTaskId: '11111111-1111-4111-8111-111111111111',
            },
          },
          requestId,
        },
        504,
      ),
    );
    const promise = requestJson('/api/status', healthResponseSchema, {
      timeoutMs: 12_000,
      fetcher,
      timeoutSignal: () => new AbortController().signal,
    });
    await expect(promise).rejects.toMatchObject({
      kind: 'api',
      status: 504,
      code: 'REQUEST_TIMEOUT',
      requestId,
      details: {
        activeTaskId: '11111111-1111-4111-8111-111111111111',
      },
    });
  });

  test('写请求统一编码 JSON 且仍使用普通请求超时', async () => {
    const fetcher = vi.fn(async () => response(okBody));
    const signal = new AbortController().signal;
    await requestJson('/api/actions/health-check', healthResponseSchema, {
      timeoutMs: 12_000,
      method: 'POST',
      body: {},
      fetcher,
      timeoutSignal: () => signal,
    });
    expect(fetcher).toHaveBeenCalledWith('/api/actions/health-check', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: '{}',
      signal,
    });
  });

  test('区分响应格式、超时和网络错误', async () => {
    const invalid = requestJson('/api/health', healthResponseSchema, {
      timeoutMs: 3_000,
      fetcher: async () => response({ ok: true }),
      timeoutSignal: () => new AbortController().signal,
    });
    await expect(invalid).rejects.toMatchObject({ kind: 'response' });

    const timeout = requestJson('/api/health', healthResponseSchema, {
      timeoutMs: 3_000,
      fetcher: async () => {
        throw new DOMException('timeout', 'TimeoutError');
      },
      timeoutSignal: () => new AbortController().signal,
    });
    await expect(timeout).rejects.toMatchObject({ kind: 'timeout' });

    const network = requestJson('/api/health', healthResponseSchema, {
      timeoutMs: 3_000,
      fetcher: async () => {
        throw new TypeError('connection refused');
      },
      timeoutSignal: () => new AbortController().signal,
    });
    await expect(network).rejects.toBeInstanceOf(ApiClientError);
    await expect(network).rejects.toMatchObject({ kind: 'network' });
  });
});
