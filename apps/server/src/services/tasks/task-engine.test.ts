import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type {
  StoredJsonObject,
  StreamNotification,
  TaskType,
} from '@clash-sentinel/shared';
import { SqliteStore } from '../../storage/store.js';
import { StatusNotificationCenter } from '../status-notifier.js';
import type {
  TaskExecutionResult,
  TaskHandler,
  TaskHandlerRegistry,
} from './contracts.js';
import { TaskEngine } from './task-engine.js';

const cleanups: Array<{ root: string; store: SqliteStore }> = [];

afterEach(async () => {
  for (const item of cleanups.splice(0)) {
    item.store.close();
    await rm(item.root, { recursive: true, force: true });
  }
});

/** 创建一个只实现指定任务类型和执行函数的测试 Handler。 */
function handler(
  type: TaskType,
  execute: TaskHandler['execute'] = async () => ({
    result: {},
    changedResources: [],
  }),
): TaskHandler {
  return {
    type,
    auditName: type,
    critical: false,
    parseInput: (input) => input ?? {},
    execute,
  };
}

/** 创建覆盖全部 TaskType、并允许按类型覆盖的测试注册表。 */
function registry(
  overrides: Partial<Record<TaskType, TaskHandler>> = {},
): TaskHandlerRegistry {
  return {
    health_check: (overrides.health_check ??
      handler('health_check')) as TaskHandlerRegistry['health_check'],
    diagnose: (overrides.diagnose ??
      handler('diagnose')) as TaskHandlerRegistry['diagnose'],
    apply: (overrides.apply ??
      handler('apply')) as TaskHandlerRegistry['apply'],
    reset: (overrides.reset ??
      handler('reset')) as TaskHandlerRegistry['reset'],
    rollback: (overrides.rollback ??
      handler('rollback')) as TaskHandlerRegistry['rollback'],
    auto_switch: (overrides.auto_switch ??
      handler('auto_switch')) as TaskHandlerRegistry['auto_switch'],
  };
}

/** 创建隔离 SQLite、通知中心、协调器和待测 TaskEngine。 */
async function setup(handlers: TaskHandlerRegistry) {
  const root = await mkdtemp(join(tmpdir(), 'task-engine-'));
  const store = new SqliteStore({ databasePath: join(root, 'state.db') });
  cleanups.push({ root, store });
  const notifier = new StatusNotificationCenter();
  const notifications: StreamNotification[] = [];
  notifier.subscribe((notification) => notifications.push(notification));
  notifications.length = 0;
  const engine = new TaskEngine({ store, notifier, handlers });
  return { store, notifier, notifications, engine };
}

test('使用注册 Handler 完成统一生命周期并保持结果结构', async () => {
  const execute = vi.fn(async ({ input }) => ({
    result: { received: input.value } as StoredJsonObject,
    changedResources: ['status'] as const,
  }));
  const value = await setup(
    registry({ health_check: handler('health_check', execute) }),
  );
  const task = value.engine.enqueue('health_check', { value: 42 });
  await value.engine.waitForIdle();

  expect(execute).toHaveBeenCalledOnce();
  expect(value.store.getTask(task.id)).toMatchObject({
    status: 'succeeded',
    result: { received: 42 },
  });
  expect(value.notifications.at(-1)).toMatchObject({
    reason: 'task_succeeded',
    resources: [`task:${task.id}`, 'status', 'events'],
  });
});

test('声明式后续任务复用租约并经过同一个引擎', async () => {
  const automatic = vi.fn(async () => ({
    result: { status: 'no_change' },
    changedResources: ['monitoring'] as const,
  }));
  const manual = vi.fn(async (): Promise<TaskExecutionResult> => ({
    result: { status: 'healthy' },
    changedResources: ['status'],
    nextTasks: [{ type: 'auto_switch', input: { trigger: 'manual' } }],
  }));
  const value = await setup(
    registry({
      health_check: handler('health_check', manual),
      auto_switch: handler('auto_switch', automatic),
    }),
  );
  value.engine.enqueue('health_check');
  await value.engine.waitForIdle();

  expect(manual).toHaveBeenCalledOnce();
  expect(automatic).toHaveBeenCalledOnce();
  expect(value.store.listTasks()).toMatchObject([
    { type: 'auto_switch', status: 'succeeded' },
    { type: 'health_check', status: 'succeeded' },
  ]);
  expect(value.engine.hasActiveOperation()).toBe(false);
});

test('瞬时任务执行 Handler 但不写任务、审计或生命周期通知', async () => {
  const execute = vi.fn(async () => ({
    result: {},
    changedResources: ['status', 'status'] as const,
    audit: { summary: '不应写入' },
  }));
  const value = await setup(
    registry({ health_check: handler('health_check', execute) }),
  );
  const outcome = await value.engine.tryRunScheduledTask(
    { type: 'health_check' },
    '550e8400-e29b-41d4-a716-446655440000',
  )!;

  expect(outcome).toEqual({ succeeded: true, changedResources: ['status'] });
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({
      task: expect.objectContaining({ persistence: 'transient' }),
    }),
  );
  expect(value.store.listTasks()).toEqual([]);
  expect(value.store.listEvents()).toEqual([]);
  expect(value.notifications).toEqual([]);
});

