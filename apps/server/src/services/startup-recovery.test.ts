import { afterEach, expect, test, vi } from 'vitest';
import type { StreamResource } from '@clash-sentinel/shared';
import { SqliteStore } from '../storage/store.js';
import { recoverRuntimeState } from './startup-recovery.js';

const stores: SqliteStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
});

function setup() {
  const store = new SqliteStore({ databasePath: ':memory:' });
  stores.push(store);
  const autoSwitch = {
    handleInvalidContext: vi.fn(() => {
      store.settings.updateSettings({
        autoSwitchEnabled: false,
        autoSwitchProfileUid: null,
      });
      return {
        recoveryStatus: 'unknown' as const,
        changedResources: ['settings'] as StreamResource[],
      };
    }),
  };
  return { store, autoSwitch };
}

test('没有遗留任务时不修改设置或写入事件', () => {
  const value = setup();
  value.store.settings.updateSettings({ monitoringEnabled: false });

  expect(recoverRuntimeState(value)).toBe(0);
  expect(value.autoSwitch.handleInvalidContext).not.toHaveBeenCalled();
  expect(value.store.settings.getSettings().monitoringEnabled).toBe(false);
  expect(value.store.events.countEvents()).toBe(0);
});

test('普通遗留任务只标记为中断', () => {
  const value = setup();
  const task = value.store.tasks.startTask(
    value.store.tasks.createTask('diagnose').id,
  );

  expect(recoverRuntimeState(value)).toBe(1);
  expect(value.store.tasks.getTask(task.id)).toMatchObject({
    status: 'interrupted',
    recoveryStatus: null,
  });
  expect(value.autoSwitch.handleInvalidContext).not.toHaveBeenCalled();
  expect(value.store.events.countEvents()).toBe(0);
});

test('自动切换遗留任务触发安全关闭且恢复可重复执行', () => {
  const value = setup();
  value.store.settings.updateSettings({
    autoSwitchEnabled: true,
    autoSwitchProfileUid: 'profile-main',
  });
  const running = value.store.tasks.startTask(
    value.store.tasks.createTask('auto_switch').id,
  );
  const queued = value.store.tasks.createTask('auto_switch');

  expect(recoverRuntimeState(value)).toBe(2);
  expect(recoverRuntimeState(value)).toBe(0);
  expect(value.store.tasks.getTask(running.id)).toMatchObject({
    status: 'interrupted',
    recoveryStatus: 'unknown',
  });
  expect(value.store.tasks.getTask(queued.id)?.status).toBe('interrupted');
  expect(value.store.settings.getSettings()).toMatchObject({
    autoSwitchEnabled: false,
    autoSwitchProfileUid: null,
  });
  expect(value.autoSwitch.handleInvalidContext).toHaveBeenCalledOnce();
  const events = value.store.events.listEvents();
  expect(events).toMatchObject([
    { type: 'auto_switch_interrupted', severity: 'critical' },
  ]);
  expect(events[0]?.details?.taskIds).toEqual(
    expect.arrayContaining([running.id, queued.id]),
  );
});

test('安全关闭后的事件写入失败会回滚整个恢复事务', () => {
  const value = setup();
  value.store.settings.updateSettings({
    autoSwitchEnabled: true,
    autoSwitchProfileUid: 'profile-main',
  });
  const task = value.store.tasks.createTask('auto_switch');
  vi.spyOn(value.store.events, 'appendEvent').mockImplementation(() => {
    throw new Error('事件写入失败');
  });

  expect(() => recoverRuntimeState(value)).toThrow('事件写入失败');
  expect(value.store.tasks.getTask(task.id)?.status).toBe('queued');
  expect(value.store.settings.getSettings()).toMatchObject({
    autoSwitchEnabled: true,
    autoSwitchProfileUid: 'profile-main',
  });
  expect(value.store.events.countEvents()).toBe(0);
});

test('设置写入失败会回滚任务中断且不写入事件', () => {
  const value = setup();
  const task = value.store.tasks.createTask('auto_switch');
  vi.spyOn(value.store.settings, 'updateSettings').mockImplementation(() => {
    throw new Error('设置写入失败');
  });

  expect(() => recoverRuntimeState(value)).toThrow('设置写入失败');
  expect(value.store.tasks.getTask(task.id)?.status).toBe('queued');
  expect(value.store.events.countEvents()).toBe(0);
});
