import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type {
  DiagnosisResult,
  HealthSnapshot,
  StreamNotification,
} from '@clash-sentinel/shared';
import { LegacyAdapterError } from '../legacy/adapter.js';
import { SqliteStore } from '../storage/store.js';
import { OperationCoordinator } from './operation-coordinator.js';
import { StatusNotificationCenter } from './status-notifier.js';
import { AutoSwitchService } from './auto-switch-service.js';
import { TaskEngine } from './tasks/task-engine.js';
import { createTaskHandlerRegistry } from './tasks/registry.js';

const cleanups: Array<{ root: string; store: SqliteStore }> = [];

afterEach(async () => {
  for (const item of cleanups.splice(0)) {
    item.store.close();
    await rm(item.root, { recursive: true, force: true });
  }
});

function snapshot(): HealthSnapshot {
  return {
    status: 'entry_down',
    profile: { uid: 'profile-main', name: '主订阅' },
    lock: {
      locked: true,
      domain: 'entry.example.test',
      ip: '198.51.100.20',
    },
    internetSuccess: 3,
    internetTotal: 3,
    consecutiveFailures: 3,
    recommendedIp: '198.51.100.21',
    autoSwitchCooldownUntil: null,
    updatedAt: '2026-09-11T04:00:00.000Z',
  };
}

function diagnosis(eligible = true): DiagnosisResult {
  return {
    status: 'testable',
    generatedAt: '2026-09-11T04:00:00.000Z',
    profile: { uid: 'profile-main', name: '主订阅' },
    domain: 'entry.example.test',
    skipReason: null,
    detail: null,
    testedPorts: [443],
    testRounds: 2,
    candidates: [
      {
        ip: '198.51.100.21',
        eligible,
        success: eligible ? 2 : 1,
        total: 2,
        successRate: eligible ? 100 : 50,
        averageMs: 12,
        failedPorts: eligible ? [] : [443],
        sources: ['system'],
      },
    ],
    recommendedIp: eligible ? '198.51.100.21' : null,
  };
}

/** 创建自动切换集成测试所需的隔离任务引擎和可控领域依赖。 */
async function setup(
  options: {
    diagnosis?: DiagnosisResult;
    applyError?: LegacyAdapterError;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'clash-auto-switch-'));
  const store = new SqliteStore({ databasePath: join(root, 'state.db') });
  cleanups.push({ root, store });
  store.updateSettings({
    autoSwitchEnabled: true,
    autoSwitchProfileUid: 'profile-main',
    autoSwitchCooldownMs: 300_000,
  });
  store.upsertHealthSnapshot(snapshot());
  if (options.diagnosis) store.replaceDiagnosis(options.diagnosis);
  const notifier = new StatusNotificationCenter();
  const adapter = {
    diagnose: vi.fn(async () => options.diagnosis ?? diagnosis()),
    applyIp: vi.fn(async (ip: string) => {
      if (options.applyError) throw options.applyError;
      return {
        status: 'applied' as const,
        domain: 'entry.example.test',
        ip,
        message: '应用成功',
      };
    }),
  };
  const service = new AutoSwitchService({
    store,
    adapter,
    now: () => new Date('2026-09-11T04:01:00.000Z'),
  });
  const coordinator = new OperationCoordinator();
  const taskEngine = new TaskEngine({
    store,
    coordinator,
    notifier,
    handlers: createTaskHandlerRegistry({
      store,
      adapter: {
        ...adapter,
        diagnose: adapter.diagnose,
        getStatus: vi.fn(),
        readLatestDiagnosis: vi.fn(),
        healthCheck: vi.fn(),
        resetLock: vi.fn(),
        rollback: vi.fn(),
      },
      healthCheck: { run: vi.fn() },
      autoSwitch: service,
    }),
  });
  const lease = coordinator.tryAcquireScheduled()!;
  const notifications: StreamNotification[] = [];
  notifier.subscribe((item) => notifications.push(item));
  notifications.length = 0;
  return {
    store,
    adapter,
    service,
    taskEngine,
    coordinator,
    lease,
    notifications,
    runAutoSwitch: async (
      health: Parameters<AutoSwitchService['prepare']>[0],
      source: Parameters<AutoSwitchService['prepare']>[1],
      parentId: string,
    ) => {
      const submission = service.prepare(health, source, parentId);
      return submission ? await taskEngine.runWithLease(submission, lease) : [];
    },
  };
}