test('定时任务占槽时拒绝其他定时任务并在完成后释放', async () => {
  let finish!: (value: TaskExecutionResult) => void;
  const running = new Promise<TaskExecutionResult>((resolve) => {
    finish = resolve;
  });
  const value = await setup(
    registry({ health_check: handler('health_check', () => running) }),
  );
  const completion = value.engine.tryRunScheduledTask(
    { type: 'health_check' },
    'scheduled-1',
  )!;

  expect(value.engine.getActiveTaskId()).toBeNull();
  expect(value.engine.getConflictDetails()).toEqual({
    activeOperation: 'scheduled_health',
  });
  expect(
    value.engine.tryRunScheduledTask({ type: 'health_check' }, 'scheduled-2'),
  ).toBeNull();

  finish({ result: {}, changedResources: [] });
  await completion;
  expect(value.engine.hasActiveOperation()).toBe(false);
  await expect(
    value.engine.tryRunScheduledTask({ type: 'health_check' }, 'scheduled-3'),
  ).resolves.toMatchObject({ succeeded: true });
});

test('nextTasks 在同一租约中先完成子任务链再执行兄弟任务', async () => {
  const order: TaskType[] = [];
  const taskHandler = (
    type: TaskType,
    nextTasks: TaskExecutionResult['nextTasks'] = [],
  ) =>
    handler(type, async () => {
      order.push(type);
      return { result: {}, changedResources: [], nextTasks };
    });
  const value = await setup(
    registry({
      health_check: taskHandler('health_check', [
        { type: 'diagnose' },
        { type: 'reset' },
      ]),
      diagnose: taskHandler('diagnose', [{ type: 'auto_switch' }]),
      auto_switch: taskHandler('auto_switch'),
      reset: taskHandler('reset'),
    }),
  );
  value.engine.enqueue('health_check');
  await value.engine.waitForIdle();
  expect(order).toEqual(['health_check', 'diagnose', 'auto_switch', 'reset']);
  expect(value.engine.hasActiveOperation()).toBe(false);
});

test('瞬时任务失败时归一化错误且不执行后续持久化生命周期', async () => {
  const error = new Error('瞬时失败');
  const value = await setup(
    registry({
      health_check: handler('health_check', async () => {
        throw error;
      }),
    }),
  );
  const outcome = await value.engine.tryRunScheduledTask(
    { type: 'health_check' },
    '550e8400-e29b-41d4-a716-446655440000',
  )!;

  expect(outcome).toEqual({
    succeeded: false,
    changedResources: [],
    error,
    errorCode: 'INTERNAL_ERROR',
  });
  expect(value.store.listTasks()).toEqual([]);
  expect(value.store.listEvents()).toEqual([]);
  expect(value.notifications).toEqual([]);
});

test('瞬时根任务的后续任务继续持久化并合并资源', async () => {
  const health = vi.fn(async (): Promise<TaskExecutionResult> => ({
    result: {},
    changedResources: ['status'],
    nextTasks: [{ type: 'auto_switch', input: { trigger: 'scheduled' } }],
  }));
  let finishAutomatic!: (value: TaskExecutionResult) => void;
  const automatic = vi.fn(
    () =>
      new Promise<TaskExecutionResult>((resolve) => {
        finishAutomatic = resolve;
      }),
  );
  const value = await setup(
    registry({
      health_check: handler('health_check', health),
      auto_switch: handler('auto_switch', automatic),
    }),
  );
  const completion = value.engine.tryRunScheduledTask(
    { type: 'health_check' },
    '550e8400-e29b-41d4-a716-446655440000',
  )!;

  await vi.waitFor(() => expect(value.store.listTasks()).toHaveLength(1));
  expect(value.engine.getActiveTaskId()).toBe(value.store.listTasks()[0]?.id);
  finishAutomatic({
    result: { status: 'changed' },
    changedResources: ['settings'],
  });
  const outcome = await completion;

  expect(outcome).toEqual({
    succeeded: true,
    changedResources: ['status', 'settings', 'events'],
  });
  expect(value.store.listTasks()).toMatchObject([
    { type: 'auto_switch', status: 'succeeded' },
  ]);
  expect(value.engine.hasActiveOperation()).toBe(false);
});

test('注册表错误在启动时失败，TaskEngine 不包含具体业务分派', async () => {
  expect(
    () =>
      new TaskEngine({
        store: {} as SqliteStore,
        notifier: new StatusNotificationCenter(),
        handlers: {
          ...registry(),
          diagnose: handler('apply'),
        } as TaskHandlerRegistry,
      }),
  ).toThrow('任务处理器注册错误');

  const source = await readFile(
    fileURLToPath(new URL('./task-engine.ts', import.meta.url)),
    'utf8',
  );
  expect(source).not.toMatch(
    /LegacyAdapter|HealthCheckService|AutoSwitchService/,
  );
  expect(source).not.toMatch(/\bswitch\s*\(/);
  expect(source).not.toMatch(/case\s+['"]/);
});
