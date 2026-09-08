import { expect, test } from 'vitest';
import { healthResponseSchema } from './index.js';
test('拒绝错误的服务状态结构', () => {
  expect(
    healthResponseSchema.safeParse({
      ok: true,
      data: { service: 'other', status: 'ok' },
    }).success,
  ).toBe(false);
  expect(healthResponseSchema.safeParse({ ok: true }).success).toBe(false);
});
