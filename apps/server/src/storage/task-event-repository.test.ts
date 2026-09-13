import { describe, expect, test } from 'vitest';
import { StorageError } from './errors.js';
import { SqliteStore } from './store.js';
import { createStore } from '../../test-support/storage.js';

describe('任务与事件仓储', () => {
  test('任务状态转换拒绝重复完成和不存在任务', async () => {
    const setup = await createStore();
    const task = setup.store.tasks.startTask(
      setup.store.tasks.createTask('apply').id,
    );
    setup.store.tasks.completeTask(task.id, { status: 'applied' });
    expect(() => setup.store.tasks.completeTask(task.id)).toThrow(StorageError);
    expect(() =>
      setup.store.tasks.startTask('00000000-0000-4000-8000-000000000000'),
    ).toThrow(StorageError);
    setup.store.close();
  });

  test('配置任务重启中断标记未知且恢复状态受约束', async () => {
    const setup = await createStore();
    const running = setup.store.tasks.startTask(
      setup.store.tasks.createTask('apply').id,
    );
    setup.store.close();
    const reopened = new SqliteStore({ databasePath: setup.databasePath });
    reopened.tasks.recoverInterruptedTasks();
    expect(reopened.tasks.getTask(running.id)).toMatchObject({
      status: 'interrupted',
      recoveryStatus: 'unknown',
    });
    const failed = reopened.tasks.createTask('reset');
    expect(() =>
      reopened.tasks.failTask(
        failed.id,
        'RESET_FAILED',
        '失败',
        'invalid' as never,
      ),
    ).toThrow();
    reopened.close();
  });
});
