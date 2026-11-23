import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import { migrations, runMigrations, type Migration } from './migrations.js';
import { DiagnosisRepository } from './diagnosis-repository.js';
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
      { version: 4, name: 'diagnosis_source_labels' },
    ]);
    database.close();
  });

  test('从旧结构迁移后保留原候选并可写入来源证据', () => {
    const database = new Database(':memory:');
    try {
      runMigrations(
        database,
        migrations.filter(({ version }) => version <= 3),
      );
      database.exec(`
        INSERT INTO diagnosis_snapshot (
          singleton_id, id, status, generated_at, saved_at, profile_uid,
          profile_name, domain, tested_ports_json, test_rounds, recommended_ip
        ) VALUES (
          1, '11111111-1111-4111-8111-111111111111', 'testable', 1, 1,
          'main', '测试订阅', 'entry.example', '[443]', 1, '192.0.2.1'
        );
        INSERT INTO diagnosis_candidates (
          diagnosis_id, ip, eligible, success, total, success_rate,
          average_ms, failed_ports_json, sources_json
        ) VALUES (
          '11111111-1111-4111-8111-111111111111', '192.0.2.1', 1, 1, 1,
          100, 20, '[]', '["system"]'
        );
      `);
      runMigrations(database);
      const repository = new DiagnosisRepository(database);
      const previous = repository.getDiagnosis()!;
      expect(previous.candidates[0]).toMatchObject({ sources: ['system'] });
      expect(previous.candidates[0]).not.toHaveProperty('sourceLabels');
      const sourceLabels = '系统 DNS 查询（应答服务器未记录）';
      repository.replaceDiagnosis({
        ...previous,
        candidates: previous.candidates.map((candidate) => ({
          ...candidate,
          sourceLabels,
        })),
      });
      expect(repository.getDiagnosis()?.candidates[0]?.sourceLabels).toBe(
        sourceLabels,
      );
    } finally {
      database.close();
    }
  });

  test('故障迁移回滚其全部结构和版本记录', () => {
    const database = new Database(':memory:');
    const failing: Migration = {
      version: 5,
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
    ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
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
