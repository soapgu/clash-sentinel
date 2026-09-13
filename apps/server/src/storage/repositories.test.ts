import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import {
  CRITICAL_EVENT_LIMIT,
  ORDINARY_EVENT_LIMIT,
} from './event-repository.js';
import { SITE_HISTORY_LIMIT } from './site-repository.js';
import { SqliteStore } from './store.js';
import {
  createStore,
  diagnosis,
  healthSnapshot,
  siteResult,
} from '../../test-support/storage.js';

describe('领域仓储', () => {
  test('默认策略安全且更新后可恢复', async () => {
    const setup = await createStore();
    expect(setup.store.settings.getSettings()).toMatchObject({
      checkIntervalMs: 60_000,
      requestTimeoutMs: 5_000,
      entryFailureThreshold: 3,
      autoSwitchCooldownMs: 300_000,
      monitoringEnabled: true,
      autoSwitchEnabled: false,
      autoSwitchProfileUid: null,
    });
    setup.store.settings.updateSettings({
      checkIntervalMs: 120_000,
      autoSwitchEnabled: true,
      autoSwitchProfileUid: 'profile-main',
    });
    setup.store.close();
    const reopened = new SqliteStore({ databasePath: setup.databasePath });
    expect(reopened.settings.getSettings()).toMatchObject({
      checkIntervalMs: 120_000,
      autoSwitchEnabled: true,
      autoSwitchProfileUid: 'profile-main',
    });
    expect(() =>
      reopened.settings.updateSettings({
        autoSwitchEnabled: true,
        autoSwitchProfileUid: null,
      }),
    ).toThrow();
    reopened.close();
  });

  test('重启后恢复快照、站点、诊断、事件和任务并中断 running 任务', async () => {
    const setup = await createStore();
    const now = new Date('2026-09-08T04:00:00.000Z').toISOString();
    setup.store.health.upsertHealthSnapshot(healthSnapshot(now));
    setup.store.sites.appendSiteResult(siteResult('google', now));
    setup.store.diagnoses.replaceDiagnosis(diagnosis(now));
    setup.store.diagnoses.replaceDiagnosis({
      ...diagnosis(now),
      candidates: [diagnosis(now).candidates[0]!],
    });
    const running = setup.store.tasks.startTask(
      setup.store.tasks.createTask('diagnose', { profileUid: 'profile-main' })
        .id,
    );
    const completed = setup.store.tasks.startTask(
      setup.store.tasks.createTask('health_check').id,
    );
    setup.store.tasks.completeTask(completed.id, { status: 'healthy' });
    const failed = setup.store.tasks.createTask('apply');
    setup.store.tasks.failTask(
      failed.id,
      'APPLY_FAILED',
      '应用失败但已经安全恢复',
      'recovered',
    );
    setup.store.events.appendEvent({
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
    reopened.tasks.recoverInterruptedTasks();
    expect(reopened.health.getHealthSnapshot()).toEqual(healthSnapshot(now));
    expect(reopened.sites.getSiteSnapshot('google')).toEqual(
      siteResult('google', now),
    );
    expect(reopened.diagnoses.getDiagnosis()).toMatchObject({
      status: 'testable',
      recommendedIp: '198.51.100.20',
      candidates: expect.arrayContaining([
        expect.objectContaining({ ip: '198.51.100.20', eligible: true }),
      ]),
    });
    expect(reopened.diagnoses.getDiagnosis()?.candidates).toHaveLength(1);
    expect(reopened.tasks.getTask(running.id)).toMatchObject({
      status: 'interrupted',
      errorCode: 'SERVICE_RESTARTED',
      recoveryStatus: null,
    });
    expect(reopened.tasks.getTask(completed.id)?.status).toBe('succeeded');
    expect(reopened.tasks.getTask(failed.id)).toMatchObject({
      status: 'failed',
      errorCode: 'APPLY_FAILED',
      recoveryStatus: 'recovered',
    });
    expect(reopened.events.listEvents()).toHaveLength(1);
    reopened.close();
  });

  test('数量清理保留当前快照和最近历史', async () => {
    const setup = await createStore();
    const base = Date.parse('2026-09-08T00:00:00.000Z');
    for (let index = 0; index <= SITE_HISTORY_LIMIT; index += 1)
      setup.store.sites.appendSiteResult(
        siteResult('github', new Date(base + index).toISOString()),
      );
    for (let index = 0; index <= ORDINARY_EVENT_LIMIT; index += 1)
      setup.store.events.appendEvent({
        type: 'ordinary_test',
        severity: 'info',
        retention: 'ordinary',
        summary: `普通事件 ${index}`,
        occurredAt: new Date(base + index).toISOString(),
      });
    for (let index = 0; index <= CRITICAL_EVENT_LIMIT; index += 1)
      setup.store.events.appendEvent({
        type: 'critical_test',
        severity: 'critical',
        retention: 'critical',
        summary: `关键事件 ${index}`,
        occurredAt: new Date(base + index).toISOString(),
      });
    setup.store.sites.pruneHistory();
    setup.store.events.pruneHistory();
    const latestSite = setup.store.sites.getSiteSnapshot('github');
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
});
