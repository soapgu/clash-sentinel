import { expect, test } from 'vitest';
import { createStore } from '../../test-support/storage.js';

test('SqliteStore 组合六个共享连接仓储并统一关闭', async () => {
  const setup = await createStore();
  setup.store.settings.updateSettings({ monitoringEnabled: false });
  setup.store.health.getHealthSnapshot();
  setup.store.sites.getSiteSnapshot('baidu');
  setup.store.diagnoses.getDiagnosis();
  const task = setup.store.tasks.createTask('diagnose');
  setup.store.events.appendEvent({
    type: 'composition_test',
    severity: 'info',
    retention: 'ordinary',
    summary: '组合根可用',
    taskId: task.id,
  });
  expect(setup.store.tasks.listTasks()).toHaveLength(1);
  expect(setup.store.events.countEvents()).toBe(1);
  setup.store.close();
  expect(() => setup.store.settings.getSettings()).toThrow();
});

test('组合根事务会回滚不同仓储的写入', async () => {
  const { store } = await createStore();
  expect(() =>
    store.transaction(() => {
      store.settings.updateSettings({ monitoringEnabled: false });
      const task = store.tasks.createTask('diagnose');
      store.events.appendEvent({
        type: 'rollback_test',
        severity: 'info',
        retention: 'ordinary',
        summary: '事务回滚',
        taskId: task.id,
      });
      throw new Error('回滚');
    }),
  ).toThrow('回滚');
  expect(store.settings.getSettings().monitoringEnabled).toBe(true);
  expect(store.tasks.listTasks()).toHaveLength(0);
  expect(store.events.countEvents()).toBe(0);
  store.close();
});
