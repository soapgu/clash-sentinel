import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type {
  HealthSnapshot,
  StreamNotification,
  StreamResource,
} from '@clash-sentinel/shared';
import { SqliteStore } from '../../storage/store.js';
import { StatusNotificationCenter } from '../status-notifier.js';
import type {
  HealthCheckChanges,
  HealthCheckExecution,
} from './health-check.js';
import { HealthScheduler } from './health-scheduler.js';

const cleanups: Array<{ root: string; store: SqliteStore }> = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const item of cleanups.splice(0)) {
    item.store.close();
    await rm(item.root, { recursive: true, force: true });
  }
});

/** 创建测试调度器及其隔离存储。 */
async function setup(
  run: () => Promise<HealthCheckExecution>,
  transientResources?: StreamResource[],
) {
  const root = await mkdtemp(join(tmpdir(), 'clash-scheduler-'));
  const store = new SqliteStore({ databasePath: join(root, 'scheduler.db') });
  cleanups.push({ root, store });
  const notifier = new StatusNotificationCenter();
  const healthCheck = { run: vi.fn(run) };
  const taskEngine = {
    getActiveTaskId: vi.fn((): string | null => null),
    tryRunScheduledTask: vi.fn(() =>
      (async () => {
        try {
          const value = await healthCheck.run();
          const resources: StreamResource[] = [];
          if (value.changes.statusUpdated) resources.push('status');
          if (value.changes.sitesUpdated) resources.push('sites');
          if (value.changes.candidatesUpdated) resources.push('candidates');
          if (value.changes.eventAppended) resources.push('events');
          if (value.changes.settingsUpdated) resources.push('settings');
          resources.push(...(transientResources ?? []));
          return { succeeded: true as const, changedResources: resources };
        } catch (error) {
          return {
            succeeded: false as const,
            changedResources: [] as StreamResource[],
            error,
            errorCode: 'INTERNAL_ERROR',
          };
        }
      })(),
    ),
  };
  const scheduler = new HealthScheduler({
    store,
    notifier,
    taskEngine,
  });
  return {
    store,
    healthCheck,
    scheduler,
    notifier,
    taskEngine,
  };
}

/** 返回调度测试使用的最小合法快照。 */
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
    updatedAt: '2026-09-09T04:00:00.000Z',
  };
}

/** 返回调度测试使用的健康检查结果和可覆盖变化摘要。 */
function execution(
  changes: Partial<HealthCheckChanges> = {},
): HealthCheckExecution {
  return {
    snapshot: snapshot(),
    autoSwitchRequest: null,
    changes: {
      statusUpdated: true,
      sitesUpdated: true,
      candidatesUpdated: false,
      eventAppended: false,
      settingsUpdated: false,
      ...changes,
    },
  };
}

test('启动立即执行且慢轮次完成前不会重入或创建任务', async () => {
  vi.useFakeTimers();
  vi.setSystemTime('2026-09-09T04:00:00.000Z');
  let resolveRun!: (value: HealthCheckExecution) => void;
  const running = new Promise<HealthCheckExecution>((resolve) => {
    resolveRun = resolve;
  });
  const value = await setup(() => running);
  const notifications: StreamNotification[] = [];
  value.notifier.subscribe((notification) => notifications.push(notification));
  notifications.length = 0;
  expect(value.scheduler.getSnapshot()).toEqual({
    enabled: true,
    state: 'waiting',
    lastStartedAt: null,
    lastCompletedAt: null,
    nextRunAt: null,
    activeTaskId: null,
  });
  value.scheduler.start();
  expect(notifications).toMatchObject([
    { reason: 'monitoring_started', resources: ['monitoring'] },
  ]);
  expect(value.healthCheck.run).toHaveBeenCalledOnce();
  expect(value.scheduler.getSnapshot()).toEqual({
    enabled: true,
    state: 'running',
    lastStartedAt: '2026-09-09T04:00:00.000Z',
    lastCompletedAt: null,
    nextRunAt: null,
    activeTaskId: null,
  });
  await vi.advanceTimersByTimeAsync(180_000);
  expect(value.healthCheck.run).toHaveBeenCalledOnce();
  expect(value.store.tasks.listTasks()).toHaveLength(0);
  resolveRun(execution());
  await vi.advanceTimersByTimeAsync(0);
  expect(notifications.at(-1)).toMatchObject({
    reason: 'monitoring_completed',
    resources: ['monitoring', 'status', 'sites'],
  });
  expect(value.scheduler.getSnapshot()).toEqual({
    enabled: true,
    state: 'waiting',
    lastStartedAt: '2026-09-09T04:00:00.000Z',
    lastCompletedAt: '2026-09-09T04:03:00.000Z',
    nextRunAt: '2026-09-09T04:04:00.000Z',
    activeTaskId: null,
  });
  await value.scheduler.stop();
  expect(value.scheduler.getSnapshot().nextRunAt).toBeNull();
});

