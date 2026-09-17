import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type {
  DiagnosisResult,
  HealthCheckResult,
  LegacyStatus,
  SiteErrorType,
  SiteResult,
  SiteTarget,
} from '@clash-sentinel/shared';
import { SqliteStore } from '../../storage/store.js';
import { HealthCheckService } from './health-check.js';
import type { HealthLegacyOperations } from './health-check.js';
import type { SiteProbe, SiteProbeRequest } from './site-probe.js';

const cleanups: Array<{ root: string; store: SqliteStore }> = [];

afterEach(async () => {
  for (const item of cleanups.splice(0)) {
    item.store.close();
    await rm(item.root, { recursive: true, force: true });
  }
});

/** 创建指定可达性与错误类型的合法站点结果。 */
function result(
  target: SiteTarget,
  reachable: boolean,
  errorType: SiteErrorType | null = reachable ? null : 'timeout',
): SiteResult {
  return {
    target,
    reachable,
    httpStatus: reachable ? 200 : null,
    durationMs: reachable ? 20 : null,
    errorType,
    checkedAt: '2026-09-09T04:00:00.000Z',
    serviceStatus: target === 'openai_status' ? 'operational' : null,
    incidentSummary: null,
  };
}

/** 返回带一个合格候选的虚构诊断。 */
/** 返回默认健康的 Legacy 健康检查结果；测试可覆写字段。 */
function healthResult(): HealthCheckResult {
  return {
    status: 'healthy',
    checkedAt: '2026-09-09 12:00:00 +0800',
    internetSuccess: 3,
    internetTotal: 3,
    currentIp: '198.51.100.20',
    consecutiveFailures: 0,
    recommendedIp: null,
    profileUid: 'profile-demo',
    rawFingerprint: 'a'.repeat(64),
    identityChanged: null,
  };
}

function diagnosis(): DiagnosisResult {
  return {
    status: 'testable',
    generatedAt: '2026-09-09T04:00:00.000Z',
    profile: { uid: 'profile-demo', name: '演示订阅' },
    domain: 'entry.example.test',
    skipReason: null,
    detail: null,
    testedPorts: [7001],
    testRounds: 2,
    candidates: [
      {
        ip: '198.51.100.21',
        eligible: true,
        success: 2,
        total: 2,
        successRate: 100,
        averageMs: 15,
        failedPorts: [],
        sources: ['system'],
      },
    ],
    recommendedIp: '198.51.100.21',
  };
}

/** 创建隔离存储和可按目标控制结果的完整健康编排器。 */
async function setup(
  outcomes: Partial<Record<SiteTarget, SiteResult>> = {},
  statusOverrides: Partial<LegacyStatus> = {},
  proxyUrl: string | null = 'http://127.0.0.1:7897',
) {
  const root = await mkdtemp(join(tmpdir(), 'clash-health-'));
  const store = new SqliteStore({ databasePath: join(root, 'health.db') });
  cleanups.push({ root, store });
  const siteProbe: SiteProbe = {
    probe: vi.fn(async (request: SiteProbeRequest) =>
      Promise.resolve(outcomes[request.target] ?? result(request.target, true)),
    ),
  };
  const status: LegacyStatus = {
    profile: { uid: 'profile-demo', name: '演示订阅' },
    lock: {
      locked: true,
      domain: 'entry.example.test',
      ip: '198.51.100.20',
    },
    controllerAvailable: true,
    report: null,
    health: null,
    ...statusOverrides,
  };
  const legacy = {
    getStatus: vi.fn(async () => status),
    healthCheck: vi.fn(async () => healthResult()),
    diagnose: vi.fn(async () => diagnosis()),
  } satisfies HealthLegacyOperations;
  const service = new HealthCheckService(
    store.settings,
    store.health,
    store.sites,
    store.diagnoses,
    store.events,
    siteProbe,
    { getProxyUrl: vi.fn(async () => proxyUrl) },
    legacy,
    () => new Date('2026-09-09T04:00:01.000Z'),
  );
  return { store, siteProbe, legacy, service };
}

