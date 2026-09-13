import { expect, test } from 'vitest';
import { healthSnapshotSchema, siteResultSchema } from './health.js';

test('存储模型拒绝矛盾健康数据', () => {
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
