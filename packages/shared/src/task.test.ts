import { expect, test } from 'vitest';
import { storedTaskSchema } from './task.js';

test('任务恢复状态只接受稳定枚举且允许旧任务为空', () => {
  const task = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    type: 'apply',
    status: 'failed',
    createdAt: '2026-09-11T04:00:00.000Z',
    startedAt: '2026-09-11T04:00:01.000Z',
    finishedAt: '2026-09-11T04:00:02.000Z',
    input: null,
    result: null,
    errorCode: 'APPLY_FAILED',
    errorMessage: '应用失败',
    recoveryStatus: 'recovered',
  };
  expect(storedTaskSchema.safeParse(task).success).toBe(true);
  expect(
    storedTaskSchema.safeParse({ ...task, recoveryStatus: null }).success,
  ).toBe(true);
  expect(
    storedTaskSchema.safeParse({ ...task, recoveryStatus: 'safe' }).success,
  ).toBe(false);
});