test('两个国内站点成功时评价入口并保存全部六站', async () => {
  const value = await setup({ taobao: result('taobao', false) });
  const { snapshot, changes } = await value.service.run('manual');
  expect(snapshot).toMatchObject({ status: 'healthy', internetSuccess: 2 });
  expect(changes).toEqual({
    statusUpdated: true,
    sitesUpdated: true,
    candidatesUpdated: false,
    eventAppended: false,
    settingsUpdated: false,
  });
  expect(value.legacy.healthCheck).toHaveBeenCalledOnce();
  expect(value.store.sites.listSiteHistory('taobao')).toHaveLength(1);
  expect(value.store.sites.getSiteSnapshot('openai_status')).not.toBeNull();
});

test('断网或不确定时不评价入口并保留失败计数', async () => {
  for (const successful of [0, 1]) {
    const outcomes = Object.fromEntries(
      (['baidu', 'taobao', 'tencent'] as const).map((target, index) => [
        target,
        result(target, index < successful),
      ]),
    );
    const value = await setup(outcomes);
    value.store.health.upsertHealthSnapshot({
      status: 'entry_suspected',
      profile: null,
      lock: { locked: false },
      internetSuccess: 3,
      internetTotal: 3,
      consecutiveFailures: 2,
      recommendedIp: '198.51.100.21',
      autoSwitchCooldownUntil: null,
      updatedAt: '2026-09-09T03:59:00.000Z',
    });
    const { snapshot } = await value.service.run('manual');
    expect(snapshot.status).toBe(
      successful === 0 ? 'internet_down' : 'internet_uncertain',
    );
    expect(snapshot.consecutiveFailures).toBe(2);
    expect(value.legacy.healthCheck).not.toHaveBeenCalled();
  }
});

test('入口首次达到失败阈值后由 Node 执行严格诊断', async () => {
  const value = await setup();
  value.legacy.healthCheck.mockResolvedValue({
    status: 'entry_down',
    checkedAt: '2026-09-09 12:00:00 +0800',
    internetSuccess: 3,
    internetTotal: 3,
    currentIp: '198.51.100.20',
    consecutiveFailures: 3,
    recommendedIp: null,
    profileUid: 'profile-demo',
    rawFingerprint: 'a'.repeat(64),
    identityChanged: null,
  });
  await expect(value.service.run('scheduled')).resolves.toMatchObject({
    snapshot: { status: 'entry_down', consecutiveFailures: 3 },
    changes: { candidatesUpdated: true, eventAppended: true },
  });
  expect(value.legacy.diagnose).toHaveBeenCalledOnce();
  expect(value.store.diagnoses.getDiagnosis()?.recommendedIp).toBe(
    '198.51.100.21',
  );
});

test('状态变化事件写入失败不反转检测结果且摘要保持未写入', async () => {
  const value = await setup();
  vi.spyOn(value.store.events, 'appendEvent').mockImplementation(() => {
    throw new Error('event unavailable');
  });
  const execution = await value.service.run('scheduled');
  expect(execution.snapshot.status).toBe('healthy');
  expect(execution.changes).toMatchObject({
    statusUpdated: true,
    sitesUpdated: true,
    candidatesUpdated: false,
    eventAppended: false,
  });
});

test('入口健康时将控制接口或全代理故障表达为 proxy_error', async () => {
  const controllerDown = await setup({}, { controllerAvailable: false });
  expect((await controllerDown.service.run('manual')).snapshot.status).toBe(
    'proxy_error',
  );

  const proxyFailures = Object.fromEntries(
    (['google', 'github', 'openai_status'] as const).map((target) => [
      target,
      result(target, false, 'proxy'),
    ]),
  );
  const proxyDown = await setup(proxyFailures);
  expect((await proxyDown.service.run('manual')).snapshot.status).toBe(
    'proxy_error',
  );
  expect(proxyDown.legacy.healthCheck).toHaveBeenCalledOnce();
});

