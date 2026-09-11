import { describe, expect, test } from 'vitest';
import type { StoredTask } from '@clash-sentinel/shared';
import { taskPollingInterval } from './queries.js';

const runningTask = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'health_check',
  status: 'running',
  createdAt: '2026-09-11T04:00:00.000Z',
  startedAt: '2026-09-11T04:00:01.000Z',
  finishedAt: null,
  input: null,
  result: null,
  errorCode: null,
  errorMessage: null,
  recoveryStatus: null,
} satisfies StoredTask;

describe('任务查询刷新策略', () => {
  test('SSE 在线不轮询，断线时每两秒轮询', () => {
    expect(taskPollingInterval('connected', runningTask)).toBe(false);
    expect(taskPollingInterval('offline', runningTask)).toBe(2_000);
    expect(taskPollingInterval('connecting', undefined)).toBe(2_000);
  });

  test('任务进入任一终态后停止轮询', () => {
    for (const status of ['succeeded', 'failed', 'interrupted'] as const)
      expect(taskPollingInterval('offline', { ...runningTask, status })).toBe(
        false,
      );
  });
});