test('满足条件时创建自动任务、应用最佳候选并持久化冷却', async () => {
  const value = await setup({ diagnosis: diagnosis() });
  await value.runAutoSwitch(
    {
      snapshot: snapshot(),
      changes: {
        statusUpdated: true,
        sitesUpdated: true,
        candidatesUpdated: true,
        eventAppended: false,
        settingsUpdated: false,
      },
    },
    'scheduled',
    'run-1',
  );
  expect(value.adapter.diagnose).not.toHaveBeenCalled();
  expect(value.adapter.applyIp).toHaveBeenCalledWith('198.51.100.21');
  expect(value.store.listTasks(1)[0]).toMatchObject({
    type: 'auto_switch',
    status: 'succeeded',
  });
  expect(value.store.getHealthSnapshot()).toMatchObject({
    status: 'healthy',
    lock: { locked: true, ip: '198.51.100.21' },
    consecutiveFailures: 0,
    autoSwitchCooldownUntil: '2026-09-11T04:06:00.000Z',
  });
  expect(value.coordinator.getConflictDetails()?.activeTaskId).toBe(
    value.store.listTasks(1)[0]?.id,
  );
});

test('无合格候选以 no_change 完成并进入冷却', async () => {
  const value = await setup({ diagnosis: diagnosis(false) });
  await value.runAutoSwitch(
    {
      snapshot: snapshot(),
      changes: {
        statusUpdated: true,
        sitesUpdated: true,
        candidatesUpdated: false,
        eventAppended: false,
        settingsUpdated: false,
      },
    },
    'manual',
    'health-task',
  );
  expect(value.adapter.diagnose).toHaveBeenCalledOnce();
  expect(value.adapter.applyIp).not.toHaveBeenCalled();
  expect(value.store.listTasks(1)[0]).toMatchObject({
    status: 'succeeded',
    result: { status: 'no_change' },
  });
  expect(value.store.getSettings().autoSwitchEnabled).toBe(true);
});

test('失败已恢复时保留自动开关并进入冷却', async () => {
  const value = await setup({
    diagnosis: diagnosis(),
    applyError: new LegacyAdapterError(
      'APPLY_FAILED',
      '应用失败但已恢复',
      1,
      'recovered',
    ),
  });
  await value.runAutoSwitch(
    {
      snapshot: snapshot(),
      changes: {
        statusUpdated: true,
        sitesUpdated: true,
        candidatesUpdated: true,
        eventAppended: false,
        settingsUpdated: false,
      },
    },
    'scheduled',
    'run-2',
  );
  expect(value.store.listTasks(1)[0]).toMatchObject({
    status: 'failed',
    recoveryStatus: 'recovered',
  });
  expect(value.store.getSettings().autoSwitchEnabled).toBe(true);
  expect(value.store.getHealthSnapshot()?.autoSwitchCooldownUntil).toBe(
    '2026-09-11T04:06:00.000Z',
  );
});

test('恢复失败时关闭自动切换且冷却期阻止创建任务', async () => {
  const value = await setup({
    diagnosis: diagnosis(),
    applyError: new LegacyAdapterError(
      'APPLY_FAILED',
      '恢复失败',
      1,
      'recovery_failed',
    ),
  });
  await value.runAutoSwitch(
    {
      snapshot: snapshot(),
      changes: {
        statusUpdated: true,
        sitesUpdated: true,
        candidatesUpdated: true,
        eventAppended: false,
        settingsUpdated: false,
      },
    },
    'scheduled',
    'run-3',
  );
  expect(value.store.getSettings()).toMatchObject({
    autoSwitchEnabled: false,
    autoSwitchProfileUid: null,
  });
  expect(value.store.listTasks(1)[0]).toMatchObject({
    status: 'failed',
    recoveryStatus: 'recovery_failed',
  });

  const cooling = await setup();
  cooling.store.upsertHealthSnapshot({
    ...snapshot(),
    autoSwitchCooldownUntil: '2026-09-11T04:02:00.000Z',
  });
  await cooling.runAutoSwitch(
    {
      snapshot: cooling.store.getHealthSnapshot()!,
      changes: {
        statusUpdated: true,
        sitesUpdated: true,
        candidatesUpdated: false,
        eventAppended: false,
        settingsUpdated: false,
      },
    },
    'scheduled',
    'run-4',
  );
  expect(cooling.store.listTasks()).toHaveLength(0);
});
