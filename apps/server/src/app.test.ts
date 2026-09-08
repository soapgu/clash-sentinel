import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import request from 'supertest';
import type {
  DiagnosisResult,
  HealthSnapshot,
  LegacyStatus,
} from '@clash-sentinel/shared';
import { createApp } from './app.js';
import { LegacyAdapterError } from './legacy/adapter.js';
import { TaskService, type LegacyOperations } from './services/task-service.js';
import { SqliteStore } from './storage/store.js';

/** 当前测试创建且需要关闭、清理的隔离运行时。 */
const setups: Array<{
  root: string;
  store: SqliteStore;
  taskService: TaskService;
}> = [];

afterEach(async () => {
  for (const setup of setups.splice(0)) {
    setup.taskService.stopAccepting();
    await setup.taskService.waitForIdle();
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

/** 返回测试统一使用的当前订阅和锁定状态。 */
function legacyStatus(): LegacyStatus {
  return {
    profile: { uid: 'profile-main', name: '演示订阅' },
    lock: {
      locked: true,
      domain: 'entry.example.test',
      ip: '198.51.100.20',
    },
    controllerAvailable: true,
    report: null,
    health: null,
  };
}

/** 返回包含一个合格候选的虚构诊断结果。 */
function diagnosis(): DiagnosisResult {
  return {
    status: 'testable',
    generatedAt: '2026-09-08T04:00:00.000Z',
    profile: { uid: 'profile-main', name: '演示订阅' },
    domain: 'entry.example.test',
    skipReason: null,
    detail: null,
    testedPorts: [7001],
    testRounds: 2,
    candidates: [
      {
        ip: '198.51.100.20',
        eligible: true,
        success: 2,
        total: 2,
        successRate: 100,
        averageMs: 12,
        failedPorts: [],
        sources: ['system'],
      },
    ],
    recommendedIp: '198.51.100.20',
  };
}

/** 创建临时 SQLite、伪造 LegacyAdapter 和待测 Koa 应用。 */
async function createSetup(overrides: Partial<LegacyOperations> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'clash-sentinel-api-'));
  const store = new SqliteStore({ databasePath: join(root, 'api.db') });
  const adapter: LegacyOperations = {
    getStatus: vi.fn(async () => legacyStatus()),
    diagnose: vi.fn(async () => diagnosis()),
    healthCheck: vi.fn(async () => ({
      status: 'healthy',
      checkedAt: '2026-09-08 12:00:00 +0800',
      internetSuccess: 3,
      internetTotal: 3,
      currentIp: '198.51.100.20',
      consecutiveFailures: 0,
      recommendedIp: null,
    })),
    applyIp: vi.fn(async (ip: string) => ({
      status: 'applied',
      domain: 'entry.example.test',
      ip,
      message: '应用成功',
    })),
    resetLock: vi.fn(async () => ({
      status: 'reset',
      domain: 'entry.example.test',
      ip: null,
      message: '解除成功',
    })),
    rollback: vi.fn(async () => ({
      status: 'rolled_back',
      domain: 'entry.example.test',
      ip: '198.51.100.20',
      message: '回滚成功',
    })),
    ...overrides,
  };
  const taskService = new TaskService({ store, adapter });
  setups.push({ root, store, taskService });
  return {
    store,
    adapter,
    taskService,
    app: createApp({ store, taskService, logger: () => undefined }),
  };
}

test('健康、空快照和固定站点接口遵守只读契约', async () => {
  const setup = await createSetup();
  expect((await request(setup.app.callback()).get('/api/health')).body).toEqual(
    {
      ok: true,
      data: { service: 'clash-sentinel', status: 'ok' },
    },
  );
  expect(
    (await request(setup.app.callback()).get('/api/status')).body.data.snapshot,
  ).toBeNull();
  expect(
    (await request(setup.app.callback()).get('/api/sites')).body.data.sites,
  ).toEqual({
    baidu: null,
    taobao: null,
    tencent: null,
    google: null,
    github: null,
    openai_status: null,
  });
  await request(setup.app.callback()).get('/api/candidates').expect(200);
  await request(setup.app.callback()).get('/api/settings').expect(200);
  expect(setup.adapter.getStatus).not.toHaveBeenCalled();
  expect(setup.store.listTasks()).toHaveLength(0);
  expect(setup.store.countEvents()).toBe(0);
});

test('事件分页返回 total 并拒绝未知或越界查询', async () => {
  const setup = await createSetup();
  setup.store.appendEvent({
    type: 'test',
    severity: 'info',
    retention: 'ordinary',
    summary: '测试事件',
  });
  const response = await request(setup.app.callback()).get(
    '/api/events?limit=1&offset=0',
  );
  expect(response.body.data).toMatchObject({ limit: 1, offset: 0, total: 1 });
  expect(response.body.data.items).toHaveLength(1);
  await request(setup.app.callback()).get('/api/events?limit=101').expect(400);
  const unknown = await request(setup.app.callback()).get('/api/events?q=x');
  expect(unknown.body.error.code).toBe('VALIDATION_ERROR');
});

test('任务路径和未知 API 使用统一错误结构', async () => {
  const setup = await createSetup();
  const invalid = await request(setup.app.callback()).get('/api/tasks/nope');
  expect(invalid.status).toBe(400);
  expect(invalid.body.requestId).toBe(invalid.headers['x-request-id']);
  const missing = await request(setup.app.callback()).get(
    '/api/tasks/00000000-0000-4000-8000-000000000000',
  );
  expect(missing.body.error.code).toBe('NOT_FOUND');
  const route = await request(setup.app.callback()).get('/api/missing');
  expect(route.body.error.code).toBe('NOT_FOUND');
});

test('设置完整更新并校验自动切换锁定和订阅', async () => {
  const setup = await createSetup();
  const base = {
    checkIntervalMs: 60_000,
    requestTimeoutMs: 5_000,
    entryFailureThreshold: 3,
    autoSwitchCooldownMs: 300_000,
    monitoringEnabled: true,
    autoSwitchEnabled: false,
    autoSwitchProfileUid: '会被清空',
  };
  const disabled = await request(setup.app.callback())
    .put('/api/settings')
    .send(base);
  expect(disabled.status).toBe(200);
  expect(disabled.body.data.settings.autoSwitchProfileUid).toBeNull();
  const unlocked: HealthSnapshot = {
    status: 'unknown',
    profile: { uid: 'profile-main', name: '演示订阅' },
    lock: { locked: false },
    internetSuccess: null,
    internetTotal: null,
    consecutiveFailures: 0,
    recommendedIp: null,
    autoSwitchCooldownUntil: null,
    updatedAt: new Date().toISOString(),
  };
  setup.store.upsertHealthSnapshot(unlocked);
  const noLock = await request(setup.app.callback())
    .put('/api/settings')
    .send({
      ...base,
      autoSwitchEnabled: true,
      autoSwitchProfileUid: 'profile-main',
    });
  expect(noLock.body.error.code).toBe('AUTO_SWITCH_REQUIRES_LOCK');
  setup.store.upsertHealthSnapshot({
    ...unlocked,
    lock: { locked: true, domain: 'entry.example.test', ip: '198.51.100.20' },
  });
  const mismatch = await request(setup.app.callback())
    .put('/api/settings')
    .send({ ...base, autoSwitchEnabled: true, autoSwitchProfileUid: 'other' });
  expect(mismatch.body.error.code).toBe('PROFILE_MISMATCH');
  const enabled = await request(setup.app.callback())
    .put('/api/settings')
    .send({
      ...base,
      autoSwitchEnabled: true,
      autoSwitchProfileUid: 'profile-main',
    });
  expect(enabled.status).toBe(200);
  await request(setup.app.callback())
    .put('/api/settings')
    .send({ ...base, extraPath: '/private/secret' })
    .expect(400);
});

test('诊断和 apply 异步执行并持久化任务结果', async () => {
  const setup = await createSetup();
  const diagnosed = await request(setup.app.callback())
    .post('/api/actions/diagnose')
    .send({});
  expect(diagnosed.status).toBe(202);
  await setup.taskService.waitForIdle();
  expect(setup.store.getDiagnosis()?.candidates[0]?.eligible).toBe(true);
  const applied = await request(setup.app.callback())
    .post('/api/actions/apply')
    .send({ ip: '198.51.100.20' });
  await setup.taskService.waitForIdle();
  const task = await request(setup.app.callback()).get(
    `/api/tasks/${applied.body.data.taskId}`,
  );
  expect(task.body.data.task.status).toBe('succeeded');
  expect(setup.adapter.applyIp).toHaveBeenCalledWith('198.51.100.20');
  expect(setup.store.getHealthSnapshot()?.status).toBe('unknown');
});

test('apply 拒绝无诊断、非法候选和注入输入', async () => {
  const setup = await createSetup();
  const none = await request(setup.app.callback())
    .post('/api/actions/apply')
    .send({ ip: '198.51.100.20' });
  expect(none.body.error.code).toBe('NO_DIAGNOSIS');
  setup.store.replaceDiagnosis(diagnosis());
  for (const ip of [
    '--help',
    '198.51.100.20;touch /tmp/x',
    '198.51.100.20\n--x',
  ])
    await request(setup.app.callback())
      .post('/api/actions/apply')
      .send({ ip })
      .expect(400);
  const missing = await request(setup.app.callback())
    .post('/api/actions/apply')
    .send({ ip: '192.0.2.10' });
  expect(missing.body.error.code).toBe('INVALID_CANDIDATE');
  expect(setup.adapter.applyIp).not.toHaveBeenCalled();
});

test('全局动作槽拒绝并发提交并公开活动任务 ID', async () => {
  let release!: (value: DiagnosisResult) => void;
  const pending = new Promise<DiagnosisResult>((resolve) => {
    release = resolve;
  });
  const setup = await createSetup({ diagnose: vi.fn(() => pending) });
  const first = await request(setup.app.callback())
    .post('/api/actions/diagnose')
    .send({});
  const conflict = await request(setup.app.callback())
    .post('/api/actions/health-check')
    .send({});
  expect(conflict.status).toBe(409);
  expect(conflict.body.error.details.activeTaskId).toBe(first.body.data.taskId);
  release(diagnosis());
  await setup.taskService.waitForIdle();
});

test('后台稳定错误写入失败任务且 reset 关闭自动切换', async () => {
  const setup = await createSetup({
    rollback: vi.fn(async () => {
      throw new LegacyAdapterError('NO_BACKUP', '没有可回滚的成功应用');
    }),
  });
  const rollback = await request(setup.app.callback())
    .post('/api/actions/rollback')
    .send({});
  await setup.taskService.waitForIdle();
  expect(setup.store.getTask(rollback.body.data.taskId)).toMatchObject({
    status: 'failed',
    errorCode: 'NO_BACKUP',
  });
  setup.store.upsertHealthSnapshot({
    status: 'healthy',
    profile: legacyStatus().profile,
    lock: legacyStatus().lock,
    internetSuccess: 3,
    internetTotal: 3,
    consecutiveFailures: 0,
    recommendedIp: null,
    autoSwitchCooldownUntil: '2026-09-08T04:05:00.000Z',
    updatedAt: '2026-09-08T04:00:00.000Z',
  });
  setup.store.updateSettings({
    autoSwitchEnabled: true,
    autoSwitchProfileUid: 'profile-main',
  });
  await request(setup.app.callback()).post('/api/actions/reset').send({});
  await setup.taskService.waitForIdle();
  expect(setup.store.getSettings()).toMatchObject({
    autoSwitchEnabled: false,
    autoSwitchProfileUid: null,
  });
  expect(setup.store.getHealthSnapshot()).toMatchObject({
    status: 'unknown',
    autoSwitchCooldownUntil: null,
  });
});

test('非法 JSON、请求超时和内部异常不泄露原文', async () => {
  const setup = await createSetup();
  const invalid = await request(setup.app.callback())
    .put('/api/settings')
    .set('Content-Type', 'application/json')
    .send('{bad');
  expect(invalid.body.error.code).toBe('INVALID_JSON');
  const timeoutApp = createApp({
    store: setup.store,
    taskService: setup.taskService,
    requestTimeoutMs: 5,
    logger: () => undefined,
  });
  timeoutApp.use(async (ctx) => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    ctx.body = { secret: '/private/value' };
  });
  const timeout = await request(timeoutApp.callback()).get('/slow');
  expect(timeout.body.error.code).toBe('REQUEST_TIMEOUT');
  vi.spyOn(setup.store, 'getSettings').mockImplementation(() => {
    throw new Error('/private/secret');
  });
  const internal = await request(setup.app.callback()).get('/api/settings');
  expect(internal.status).toBe(500);
  expect(JSON.stringify(internal.body)).not.toContain('/private');
});
