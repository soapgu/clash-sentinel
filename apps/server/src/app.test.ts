import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import request from 'supertest';
import type {
  DiagnosisResult,
  HealthSnapshot,
  LegacyStatus,
  MonitoringSnapshot,
  StreamNotification,
} from '@clash-sentinel/shared';
import { createApp } from './app.js';
import { LegacyAdapterError } from './legacy/adapter.js';
import { TaskService, type LegacyOperations } from './services/task-service.js';
import { OperationCoordinator } from './services/operation-coordinator.js';
import { StatusNotificationCenter } from './services/status-notifier.js';
import { SqliteStore } from './storage/store.js';
import {
  noopLogger,
  type AppLogger,
  type LogLevel,
  type LogMetadata,
  type LogScope,
} from './logging.js';

interface RecordedLog {
  level: LogLevel;
  scope: LogScope;
  message: string;
  metadata: LogMetadata;
}

function recordingLogger(entries: RecordedLog[]): AppLogger {
  const record =
    (level: LogLevel) =>
    (scope: LogScope, message: string, metadata: LogMetadata = {}) => {
      entries.push({ level, scope, message, metadata });
    };
  return {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    close: async () => undefined,
  };
}

/** 当前测试创建且需要关闭、清理的隔离运行时。 */
const setups: Array<{
  root: string;
  store: SqliteStore;
  taskService: TaskService;
  notifier: StatusNotificationCenter;
}> = [];