test('入口异常优先于单个海外失败且海外结果不改变失败计数', async () => {
  const value = await setup({ google: result('google', false, 'timeout') });
  value.legacy.healthCheck.mockResolvedValue({
    status: 'entry_suspected',
    checkedAt: '2026-09-09 12:00:00 +0800',
    internetSuccess: 3,
    internetTotal: 3,
    currentIp: '198.51.100.20',
    consecutiveFailures: 2,
    recommendedIp: null,
    profileUid: 'profile-demo',
    rawFingerprint: 'a'.repeat(64),
    identityChanged: null,
  });
  await expect(value.service.run('manual')).resolves.toMatchObject({
    snapshot: { status: 'entry_suspected', consecutiveFailures: 2 },
  });
});

test('代理配置缺失时不发出海外请求并标记 proxy_error', async () => {
  const value = await setup({}, {}, null);
  expect((await value.service.run('manual')).snapshot.status).toBe(
    'proxy_error',
  );
  expect(value.siteProbe.probe).toHaveBeenCalledTimes(3);
  expect(value.store.sites.getSiteSnapshot('google')).toMatchObject({
    reachable: false,
    errorType: 'proxy',
  });
});

test('阈值诊断报告读取失败时保留 entry_down 快照并使本轮失败', async () => {
  const value = await setup();
  value.legacy.healthCheck.mockResolvedValue({
    status: 'entry_down',
    checkedAt: '2026-09-09 12:00:00 +0800',
    internetSuccess: 3,
    internetTotal: 3,
    currentIp: '198.51.100.20',
    consecutiveFailures: 3,
    recommendedIp: null,
    profileUid: 'profile-demo',
    rawFingerprint: 'a'.repeat(64),
    identityChanged: null,
  });
  value.legacy.diagnose.mockRejectedValue(new Error('invalid report'));
  await expect(value.service.run('scheduled')).rejects.toThrow(
    'invalid report',
  );
  expect(value.store.health.getHealthSnapshot()?.status).toBe('entry_down');
});

test('订阅 UID 变化清空诊断和失败计数并关闭自动切换', async () => {
  const value = await setup();
  value.store.diagnoses.replaceDiagnosis(diagnosis());
  value.store.settings.updateSettings({
    autoSwitchEnabled: true,
    autoSwitchProfileUid: 'profile-old',
  });
  value.store.health.upsertHealthSnapshot({
    ...(await value.service.run('manual')).snapshot,
    profile: { uid: 'profile-old', name: '旧订阅' },
    consecutiveFailures: 2,
  });
  const execution = await value.service.run('manual');
  expect(execution.snapshot.consecutiveFailures).toBe(0);
  expect(execution.changes).toMatchObject({
    candidatesUpdated: true,
    settingsUpdated: true,
    eventAppended: true,
  });
  expect(value.store.diagnoses.getDiagnosis()).toBeNull();
  expect(value.store.settings.getSettings()).toMatchObject({
    autoSwitchEnabled: false,
    autoSwitchProfileUid: null,
  });
  expect(execution.autoSwitchRequest).toBeNull();
});

test('同一 UID 文件指纹变化废弃诊断但保留自动开关', async () => {
  const value = await setup();
  value.store.diagnoses.replaceDiagnosis(diagnosis());
  value.store.settings.updateSettings({
    autoSwitchEnabled: true,
    autoSwitchProfileUid: 'profile-demo',
  });
  value.legacy.healthCheck.mockResolvedValue({
    status: 'healthy',
    checkedAt: '2026-09-09 12:00:00 +0800',
    internetSuccess: 3,
    internetTotal: 3,
    currentIp: '198.51.100.20',
    consecutiveFailures: 0,
    recommendedIp: null,
    profileUid: 'profile-demo',
    rawFingerprint: 'b'.repeat(64),
    identityChanged: 'content',
  });
  const execution = await value.service.run('manual');
  expect(execution.changes).toMatchObject({
    candidatesUpdated: true,
    settingsUpdated: false,
  });
  expect(value.store.diagnoses.getDiagnosis()).toBeNull();
  expect(value.store.settings.getSettings().autoSwitchEnabled).toBe(true);
});

