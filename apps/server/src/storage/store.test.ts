import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';
import type {
  DiagnosisResult,
  HealthSnapshot,
  SiteResult,
  StoredJsonObject,
} from '@clash-sentinel/shared';
import { migrations, runMigrations, type Migration } from './migrations.js';
import {
  CRITICAL_EVENT_LIMIT,
  ORDINARY_EVENT_LIMIT,
  SITE_HISTORY_LIMIT,
  SqliteStore,
  StorageError,
} from './store.js';

/** 当前测试创建且需要清理的临时目录。 */
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** 创建文件型测试数据库及其存储门面。 */
async function createStore() {
  const root = await mkdtemp(join(tmpdir(), 'clash-sentinel-storage-'));
  temporaryRoots.push(root);
  const databasePath = join(root, 'clash-sentinel.db');
  return { root, databasePath, store: new SqliteStore({ databasePath }) };
}

/** 创建一个可持久化的健康快照。 */
function healthSnapshot(when: string): HealthSnapshot {
  return {
    status: 'entry_suspected',
    profile: { uid: 'profile-main', name: '当前订阅' },
    lock: {
      locked: true,
      domain: 'entry.example.test',
      ip: '198.51.100.20',
    },
    internetSuccess: 3,
    internetTotal: 3,
    consecutiveFailures: 2,
    recommendedIp: '192.0.2.10',
    autoSwitchCooldownUntil: new Date(Date.parse(when) + 300_000).toISOString(),
    updatedAt: when,
  };
}

/** 创建一个可持久化的站点探测结果。 */
function siteResult(
  target: SiteResult['target'],
  checkedAt: string,
): SiteResult {
  return {
    target,
    reachable: true,
    httpStatus: 204,
    durationMs: 42.5,
    errorType: null,
    checkedAt,
    serviceStatus: target === 'openai_status' ? 'operational' : null,
    incidentSummary: null,
  };
}

