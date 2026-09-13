import { expect, test } from 'vitest';
import {
  apiErrorCodeSchema,
  healthResponseSchema,
  monitoringResponseSchema,
  monitoringSnapshotSchema,
  streamNotificationSchema,
} from './api.js';

test('API 错误码包含请求格式与媒体类型错误', () => {
  expect(apiErrorCodeSchema.safeParse('INVALID_REQUEST').success).toBe(true);
  expect(apiErrorCodeSchema.safeParse('UNSUPPORTED_MEDIA_TYPE').success).toBe(
    true,
  );
});

test('拒绝错误的服务状态结构', () => {
  expect(
    healthResponseSchema.safeParse({
      ok: true,
      data: { service: 'other', status: 'ok' },
    }).success,
  ).toBe(false);
  expect(healthResponseSchema.safeParse({ ok: true }).success).toBe(false);
});

test('定时监测状态接受稳定组合并拒绝矛盾字段', () => {
  const base = {
    lastStartedAt: null,
    lastCompletedAt: null,
    nextRunAt: null,
  };
  expect(
    monitoringSnapshotSchema.safeParse({
      ...base,
      enabled: true,
      state: 'waiting',
    }).success,
  ).toBe(true);
  expect(
    monitoringSnapshotSchema.safeParse({
      ...base,
      enabled: false,
      state: 'disabled',
    }).success,
  ).toBe(true);
  expect(
    monitoringSnapshotSchema.safeParse({
      ...base,
      enabled: false,
      state: 'running',
      lastStartedAt: '2026-09-09T02:27:18.000Z',
    }).success,
  ).toBe(true);
  for (const invalid of [
    { ...base, enabled: false, state: 'waiting' },
    { ...base, enabled: true, state: 'disabled' },
    { ...base, enabled: true, state: 'running' },
    {
      ...base,
      enabled: true,
      state: 'running',
      lastStartedAt: '2026-09-09T02:27:18.000Z',
      nextRunAt: '2026-09-09T02:28:18.000Z',
    },
    {
      ...base,
      enabled: false,
      state: 'disabled',
      nextRunAt: '2026-09-09T02:28:18.000Z',
    },
  ]) {
    expect(monitoringSnapshotSchema.safeParse(invalid).success).toBe(false);
  }
  expect(
    monitoringResponseSchema.safeParse({
      ok: true,
      data: {
        monitoring: { ...base, enabled: true, state: 'waiting' },
      },
    }).success,
  ).toBe(true);
});

test('SSE 通知只接受版本化且无重复的基础或任务资源', () => {
  const valid = {
    version: 1,
    id: 1,
    occurredAt: '2026-09-09T04:00:00.000Z',
    reason: 'task_succeeded',
    resources: [
      'task:550e8400-e29b-41d4-a716-446655440000',
      'status',
      'events',
    ],
  };
  expect(streamNotificationSchema.safeParse(valid).success).toBe(true);
  for (const invalid of [
    { ...valid, version: 2 },
    { ...valid, id: 0 },
    { ...valid, occurredAt: 'not-a-time' },
    { ...valid, resources: ['unknown'] },
    { ...valid, resources: ['task:not-a-uuid'] },
    { ...valid, resources: ['events', 'events'] },
  ])
    expect(streamNotificationSchema.safeParse(invalid).success).toBe(false);
});
