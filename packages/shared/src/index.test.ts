import { expect, test } from 'vitest';
import {
  healthResponseSchema,
  healthSnapshotSchema,
  monitoringResponseSchema,
  monitoringSnapshotSchema,
  settingsSchema,
  siteResultSchema,
} from './index.js';
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

test('存储模型拒绝不安全的自动切换和矛盾健康数据', () => {
  expect(
    settingsSchema.safeParse({
      checkIntervalMs: 60_000,
      requestTimeoutMs: 5_000,
      entryFailureThreshold: 3,
      autoSwitchCooldownMs: 300_000,
      monitoringEnabled: true,
      autoSwitchEnabled: true,
      autoSwitchProfileUid: null,
      updatedAt: new Date().toISOString(),
    }).success,
  ).toBe(false);
  expect(
    healthSnapshotSchema.safeParse({
      status: 'healthy',
      profile: null,
      lock: { locked: false },
      internetSuccess: 3,
      internetTotal: 2,
      consecutiveFailures: 0,
      recommendedIp: null,
      autoSwitchCooldownUntil: null,
      updatedAt: new Date().toISOString(),
    }).success,
  ).toBe(false);
});

test('站点不可达时拒绝虚假 HTTP 状态和耗时', () => {
  expect(
    siteResultSchema.safeParse({
      target: 'google',
      reachable: false,
      httpStatus: 204,
      durationMs: 10,
      errorType: 'timeout',
      checkedAt: new Date().toISOString(),
      serviceStatus: null,
      incidentSummary: null,
    }).success,
  ).toBe(false);
});
