import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type {
  DiagnosisResult,
  LegacyStatus,
  SiteErrorType,
  SiteResult,
  SiteTarget,
} from '@clash-sentinel/shared';
import { SqliteStore } from '../../storage/store.js';
import { HealthCheckService } from './health-check.js';
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
    healthCheck: vi.fn(async () => ({
      status: 'healthy' as const,
      checkedAt: '2026-09-09 12:00:00 +0800',
      internetSuccess: 3,
      internetTotal: 3,
      currentIp: '198.51.100.20',
      consecutiveFailures: 0,
      recommendedIp: null,
    })),
    readLatestDiagnosis: vi.fn(async () => diagnosis()),
  };
  const service = new HealthCheckService({
    store,
    siteProbe,
    proxyConfig: { getProxyUrl: vi.fn(async () => proxyUrl) },
    legacy,
    now: () => new Date('2026-09-09T04:00:01.000Z'),
  });
  return { store, siteProbe, legacy, service };
}

test('两个国内站点成功时评价入口并保存全部六站', async () => {
  const value = await setup({ taobao: result('taobao', false) });
  const snapshot = await value.service.run('manual');
  expect(snapshot).toMatchObject({ status: 'healthy', internetSuccess: 2 });
  expect(value.legacy.healthCheck).toHaveBeenCalledOnce();
  expect(value.store.listSiteHistory('taobao')).toHaveLength(1);
  expect(value.store.getSiteSnapshot('openai_status')).not.toBeNull();
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
    value.store.upsertHealthSnapshot({
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
    const snapshot = await value.service.run('manual');
    expect(snapshot.status).toBe(
      successful === 0 ? 'internet_down' : 'internet_uncertain',
    );
    expect(snapshot.consecutiveFailures).toBe(2);
    expect(value.legacy.healthCheck).not.toHaveBeenCalled();
  }
});

test('入口达到失败阈值后读取现有报告而不再次诊断', async () => {
  const value = await setup();
  value.legacy.healthCheck.mockResolvedValue({
    status: 'entry_down',
    checkedAt: '2026-09-09 12:00:00 +0800',
    internetSuccess: 3,
    internetTotal: 3,
    currentIp: '198.51.100.20',
    consecutiveFailures: 3,
    recommendedIp: '198.51.100.21',
  });
  await expect(value.service.run('scheduled')).resolves.toMatchObject({
    status: 'entry_down',
    consecutiveFailures: 3,
  });
  expect(value.legacy.readLatestDiagnosis).toHaveBeenCalledOnce();
  expect(value.store.getDiagnosis()?.recommendedIp).toBe('198.51.100.21');
});

test('入口健康时将控制接口或全代理故障表达为 proxy_error', async () => {
  const controllerDown = await setup({}, { controllerAvailable: false });
  expect((await controllerDown.service.run('manual')).status).toBe(
    'proxy_error',
  );

  const proxyFailures = Object.fromEntries(
    (['google', 'github', 'openai_status'] as const).map((target) => [
      target,
      result(target, false, 'proxy'),
    ]),
  );
  const proxyDown = await setup(proxyFailures);
  expect((await proxyDown.service.run('manual')).status).toBe('proxy_error');
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
  });
  await expect(value.service.run('manual')).resolves.toMatchObject({
    status: 'entry_suspected',
    consecutiveFailures: 2,
  });
});

test('代理配置缺失时不发出海外请求并标记 proxy_error', async () => {
  const value = await setup({}, {}, null);
  expect((await value.service.run('manual')).status).toBe('proxy_error');
  expect(value.siteProbe.probe).toHaveBeenCalledTimes(3);
  expect(value.store.getSiteSnapshot('google')).toMatchObject({
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
  });
  value.legacy.readLatestDiagnosis.mockRejectedValue(
    new Error('invalid report'),
  );
  await expect(value.service.run('scheduled')).rejects.toThrow(
    'invalid report',
  );
  expect(value.store.getHealthSnapshot()?.status).toBe('entry_down');
});
