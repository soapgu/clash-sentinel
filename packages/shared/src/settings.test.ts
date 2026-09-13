import { expect, test } from 'vitest';
import { settingsSchema } from './settings.js';

test('存储模型拒绝不安全的自动切换', () => {
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
});
