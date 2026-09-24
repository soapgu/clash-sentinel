import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import { migrations, runMigrations, type Migration } from './migrations.js';
import { SqliteStore } from './store.js';
import { createStore } from '../../test-support/storage.js';

describe('SQLite 迁移', () => {
  test('重复打开数据库不会重复迁移', async () => {
    const setup = await createStore();
    setup.store.close();
    const reopened = new SqliteStore({ databasePath: setup.databasePath });
    reopened.close();
    const database = new Database(setup.databasePath, { readonly: true });
    const rows = database
      .prepare('SELECT version, name FROM schema_migrations')
      .all();
    expect(rows).toEqual([
      { version: 1, name: 'initial_schema' },
      { version: 2, name: 'task_recovery_status' },
      { version: 3, name: 'health_status_detail' },
    ]);
    database.close();
  });

  test('故障迁移回滚其全部结构和版本记录', () => {
    const database = new Database(':memory:');
    const failing: Migration = {
      version: 4,
      name: 'failing_test',
      up(db) {
        db.exec('CREATE TABLE must_rollback (id INTEGER PRIMARY KEY)');
        throw new Error('迁移故障注入');
      },
    };
    expect(() => runMigrations(database, [...migrations, failing])).toThrow(
      '迁移故障注入',
    );
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE name = 'must_rollback'")
        .get(),
    ).toBeUndefined();
    expect(
      database
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all(),
    ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);
    database.close();
  });

  test('启用外键约束并拒绝不存在的任务关联', async () => {
    const setup = await createStore();
    expect(() =>
      setup.store.events.appendEvent({
        type: 'invalid_task_reference',
        severity: 'error',
        retention: 'ordinary',
        summary: '引用不存在的任务',
        taskId: '00000000-0000-4000-8000-000000000000',
      }),
    ).toThrow();
    setup.store.close();
  });
});
