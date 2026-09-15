import { expect, test, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { HealthSnapshot } from '@clash-sentinel/shared';
import { noopLogger } from '../../../logging.js';
import { HealthCheckTaskHandler } from './health-check-task-handler.js';
import type { TaskExecutionIdentity } from '../contracts.js';
import type { HealthCheckExecution } from '../../health/health-check.js';

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

function execution(): HealthCheckExecution {
  return {
    snapshot: snapshot(),
    changes: {
      statusUpdated: true,
      sitesUpdated: true,
      candidatesUpdated: false,
      eventAppended: false,
      settingsUpdated: false,
    },
    autoSwitchRequest: null,
  };
}

for (const persistence of ['persistent', 'transient'] as const) {
  test(`${persistence} 健康检查转换业务请求为 nextTasks 并传递执行关联`, async () => {
    const value = execution();
    value.autoSwitchRequest = {
      currentIp: '198.51.100.20',
      profileUid: 'profile-demo',
      reuseDiagnosis: true,
    };
    const healthCheck = { run: vi.fn(async () => value) };
    const handler = new HealthCheckTaskHandler(healthCheck);
    const task: TaskExecutionIdentity = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      type: 'health_check',
      input: null,
      persistence,
    };
    const source = persistence === 'transient' ? 'scheduled' : 'manual';
    const result = await handler.execute({
      task,
      input: {},
      logger: noopLogger,
    });
    expect(healthCheck.run).toHaveBeenCalledWith(source, task.id);
    expect(result.nextTasks).toEqual([
      {
        type: 'auto_switch',
        input: {
          ...value.autoSwitchRequest,
          trigger: source,
          parentId: task.id,
        },
        metadata: { trigger: source, parentId: task.id },
        queuedResources: ['monitoring'],
      },
    ]);
    expect(result.result).toEqual(value.snapshot);
    expect(result.changedResources).toEqual(
      persistence === 'transient'
        ? ['status', 'sites']
        : ['status', 'sites', 'events'],
    );
  });
}

test('健康服务未建议自动切换时不生成下一任务', async () => {
  const handler = new HealthCheckTaskHandler({
    run: vi.fn(async () => execution()),
  });
  const result = await handler.execute({
    task: {
      id: 'run-1',
      type: 'health_check',
      input: null,
      persistence: 'transient',
    },
    input: {},
    logger: noopLogger,
  });
  expect(result.nextTasks).toEqual([]);
});

test('健康服务与健康 Handler 不依赖自动切换规划端口', async () => {
  const healthSource = await readFile(
    fileURLToPath(new URL('../../health/health-check.ts', import.meta.url)),
    'utf8',
  );
  const handlerSource = await readFile(
    fileURLToPath(new URL('./health-check-task-handler.ts', import.meta.url)),
    'utf8',
  );
  expect(healthSource).not.toMatch(/TaskSubmission|TaskEngine|StreamResource/);
  expect(handlerSource).not.toMatch(/AutoSwitchPlanner|auto-switch-service/);
});