afterEach(async () => {
  for (const setup of setups.splice(0)) {
    setup.taskService.stopAccepting();
    await setup.taskService.waitForIdle();
    setup.notifier.close();
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
async function createSetup(
  overrides: Partial<LegacyOperations> = {},
  logger: AppLogger = noopLogger,
) {
  const root = await mkdtemp(join(tmpdir(), 'clash-sentinel-api-'));
  const store = new SqliteStore({
    databasePath: join(root, 'api.db'),
    logger,
  });
  const adapter: LegacyOperations = {
    getStatus: vi.fn(async () => legacyStatus()),
    diagnose: vi.fn(async () => diagnosis()),
    readLatestDiagnosis: vi.fn(async () => diagnosis()),
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
  const coordinator = new OperationCoordinator();
  const notifier = new StatusNotificationCenter(
    () => new Date('2026-09-09T04:00:00.000Z'),
    logger,
  );
  const healthCheck = {
    run: vi.fn(async () => {
      const snapshot = store.upsertHealthSnapshot({
        status: 'healthy',
        profile: legacyStatus().profile,
        lock: legacyStatus().lock,
        internetSuccess: 3,
        internetTotal: 3,
        consecutiveFailures: 0,
        recommendedIp: null,
        autoSwitchCooldownUntil:
          store.getHealthSnapshot()?.autoSwitchCooldownUntil ?? null,
        updatedAt: '2026-09-08T04:00:00.000Z',
      });
      return {
        snapshot,
        changes: {
          statusUpdated: true,
          sitesUpdated: true,
          candidatesUpdated: false,
          eventAppended: false,
        },
      };
    }),
  };
  const taskService = new TaskService({
    store,
    adapter,
    healthCheck,
    coordinator,
    notifier,
    logger,
  });
  const scheduler = {
    getSnapshot: vi.fn<() => MonitoringSnapshot>(() => ({
      enabled: true as const,
      state: 'waiting' as const,
      lastStartedAt: null,
      lastCompletedAt: null,
      nextRunAt: null,
    })),
  };
  setups.push({ root, store, taskService, notifier });
  return {
    store,
    adapter,
    coordinator,
    taskService,
    scheduler,
    notifier,
    app: createApp({
      store,
      taskService,
      scheduler,
      notifier,
      logger,
    }),
  };
}

/** 累积读取 SSE 文本直到出现目标内容。 */
async function readStreamUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expected: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let output = '';
  while (!output.includes(expected)) {
    const chunk = await reader.read();
    if (chunk.done) break;
    output += decoder.decode(chunk.value, { stream: true });
  }
  return output;
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

test('定时监测接口返回内存快照且重复读取没有副作用', async () => {
  const setup = await createSetup();
  const states: MonitoringSnapshot[] = [
    {
      enabled: true,
      state: 'waiting',
      lastStartedAt: null,
      lastCompletedAt: null,
      nextRunAt: null,
    },
    {
      enabled: true,
      state: 'waiting',
      lastStartedAt: '2026-09-09T04:00:00.000Z',
      lastCompletedAt: '2026-09-09T04:00:15.000Z',
      nextRunAt: '2026-09-09T04:01:15.000Z',
    },
    {
      enabled: true,
      state: 'running',
      lastStartedAt: '2026-09-09T04:01:15.000Z',
      lastCompletedAt: '2026-09-09T04:00:15.000Z',
      nextRunAt: null,
    },
    {
      enabled: false,
      state: 'running',
      lastStartedAt: '2026-09-09T04:01:15.000Z',
      lastCompletedAt: '2026-09-09T04:00:15.000Z',
      nextRunAt: null,
    },
    {
      enabled: false,
      state: 'disabled',
      lastStartedAt: '2026-09-09T04:01:15.000Z',
      lastCompletedAt: '2026-09-09T04:01:30.000Z',
      nextRunAt: null,
    },
  ];
  for (const expected of states) {
    setup.scheduler.getSnapshot.mockReturnValueOnce(expected);
    expect(
      (await request(setup.app.callback()).get('/api/monitoring')).body.data
        .monitoring,
    ).toEqual(expected);
  }
  expect(setup.scheduler.getSnapshot).toHaveBeenCalledTimes(states.length);
  expect(setup.adapter.getStatus).not.toHaveBeenCalled();
  expect(setup.store.listTasks()).toHaveLength(0);
  expect(setup.store.countEvents()).toBe(0);
});

test('SSE 建连同步、保活且不受普通 API 超时限制', async () => {
  const logs: RecordedLog[] = [];
  const logger = recordingLogger(logs);
  const setup = await createSetup({}, logger);
  logs.length = 0;
  const streamApp = createApp({
    store: setup.store,
    taskService: setup.taskService,
    scheduler: setup.scheduler,
    notifier: setup.notifier,
    requestTimeoutMs: 5,
    streamHeartbeatMs: 10,
    logger,
  });
  const server = streamApp.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const controller = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/stream`,
      {
        headers: { 'Last-Event-ID': '999' },
        signal: controller.signal,
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toBe(
      'no-cache, no-transform',
    );
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    const reader = response.body!.getReader();
    const initial = await readStreamUntil(reader, '\n\n');
    expect(initial).toContain('event: invalidate');
    expect(initial).toContain('"reason":"sync"');
    expect(initial).not.toContain('999');

    const heartbeat = await readStreamUntil(reader, ': keepalive');
    expect(heartbeat).toContain(': keepalive');
    setup.notifier.publish('monitoring_started', ['monitoring']);
    const update = await readStreamUntil(reader, 'monitoring_started');
    expect(update).toContain('event: invalidate');
    expect(update).toContain('"resources":["monitoring"]');
    await reader.cancel();
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(setup.notifier.getSubscriberCount()).toBe(0);
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'debug',
          scope: 'sse:stream',
          message: 'connected',
        }),
        expect.objectContaining({
          level: 'debug',
          scope: 'sse:stream',
          message: 'disconnected',
        }),
      ]),
    );
    expect(logs.some((entry) => entry.message.includes('keepalive'))).toBe(
      false,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('SSE 多客户端隔离且通知中心关闭会结束全部长连接', async () => {
  const setup = await createSetup();
  const server = setup.app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/api/stream`;
    const [firstResponse, secondResponse] = await Promise.all([
      fetch(url),
      fetch(url),
    ]);
    const first = firstResponse.body!.getReader();
    const second = secondResponse.body!.getReader();
    expect(await readStreamUntil(first, '\n\n')).toContain('"reason":"sync"');
    expect(await readStreamUntil(second, '\n\n')).toContain('"reason":"sync"');
    expect(setup.notifier.getSubscriberCount()).toBe(2);

    setup.notifier.close();
    expect((await first.read()).done).toBe(true);
    expect((await second.read()).done).toBe(true);
    expect(setup.notifier.getSubscriberCount()).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('站点接口动态标记过期且定时检测占槽时拒绝手动动作', async () => {
  const setup = await createSetup();
  setup.store.appendSiteResult({
    target: 'baidu',
    reachable: true,
    httpStatus: 200,
    durationMs: 20,
    errorType: null,
    checkedAt: '2026-09-09T04:00:00.000Z',
    serviceStatus: null,
    incidentSummary: null,
  });
  const boundaryApp = createApp({
    store: setup.store,
    taskService: setup.taskService,
    scheduler: setup.scheduler,
    notifier: setup.notifier,
    now: () => Date.parse('2026-09-09T04:02:00.001Z'),
    logger: noopLogger,
  });
  const sites = await request(boundaryApp.callback()).get('/api/sites');
  expect(sites.body.data.sites.baidu.stale).toBe(true);
  expect(setup.store.getSiteSnapshot('baidu')).not.toHaveProperty('stale');

  const lease = setup.coordinator.tryAcquireScheduled()!;
  const conflict = await request(setup.app.callback())
    .post('/api/actions/diagnose')
    .send({});
  expect(conflict.status).toBe(409);
  expect(conflict.body.error.details).toEqual({
    activeOperation: 'scheduled_health',
  });
  lease.release();
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

test('访问、设置和异步任务使用统一日志等级及关联键', async () => {
  const logs: RecordedLog[] = [];
  const setup = await createSetup({}, recordingLogger(logs));
  logs.length = 0;

  await request(setup.app.callback()).get('/api/status').expect(200);
  await request(setup.app.callback())
    .put('/api/settings')
    .send({
      checkIntervalMs: 120_000,
      requestTimeoutMs: 5_000,
      entryFailureThreshold: 3,
      autoSwitchCooldownMs: 300_000,
      monitoringEnabled: true,
      autoSwitchEnabled: false,
      autoSwitchProfileUid: null,
    })
    .expect(200);
  const accepted = await request(setup.app.callback())
    .post('/api/actions/health-check')
    .send({})
    .expect(202);
  await setup.taskService.waitForIdle();
  await request(setup.app.callback()).get('/api/missing').expect(404);

  expect(logs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        level: 'debug',
        scope: 'http:access',
        message: 'request completed',
        metadata: expect.objectContaining({ method: 'GET', status: 200 }),
      }),
      expect.objectContaining({
        level: 'info',
        scope: 'settings:service',
        message: 'settings updated',
        metadata: expect.objectContaining({
          changedFields: ['checkIntervalMs'],
          requestId: expect.any(String),
        }),
      }),
      expect.objectContaining({
        level: 'info',
        scope: 'task:service',
        message: 'queued',
        metadata: expect.objectContaining({
          taskType: 'health_check',
          taskId: accepted.body.data.taskId,
          requestId: expect.any(String),
        }),
      }),
      expect.objectContaining({
        level: 'info',
        scope: 'task:service',
        message: 'succeeded',
        metadata: expect.objectContaining({
          taskId: accepted.body.data.taskId,
          durationMs: expect.any(Number),
        }),
      }),
      expect.objectContaining({
        level: 'warn',
        scope: 'http:access',
        message: 'request failed',
        metadata: expect.objectContaining({
          status: 404,
          errorCode: 'NOT_FOUND',
        }),
      }),
    ]),
  );
});

test('设置完整更新并校验自动切换锁定和订阅', async () => {
  const setup = await createSetup();
  const notifications: StreamNotification[] = [];
  setup.notifier.subscribe((notification) => notifications.push(notification));
  notifications.length = 0;
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
  expect(notifications).toEqual([]);
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

test('任务生命周期按动作类型发布精确资源失效通知', async () => {
  const setup = await createSetup();
  const notifications: StreamNotification[] = [];
  setup.notifier.subscribe((notification) => notifications.push(notification));
  notifications.length = 0;
  const cases = [
    {
      path: 'health-check',
      body: {},
      resources: ['status', 'sites', 'events'],
    },
    { path: 'diagnose', body: {}, resources: ['candidates', 'events'] },
    {
      path: 'apply',
      body: { ip: '198.51.100.20' },
      resources: ['status', 'events'],
    },
    {
      path: 'reset',
      body: {},
      resources: ['status', 'settings', 'events'],
    },
    { path: 'rollback', body: {}, resources: ['status', 'events'] },
  ];
  for (const item of cases) {
    notifications.length = 0;
    const response = await request(setup.app.callback())
      .post(`/api/actions/${item.path}`)
      .send(item.body)
      .expect(202);
    await setup.taskService.waitForIdle();
    const taskResource = `task:${response.body.data.taskId}`;
    expect(
      notifications.map(({ reason, resources }) => ({ reason, resources })),
    ).toEqual([
      { reason: 'task_queued', resources: [taskResource] },
      { reason: 'task_started', resources: [taskResource] },
      {
        reason: 'task_succeeded',
        resources: [taskResource, ...item.resources],
      },
    ]);
    if (item.path === 'health-check') {
      const stored = setup.store.getTask(response.body.data.taskId)!;
      expect(stored.result).toMatchObject({ status: 'healthy' });
      expect(stored.result).not.toHaveProperty('snapshot');
      expect(stored.result).not.toHaveProperty('changes');
    }
  }
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
  const notifications: StreamNotification[] = [];
  setup.notifier.subscribe((notification) => notifications.push(notification));
  notifications.length = 0;
  const rollback = await request(setup.app.callback())
    .post('/api/actions/rollback')
    .send({});
  await setup.taskService.waitForIdle();
  expect(setup.store.getTask(rollback.body.data.taskId)).toMatchObject({
    status: 'failed',
    errorCode: 'NO_BACKUP',
  });
  expect(notifications.at(-1)).toMatchObject({
    reason: 'task_failed',
    resources: [`task:${rollback.body.data.taskId}`, 'events'],
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
  const logs: RecordedLog[] = [];
  const logger = recordingLogger(logs);
  const setup = await createSetup({}, logger);
  const invalid = await request(setup.app.callback())
    .put('/api/settings')
    .set('Content-Type', 'application/json')
    .send('{bad');
  expect(invalid.body.error.code).toBe('INVALID_JSON');
  const timeoutApp = createApp({
    store: setup.store,
    taskService: setup.taskService,
    scheduler: setup.scheduler,
    notifier: setup.notifier,
    requestTimeoutMs: 5,
    logger,
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
  expect(logs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        level: 'error',
        scope: 'http:access',
        message: 'request timeout',
        metadata: expect.objectContaining({
          status: 504,
          errorCode: 'REQUEST_TIMEOUT',
        }),
      }),
      expect.objectContaining({
        level: 'error',
        scope: 'http:access',
        message: 'request failed',
        metadata: expect.objectContaining({
          status: 500,
          errorCode: 'INTERNAL_ERROR',
          error: expect.any(Error),
        }),
      }),
    ]),
  );
});
