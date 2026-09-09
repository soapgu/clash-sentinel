import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { HealthSnapshot } from '@clash-sentinel/shared';
import { SqliteStore } from '../../storage/store.js';
import { OperationCoordinator } from '../operation-coordinator.js';
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
async function setup(run: () => Promise<HealthSnapshot>) {
  const root = await mkdtemp(join(tmpdir(), 'clash-scheduler-'));
  const store = new SqliteStore({ databasePath: join(root, 'scheduler.db') });
  cleanups.push({ root, store });
  const coordinator = new OperationCoordinator();
  const healthCheck = { run: vi.fn(run) };
  const scheduler = new HealthScheduler({ store, coordinator, healthCheck });
  return { store, coordinator, healthCheck, scheduler };
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

test('启动立即执行且慢轮次完成前不会重入或创建任务', async () => {
  vi.useFakeTimers();
  vi.setSystemTime('2026-09-09T04:00:00.000Z');
  let resolveRun!: (value: HealthSnapshot) => void;
  const running = new Promise<HealthSnapshot>((resolve) => {
    resolveRun = resolve;
  });
  const value = await setup(() => running);
  expect(value.scheduler.getSnapshot()).toEqual({
    enabled: true,
    state: 'waiting',
    lastStartedAt: null,
    lastCompletedAt: null,
    nextRunAt: null,
  });
  value.scheduler.start();
  expect(value.healthCheck.run).toHaveBeenCalledOnce();
  expect(value.scheduler.getSnapshot()).toEqual({
    enabled: true,
    state: 'running',
    lastStartedAt: '2026-09-09T04:00:00.000Z',
    lastCompletedAt: null,
    nextRunAt: null,
  });
  await vi.advanceTimersByTimeAsync(180_000);
  expect(value.healthCheck.run).toHaveBeenCalledOnce();
  expect(value.store.listTasks()).toHaveLength(0);
  resolveRun(snapshot());
  await vi.advanceTimersByTimeAsync(0);
  expect(value.scheduler.getSnapshot()).toEqual({
    enabled: true,
    state: 'waiting',
    lastStartedAt: '2026-09-09T04:00:00.000Z',
    lastCompletedAt: '2026-09-09T04:03:00.000Z',
    nextRunAt: '2026-09-09T04:04:00.000Z',
  });
  await value.scheduler.stop();
  expect(value.scheduler.getSnapshot().nextRunAt).toBeNull();
});

test('手动任务占槽时静默跳过，监测关闭时不执行', async () => {
  vi.useFakeTimers();
  vi.setSystemTime('2026-09-09T04:00:00.000Z');
  const value = await setup(async () => snapshot());
  const lease = value.coordinator.tryAcquireManual(
    '550e8400-e29b-41d4-a716-446655440000',
  )!;
  value.scheduler.start();
  expect(value.healthCheck.run).not.toHaveBeenCalled();
  expect(value.store.countEvents()).toBe(0);
  expect(value.scheduler.getSnapshot()).toEqual({
    enabled: true,
    state: 'waiting',
    lastStartedAt: null,
    lastCompletedAt: null,
    nextRunAt: '2026-09-09T04:01:00.000Z',
  });
  await value.scheduler.stop();
  lease.release();

  const disabled = await setup(async () => snapshot());
  disabled.store.updateSettings({ monitoringEnabled: false });
  disabled.scheduler.start();
  expect(disabled.healthCheck.run).not.toHaveBeenCalled();
  expect(disabled.scheduler.getSnapshot()).toEqual({
    enabled: false,
    state: 'disabled',
    lastStartedAt: null,
    lastCompletedAt: null,
    nextRunAt: null,
  });
  await disabled.scheduler.stop();
});

test('当前轮完成后按最新设置周期安排下一轮', async () => {
  vi.useFakeTimers();
  vi.setSystemTime('2026-09-09T04:00:00.000Z');
  const value = await setup(async () => snapshot());
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
  let resolveRun!: (value: HealthSnapshot) => void;
  const running = new Promise<HealthSnapshot>((resolve) => {
    resolveRun = resolve;
  });
  const value = await setup(() => running);
  value.scheduler.start();
  value.store.updateSettings({ monitoringEnabled: false });
  expect(value.scheduler.getSnapshot()).toEqual({
    enabled: false,
    state: 'running',
    lastStartedAt: '2026-09-09T04:00:00.000Z',
    lastCompletedAt: null,
    nextRunAt: null,
  });
  vi.setSystemTime('2026-09-09T04:00:15.000Z');
  resolveRun(snapshot());
  await vi.advanceTimersByTimeAsync(0);
  expect(value.scheduler.getSnapshot()).toEqual({
    enabled: false,
    state: 'disabled',
    lastStartedAt: '2026-09-09T04:00:00.000Z',
    lastCompletedAt: '2026-09-09T04:00:15.000Z',
    nextRunAt: null,
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
  value.scheduler.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(value.scheduler.getSnapshot()).toEqual({
    enabled: true,
    state: 'waiting',
    lastStartedAt: '2026-09-09T04:00:00.000Z',
    lastCompletedAt: '2026-09-09T04:00:00.000Z',
    nextRunAt: '2026-09-09T04:01:00.000Z',
  });
  expect(value.store.listEvents()).toHaveLength(1);
  expect(JSON.stringify(value.store.listEvents())).not.toContain('/private');
  await value.scheduler.stop();
});