/** 创建一个包含合格和不合格候选的诊断结果。 */
function diagnosis(generatedAt: string): DiagnosisResult {
  return {
    status: 'testable',
    generatedAt,
    profile: { uid: 'profile-main', name: '当前订阅' },
    domain: 'entry.example.test',
    skipReason: null,
    detail: null,
    testedPorts: [7001, 9051],
    testRounds: 5,
    candidates: [
      {
        ip: '198.51.100.20',
        eligible: true,
        success: 10,
        total: 10,
        successRate: 100,
        averageMs: 12.5,
        failedPorts: [],
        sources: ['system'],
      },
      {
        ip: '192.0.2.10',
        eligible: false,
        success: 5,
        total: 10,
        successRate: 50,
        averageMs: 20,
        failedPorts: [7001],
        sources: ['authority:ns.example.test'],
      },
    ],
    recommendedIp: '198.51.100.20',
  };
}

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
    ]);
    database.close();
  });

  test('故障迁移回滚其全部结构和版本记录', () => {
    const database = new Database(':memory:');
    const failing: Migration = {
      version: 3,
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
    ).toEqual([{ version: 1 }, { version: 2 }]);
    database.close();
  });

  test('启用外键约束并拒绝不存在的任务关联', async () => {
    const setup = await createStore();
    expect(() =>
      setup.store.appendEvent({
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

describe('SqliteStore', () => {
  test('默认策略安全且更新后可恢复', async () => {
    const setup = await createStore();
    expect(setup.store.getSettings()).toMatchObject({
      checkIntervalMs: 60_000,
      requestTimeoutMs: 5_000,
      entryFailureThreshold: 3,
      autoSwitchCooldownMs: 300_000,
      monitoringEnabled: true,
      autoSwitchEnabled: false,
      autoSwitchProfileUid: null,
    });
    setup.store.updateSettings({
      checkIntervalMs: 120_000,
      autoSwitchEnabled: true,
      autoSwitchProfileUid: 'profile-main',
    });
    setup.store.close();
    const reopened = new SqliteStore({ databasePath: setup.databasePath });
    expect(reopened.getSettings()).toMatchObject({
      checkIntervalMs: 120_000,
      autoSwitchEnabled: true,
      autoSwitchProfileUid: 'profile-main',
    });
    expect(() =>
      reopened.updateSettings({
        autoSwitchEnabled: true,
        autoSwitchProfileUid: null,
      }),
    ).toThrow();
    reopened.close();
  });

  test('重启后恢复快照、站点、诊断、事件和任务并中断 running 任务', async () => {
    const setup = await createStore();
    const now = new Date('2026-09-08T04:00:00.000Z').toISOString();
    setup.store.upsertHealthSnapshot(healthSnapshot(now));
    setup.store.appendSiteResult(siteResult('google', now));
    setup.store.replaceDiagnosis(diagnosis(now));
    setup.store.replaceDiagnosis({
      ...diagnosis(now),
      candidates: [diagnosis(now).candidates[0]!],
    });
    const running = setup.store.startTask(
      setup.store.createTask('diagnose', { profileUid: 'profile-main' }).id,
    );
    const completed = setup.store.startTask(
      setup.store.createTask('health_check').id,
    );
    setup.store.completeTask(completed.id, { status: 'healthy' });
    const failed = setup.store.createTask('apply');
    setup.store.failTask(
      failed.id,
      'APPLY_FAILED',
      '应用失败但已经安全恢复',
      'recovered',
    );
    setup.store.appendEvent({
      type: 'diagnosis_completed',
      severity: 'info',
      retention: 'critical',
      summary: '严格诊断完成',
      taskId: running.id,
      profileUid: 'profile-main',
      occurredAt: now,
    });
    setup.store.close();

    const reopened = new SqliteStore({ databasePath: setup.databasePath });
    expect(reopened.getHealthSnapshot()).toEqual(healthSnapshot(now));
    expect(reopened.getSiteSnapshot('google')).toEqual(
      siteResult('google', now),
    );
    expect(reopened.getDiagnosis()).toMatchObject({
      status: 'testable',
      recommendedIp: '198.51.100.20',
      candidates: expect.arrayContaining([
        expect.objectContaining({ ip: '198.51.100.20', eligible: true }),
      ]),
    });
    expect(reopened.getDiagnosis()?.candidates).toHaveLength(1);
    expect(reopened.getTask(running.id)).toMatchObject({
      status: 'interrupted',
      errorCode: 'SERVICE_RESTARTED',
      recoveryStatus: null,
    });
    expect(reopened.getTask(completed.id)?.status).toBe('succeeded');
    expect(reopened.getTask(failed.id)).toMatchObject({
      status: 'failed',
      errorCode: 'APPLY_FAILED',
      recoveryStatus: 'recovered',
    });
    expect(reopened.listEvents()).toHaveLength(1);
    reopened.close();
  });

  test('任务状态转换拒绝重复完成和不存在任务', async () => {
    const setup = await createStore();
    const task = setup.store.startTask(setup.store.createTask('apply').id);
    setup.store.completeTask(task.id, { status: 'applied' });
    expect(() => setup.store.completeTask(task.id)).toThrow(StorageError);
    expect(() =>
      setup.store.startTask('00000000-0000-4000-8000-000000000000'),
    ).toThrow(StorageError);
    setup.store.close();
  });

  test('配置任务重启中断标记未知且恢复状态受约束', async () => {
    const setup = await createStore();
    const running = setup.store.startTask(setup.store.createTask('apply').id);
    setup.store.close();
    const reopened = new SqliteStore({ databasePath: setup.databasePath });
    expect(reopened.getTask(running.id)).toMatchObject({
      status: 'interrupted',
      recoveryStatus: 'unknown',
    });
    const failed = reopened.createTask('reset');
    expect(() =>
      reopened.failTask(failed.id, 'RESET_FAILED', '失败', 'invalid' as never),
    ).toThrow();
    reopened.close();
  });

  test('数量清理保留当前快照和最近历史', async () => {
    const setup = await createStore();
    const base = Date.parse('2026-09-08T00:00:00.000Z');
    for (let index = 0; index <= SITE_HISTORY_LIMIT; index += 1)
      setup.store.appendSiteResult(
        siteResult('github', new Date(base + index).toISOString()),
      );
    for (let index = 0; index <= ORDINARY_EVENT_LIMIT; index += 1)
      setup.store.appendEvent({
        type: 'ordinary_test',
        severity: 'info',
        retention: 'ordinary',
        summary: `普通事件 ${index}`,
        occurredAt: new Date(base + index).toISOString(),
      });
    for (let index = 0; index <= CRITICAL_EVENT_LIMIT; index += 1)
      setup.store.appendEvent({
        type: 'critical_test',
        severity: 'critical',
        retention: 'critical',
        summary: `关键事件 ${index}`,
        occurredAt: new Date(base + index).toISOString(),
      });
    setup.store.pruneHistory();
    const latestSite = setup.store.getSiteSnapshot('github');
    setup.store.close();

    const database = new Database(setup.databasePath, { readonly: true });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM site_history WHERE target = 'github'",
        )
        .get(),
    ).toEqual({ count: SITE_HISTORY_LIMIT });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM events WHERE retention = 'ordinary'",
        )
        .get(),
    ).toEqual({ count: ORDINARY_EVENT_LIMIT });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM events WHERE retention = 'critical'",
        )
        .get(),
    ).toEqual({ count: CRITICAL_EVENT_LIMIT });
    database.close();
    expect(latestSite?.checkedAt).toBe(
      new Date(base + SITE_HISTORY_LIMIT).toISOString(),
    );
  });

  test('敏感字段、完整订阅和本机路径不会写入数据库', async () => {
    const setup = await createStore();
    const task = setup.store.createTask('apply', {
      controllerSecret: 'super-secret',
      authorizationHeader: 'Bearer private-token',
      nested: { apiToken: 'nested-token' },
      path: '/Users/example/Library/Application Support/private.yaml',
      payload: 'proxies:\n- name: secret-node\nproxy-groups: []',
    });
    setup.store.appendEvent({
      type: 'safety_test',
      severity: 'warning',
      retention: 'ordinary',
      summary: '文件 /Users/example/private.yaml 处理失败',
      details: { password: 'plain-password' },
    });
    expect(setup.store.getTask(task.id)?.input).toEqual({
      controllerSecret: '[敏感字段已脱敏]',
      authorizationHeader: '[敏感字段已脱敏]',
      nested: { apiToken: '[敏感字段已脱敏]' },
      path: '[路径已脱敏]',
      payload: '[订阅内容已脱敏]',
    });
    setup.store.close();
    const raw = (await readFile(setup.databasePath)).toString('utf8');
    for (const forbidden of [
      'super-secret',
      'private-token',
      'nested-token',
      'secret-node',
      'plain-password',
      '/Users/example',
    ])
      expect(raw).not.toContain(forbidden);
  });

  test('关闭脱敏后新任务、事件和错误文本保持原值且重开不改写历史', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clash-sentinel-storage-raw-'));
    temporaryRoots.push(root);
    const databasePath = join(root, 'clash-sentinel.db');
    const store = new SqliteStore({
      databasePath,
      redactSensitiveData: false,
    });
    const queued = store.createTask('apply', {
      controllerSecret: 'super-secret',
      path: '/Users/example/private.yaml',
      payload: 'proxies:\n- name: secret-node',
    });
    const completed = store.startTask(store.createTask('diagnose').id);
    store.completeTask(completed.id, { apiToken: 'result-token' });
    const failed = store.createTask('reset');
    store.failTask(
      failed.id,
      'RESET_FAILED',
      '读取 /Users/example/private.yaml 时 token=error-secret',
    );
    store.appendEvent({
      type: 'raw_storage_test',
      severity: 'warning',
      retention: 'ordinary',
      summary: '文件 /Users/example/private.yaml 处理失败',
      details: { password: 'plain-password' },
    });
    expect(store.getTask(queued.id)?.input).toEqual({
      controllerSecret: 'super-secret',
      path: '/Users/example/private.yaml',
      payload: 'proxies:\n- name: secret-node',
    });
    expect(store.getTask(completed.id)?.result).toEqual({
      apiToken: 'result-token',
    });
    expect(store.getTask(failed.id)?.errorMessage).toContain('error-secret');
    expect(store.listEvents()[0]).toMatchObject({
      summary: '文件 /Users/example/private.yaml 处理失败',
      details: { password: 'plain-password' },
    });
    store.close();

    const reopened = new SqliteStore({
      databasePath,
      redactSensitiveData: true,
    });
    expect(reopened.getTask(queued.id)?.input).toMatchObject({
      controllerSecret: 'super-secret',
      path: '/Users/example/private.yaml',
    });
    expect(reopened.listEvents()[0]?.details).toEqual({
      password: 'plain-password',
    });
    reopened.close();
  });

  test('关闭脱敏仍拒绝循环引用、不可序列化值和超限 JSON', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clash-sentinel-storage-raw-'));
    temporaryRoots.push(root);
    const store = new SqliteStore({
      databasePath: join(root, 'clash-sentinel.db'),
      redactSensitiveData: false,
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => store.createTask('apply', cyclic as StoredJsonObject)).toThrow(
      StorageError,
    );
    expect(() =>
      store.createTask('apply', {
        invalid: BigInt(1),
      } as unknown as StoredJsonObject),
    ).toThrow(StorageError);
    expect(() =>
      store.createTask('apply', {
        content: 'x'.repeat(33 * 1024),
      }),
    ).toThrow(/32 KiB/);
    store.close();
  });
});
