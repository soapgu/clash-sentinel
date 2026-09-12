import { expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { HealthSnapshot } from '@clash-sentinel/shared';
import type { OperationLease } from '../operation-coordinator.js';
import { noopLogger } from '../../logging.js';
import { HealthCheckTaskHandler } from './health-check-task-handler.js';
import type { TaskExecutionIdentity } from './contracts.js';

/** 返回 Handler 测试使用的最小合法健康快照。 */
function snapshot(): HealthSnapshot {
  return {
    status: 'healthy',
    profile: null,
    lock: { locked: false },
    internetSuccess: 3,
    internetTotal: 3,
    consecutiveFailures: 0,
    recommendedIp: null,
    autoSwitchCooldownUntil: null,
    updatedAt: '2026-09-12T00:00:00.000Z',
  };
}

/** 返回带固定 UUID 的最小 running 健康任务。 */
function task(
  persistence: TaskExecutionIdentity['persistence'] = 'persistent',
): TaskExecutionIdentity {
  return {
    id: '550e8400-e29b-41d4-a716-446655440000',
    type: 'health_check',
    input: null,
    persistence,
  };
}

test('瞬时健康检查使用 scheduled 来源', async () => {
  const execution = {
    snapshot: snapshot(),
    changes: {
      statusUpdated: true,
      sitesUpdated: true,
      candidatesUpdated: false,
      eventAppended: false,
      settingsUpdated: false,
    },
  };
  const healthCheck = { run: vi.fn(async () => execution) };
  const autoSwitchPlanner = { prepare: vi.fn(() => null) };
  const handler = new HealthCheckTaskHandler({
    healthCheck,
    autoSwitchPlanner,
  });

  const result = await handler.execute({
    task: task('transient'),
    input: {},
    lease: {} as OperationLease,
    logger: noopLogger,
  });

  expect(healthCheck.run).toHaveBeenCalledWith('scheduled', task().id);
  expect(autoSwitchPlanner.prepare).toHaveBeenCalledWith(
    execution,
    'scheduled',
    task().id,
  );
  expect(result.changedResources).toEqual(['status', 'sites']);
});

test('使用领域规划器生成手动健康检查的声明式后续任务', async () => {
  const execution = {
    snapshot: snapshot(),
    changes: {
      statusUpdated: true,
      sitesUpdated: true,
      candidatesUpdated: false,
      eventAppended: false,
      settingsUpdated: false,
    },
  };
  const healthCheck = { run: vi.fn(async () => execution) };
  const followUp = {
    type: 'auto_switch' as const,
    input: { trigger: 'manual', parentId: task().id },
  };
  const autoSwitchPlanner = { prepare: vi.fn(() => followUp) };
  const handler = new HealthCheckTaskHandler({
    healthCheck,
    autoSwitchPlanner,
  });

  const result = await handler.execute({
    task: task(),
    input: {},
    lease: {} as OperationLease,
    logger: noopLogger,
  });

  expect(healthCheck.run).toHaveBeenCalledWith('manual', task().id);
  expect(autoSwitchPlanner.prepare).toHaveBeenCalledWith(
    execution,
    'manual',
    task().id,
  );
  expect(result.followUps).toEqual([followUp]);
  expect(result.result).toEqual(execution.snapshot);
});

test('规划器拒绝自动切换时不生成后续任务', async () => {
  const healthCheck = {
    run: vi.fn(async () => ({
      snapshot: snapshot(),
      changes: {
        statusUpdated: true,
        sitesUpdated: false,
        candidatesUpdated: false,
        eventAppended: false,
        settingsUpdated: false,
      },
    })),
  };
  const handler = new HealthCheckTaskHandler({
    healthCheck,
    autoSwitchPlanner: { prepare: vi.fn(() => null) },
  });

  const result = await handler.execute({
    task: task(),
    input: {},
    lease: {} as OperationLease,
    logger: noopLogger,
  });

  expect(result.followUps).toEqual([]);
});

test('自动切换规划端口归属领域模块且 Runtime 不再包装重复 Lambda', async () => {
  const schedulerSource = await readFile(
    fileURLToPath(new URL('../health/health-scheduler.ts', import.meta.url)),
    'utf8',
  );
  const runtimeSource = await readFile(
    fileURLToPath(new URL('../../runtime.ts', import.meta.url)),
    'utf8',
  );

  expect(schedulerSource).not.toContain('AutoSwitchPlanner');
  expect(schedulerSource).not.toContain('HealthCheckService');
  expect(schedulerSource).not.toContain('tasks/health-check-task-handler');
  expect(runtimeSource).not.toContain('planAutoSwitch');
  expect(runtimeSource).not.toMatch(/\(health, source, parentId\)\s*=>/);
});