test('手动任务占槽时静默跳过，监测关闭时不执行', async () => {
  vi.useFakeTimers();
  vi.setSystemTime('2026-09-09T04:00:00.000Z');
  const value = await setup(async () => execution());
  const notifications: StreamNotification[] = [];
  value.notifier.subscribe((notification) => notifications.push(notification));
  notifications.length = 0;
  value.taskEngine.getActiveTaskId.mockReturnValue(
    '550e8400-e29b-41d4-a716-446655440000',
  );
  value.taskEngine.tryRunScheduledTask.mockReturnValueOnce(null);
  value.scheduler.start();
  expect(value.healthCheck.run).not.toHaveBeenCalled();
  expect(notifications).toEqual([]);
  expect(value.store.events.countEvents()).toBe(0);
  expect(value.scheduler.getSnapshot()).toEqual({
    enabled: true,
    state: 'waiting',
    lastStartedAt: null,
    lastCompletedAt: null,
    nextRunAt: '2026-09-09T04:01:00.000Z',
    activeTaskId: '550e8400-e29b-41d4-a716-446655440000',
  });
  await value.scheduler.stop();

  const disabled = await setup(async () => execution());
  disabled.store.settings.updateSettings({ monitoringEnabled: false });
  disabled.scheduler.start();
  expect(disabled.healthCheck.run).not.toHaveBeenCalled();
  expect(disabled.scheduler.getSnapshot()).toEqual({
    enabled: false,
    state: 'disabled',
    lastStartedAt: null,
    lastCompletedAt: null,
    nextRunAt: null,
    activeTaskId: null,
  });
  await disabled.scheduler.stop();
});

test('完成通知仅包含健康检查摘要报告的变化资源', async () => {
  vi.useFakeTimers();
  const value = await setup(async () =>
    execution({ candidatesUpdated: true, eventAppended: true }),
  );
  const notifications: StreamNotification[] = [];
  value.notifier.subscribe((notification) => notifications.push(notification));
  notifications.length = 0;
  value.scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(notifications.at(-1)).toMatchObject({
    reason: 'monitoring_completed',
    resources: ['monitoring', 'status', 'sites', 'candidates', 'events'],
  });
  await value.scheduler.stop();
});

test('定时检测完成后在同一租约中执行自动切换并合并变化资源', async () => {
  vi.useFakeTimers();
  const value = await setup(async () => execution(), ['settings', 'events']);
  const notifications: StreamNotification[] = [];
  value.notifier.subscribe((notification) => notifications.push(notification));
  notifications.length = 0;
  value.scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(value.taskEngine.tryRunScheduledTask).toHaveBeenCalledOnce();
  expect(value.taskEngine.tryRunScheduledTask.mock.calls[0]?.[0]).toEqual({
    type: 'health_check',
  });
  expect(notifications.at(-1)).toMatchObject({
    reason: 'monitoring_completed',
    resources: ['monitoring', 'status', 'sites', 'settings', 'events'],
  });
  await value.scheduler.stop();
});

test('当前轮完成后按最新设置周期安排下一轮', async () => {
  vi.useFakeTimers();
  vi.setSystemTime('2026-09-09T04:00:00.000Z');
  const value = await setup(async () => execution());
  value.scheduler.start();
  await Promise.resolve();
  await Promise.resolve();
  expect(value.healthCheck.run).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(59_999);
  expect(value.healthCheck.run).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(value.healthCheck.run).toHaveBeenCalledTimes(2);
  await value.scheduler.stop();
});

test('运行期间关闭监测会完成本轮再转为暂停', async () => {
  vi.useFakeTimers();
  vi.setSystemTime('2026-09-09T04:00:00.000Z');
  let resolveRun!: (value: HealthCheckExecution) => void;
  const running = new Promise<HealthCheckExecution>((resolve) => {
    resolveRun = resolve;
  });
  const value = await setup(() => running);
  value.scheduler.start();
  value.store.settings.updateSettings({ monitoringEnabled: false });
  expect(value.scheduler.getSnapshot()).toEqual({
    enabled: false,
    state: 'running',
    lastStartedAt: '2026-09-09T04:00:00.000Z',
    lastCompletedAt: null,
    nextRunAt: null,
    activeTaskId: null,
  });
  vi.setSystemTime('2026-09-09T04:00:15.000Z');
  resolveRun(execution());
  await vi.advanceTimersByTimeAsync(0);
  expect(value.scheduler.getSnapshot()).toEqual({
    enabled: false,
    state: 'disabled',
    lastStartedAt: '2026-09-09T04:00:00.000Z',
    lastCompletedAt: '2026-09-09T04:00:15.000Z',
    nextRunAt: null,
    activeTaskId: null,
  });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(value.healthCheck.run).toHaveBeenCalledOnce();
  await value.scheduler.stop();
});

test('整轮失败也记录完成时间并继续真实调度', async () => {
  vi.useFakeTimers();
  vi.setSystemTime('2026-09-09T04:00:00.000Z');
  const value = await setup(async () => {
    throw new Error('/private/raw-error');
  });
  const notifications: StreamNotification[] = [];
  value.notifier.subscribe((notification) => notifications.push(notification));
  notifications.length = 0;
  value.scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(value.scheduler.getSnapshot()).toEqual({
    enabled: true,
    state: 'waiting',
    lastStartedAt: '2026-09-09T04:00:00.000Z',
    lastCompletedAt: '2026-09-09T04:00:00.000Z',
    nextRunAt: '2026-09-09T04:01:00.000Z',
    activeTaskId: null,
  });
  expect(value.store.events.listEvents()).toHaveLength(1);
  expect(notifications.at(-1)).toMatchObject({
    reason: 'monitoring_completed',
    resources: ['monitoring', 'status', 'sites', 'events'],
  });
  expect(JSON.stringify(value.store.events.listEvents())).not.toContain(
    '/private',
  );
  await value.scheduler.stop();
});