/** 构造达到失败阈值且启用自动切换的一轮健康检测。 */
async function autoSwitchSetup() {
  const value = await setup();
  value.store.settings.updateSettings({
    autoSwitchEnabled: true,
    autoSwitchProfileUid: 'profile-demo',
    entryFailureThreshold: 3,
  });
  const legacyHealth = await value.legacy.healthCheck();
  value.legacy.healthCheck.mockResolvedValue({
    ...legacyHealth,
    status: 'entry_down',
    consecutiveFailures: 3,
  });
  value.legacy.healthCheck.mockClear();
  return value;
}

test('首次入口故障返回可复用本轮诊断的自动切换请求', async () => {
  const value = await autoSwitchSetup();
  const execution = await value.service.run('scheduled');
  expect(execution.autoSwitchRequest).toEqual({
    currentIp: '198.51.100.20',
    profileUid: 'profile-demo',
    reuseDiagnosis: true,
  });
  expect(value.legacy.diagnose).toHaveBeenCalledOnce();
  const next = await value.service.run('scheduled');
  expect(next.autoSwitchRequest).toMatchObject({ reuseDiagnosis: false });
  expect(value.legacy.diagnose).toHaveBeenCalledOnce();
});

for (const [name, patch] of [
  ['自动开关关闭', { autoSwitchEnabled: false }],
  ['订阅不匹配', { autoSwitchProfileUid: 'profile-other' }],
  ['阈值尚未达到', { entryFailureThreshold: 4 }],
] as const) {
  test(`${name}时不返回自动切换请求`, async () => {
    const value = await autoSwitchSetup();
    value.store.settings.updateSettings(patch);
    expect((await value.service.run('scheduled')).autoSwitchRequest).toBeNull();
  });
}

const noAutoSwitchCases: Array<
  [string, Partial<Record<SiteTarget, SiteResult>>, Partial<LegacyStatus>]
> = [
  ['未锁定 IP', {}, { lock: { locked: false } }],
  ['无当前订阅', {}, { profile: null } as unknown as Partial<LegacyStatus>],
  [
    '国内网络不确定',
    {
      taobao: result('taobao', false),
      tencent: result('tencent', false),
    },
    {},
  ],
];
for (const [name, outcomes, statusOverrides] of noAutoSwitchCases) {
  test(`${name}时不返回自动切换请求`, async () => {
    const value = await setup(outcomes, statusOverrides);
    value.store.settings.updateSettings({
      autoSwitchEnabled: true,
      autoSwitchProfileUid: 'profile-demo',
    });
    expect((await value.service.run('scheduled')).autoSwitchRequest).toBeNull();
  });
}

test('健康状态正常时不返回自动切换请求', async () => {
  const value = await setup();
  value.store.settings.updateSettings({
    autoSwitchEnabled: true,
    autoSwitchProfileUid: 'profile-demo',
  });
  expect((await value.service.run('manual')).autoSwitchRequest).toBeNull();
});

for (const [until, blocked] of [
  ['2026-09-09T04:00:01.001Z', true],
  ['2026-09-09T04:00:01.000Z', false],
  ['2026-09-09T04:00:00.999Z', false],
] as const) {
  test(`冷却到期时间 ${until} 的触发边界`, async () => {
    const value = await autoSwitchSetup();
    const execution = await value.service.run('scheduled');
    value.store.health.upsertHealthSnapshot({
      ...execution.snapshot,
      autoSwitchCooldownUntil: until,
    });
    const next = await value.service.run('scheduled');
    if (blocked) expect(next.autoSwitchRequest).toBeNull();
    else
      expect(next.autoSwitchRequest).toMatchObject({ reuseDiagnosis: false });
  });
}

test('检测期间更新设置后采用最新自动切换开关', async () => {
  const value = await autoSwitchSetup();
  value.legacy.diagnose.mockImplementation(async () => {
    value.store.settings.updateSettings({ autoSwitchEnabled: false });
    return diagnosis();
  });
  expect((await value.service.run('scheduled')).autoSwitchRequest).toBeNull();
});
