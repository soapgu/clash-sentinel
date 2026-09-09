import type {
  HealthSnapshot,
  LegacyStatus,
  SiteResult,
  SiteTarget,
} from '@clash-sentinel/shared';
import type { SqliteStore } from '../../storage/store.js';
import type { LegacyAdapter } from '../../legacy/adapter.js';
import type { ClashProxyConfig } from './proxy-config.js';
import type { SiteProbe } from './site-probe.js';

/** 服务端固定且不可由 API 覆盖的六个健康探测目标。 */
export const HEALTH_TARGETS = {
  baidu: 'https://www.baidu.com/',
  taobao: 'https://www.taobao.com/',
  tencent: 'https://www.qq.com/favicon.ico',
  google: 'https://www.google.com/generate_204',
  github: 'https://github.com/',
  openai_status: 'https://status.openai.com/api/v2/summary.json',
} as const satisfies Record<SiteTarget, string>;

/** 健康编排器调用的 Legacy 只读和检测能力。 */
export type HealthLegacyOperations = Pick<
  LegacyAdapter,
  'getStatus' | 'healthCheck' | 'readLatestDiagnosis'
>;

/** 创建完整健康检测编排器所需的依赖。 */
export interface HealthCheckServiceOptions {
  /** SQLite 快照、历史、诊断和事件门面。 */
  store: SqliteStore;
  /** 可注入的六站 HTTP 探测器。 */
  siteProbe: SiteProbe;
  /** 从固定 Clash 配置解析代理端口的读取器。 */
  proxyConfig: Pick<ClashProxyConfig, 'getProxyUrl'>;
  /** 复用原始 Shell 状态机的 Legacy 能力。 */
  legacy: HealthLegacyOperations;
  /** 测试可注入的当前时间。 */
  now?: () => Date;
}

/** 完整健康检测的调用来源。 */
export type HealthCheckSource = 'manual' | 'scheduled';

/** 编排六站探测、入口判断、诊断持久化和综合快照。 */
export class HealthCheckService {
  private readonly now: () => Date;

  /** 使用隔离探测器、Legacy 能力和 SQLite 创建编排器。 */
  constructor(private readonly options: HealthCheckServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * 执行一轮完整健康检测。
   *
   * @param source 手动任务或定时调度来源。
   * @returns 已持久化的综合健康快照。
   */
  async run(source: HealthCheckSource): Promise<HealthSnapshot> {
    const settings = this.options.store.getSettings();
    const directPromise = Promise.all(
      (['baidu', 'taobao', 'tencent'] as const).map((target) =>
        this.options.siteProbe.probe({
          target,
          url: HEALTH_TARGETS[target],
          timeoutMs: settings.requestTimeoutMs,
          proxyUrl: null,
        }),
      ),
    );
    const proxyUrlPromise = this.options.proxyConfig.getProxyUrl();
    const proxyUrl = await proxyUrlPromise;
    const proxyPromise = proxyUrl
      ? Promise.all(
          (['google', 'github', 'openai_status'] as const).map((target) =>
            this.options.siteProbe.probe({
              target,
              url: HEALTH_TARGETS[target],
              timeoutMs: settings.requestTimeoutMs,
              proxyUrl,
            }),
          ),
        )
      : Promise.resolve(
          (['google', 'github', 'openai_status'] as const).map((target) =>
            this.proxyFailure(target),
          ),
        );
    const [directResults, proxyResults] = await Promise.all([
      directPromise,
      proxyPromise,
    ]);
    for (const result of [...directResults, ...proxyResults])
      this.options.store.appendSiteResult(result);

    const previous = this.options.store.getHealthSnapshot();
    const status = await this.readStatusSafely();
    const directSuccess = directResults.filter((item) => item.reachable).length;
    let snapshot = this.baseSnapshot(previous, status, directSuccess);

    if (directSuccess >= 2 && status?.lock.locked) {
      const legacyHealth = await this.options.legacy.healthCheck();
      snapshot = {
        ...snapshot,
        status: legacyHealth.status,
        internetSuccess: directSuccess,
        internetTotal: directResults.length,
        consecutiveFailures: legacyHealth.consecutiveFailures,
        recommendedIp: legacyHealth.recommendedIp,
      };
    }

    snapshot.status = this.finalStatus(snapshot, status, proxyResults);
    const saved = this.options.store.upsertHealthSnapshot(snapshot);
    if (snapshot.status === 'entry_down')
      this.options.store.replaceDiagnosis(
        await this.options.legacy.readLatestDiagnosis(),
      );
    if (source === 'scheduled' && previous?.status !== saved.status)
      this.appendTransitionEventSafely(previous?.status ?? null, saved);
    return saved;
  }

  /** 状态命令失败时保留站点结果并把身份降级为未知。 */
  private async readStatusSafely(): Promise<LegacyStatus | null> {
    try {
      return await this.options.legacy.getStatus();
    } catch {
      return null;
    }
  }

  /** 根据国内成功数创建不评价入口的基础快照。 */
  private baseSnapshot(
    previous: HealthSnapshot | null,
    status: LegacyStatus | null,
    directSuccess: number,
  ): HealthSnapshot {
    return {
      status:
        directSuccess === 0
          ? 'internet_down'
          : directSuccess === 1
            ? 'internet_uncertain'
            : 'unknown',
      profile: status?.profile ?? previous?.profile ?? null,
      lock: status?.lock ?? previous?.lock ?? { locked: false },
      internetSuccess: directSuccess,
      internetTotal: 3,
      consecutiveFailures: previous?.consecutiveFailures ?? 0,
      recommendedIp: previous?.recommendedIp ?? null,
      autoSwitchCooldownUntil: previous?.autoSwitchCooldownUntil ?? null,
      updatedAt: this.now().toISOString(),
    };
  }

  /** 按国内、入口、代理和身份优先级确定综合状态。 */
  private finalStatus(
    snapshot: HealthSnapshot,
    status: LegacyStatus | null,
    proxyResults: SiteResult[],
  ): HealthSnapshot['status'] {
    if (snapshot.internetSuccess === 0) return 'internet_down';
    if (snapshot.internetSuccess === 1) return 'internet_uncertain';
    if (['entry_down', 'entry_suspected'].includes(snapshot.status))
      return snapshot.status;
    const proxyUnavailable = proxyResults.every(
      (item) => !item.reachable && item.errorType === 'proxy',
    );
    if (status?.controllerAvailable === false || proxyUnavailable)
      return 'proxy_error';
    if (status?.lock.locked && snapshot.status === 'healthy') return 'healthy';
    return 'unknown';
  }

  /** 创建因代理配置不可用而未发出请求的站点失败结果。 */
  private proxyFailure(target: SiteTarget): SiteResult {
    return {
      target,
      reachable: false,
      httpStatus: null,
      durationMs: null,
      errorType: 'proxy',
      checkedAt: this.now().toISOString(),
      serviceStatus: target === 'openai_status' ? 'unknown' : null,
      incidentSummary: null,
    };
  }

  /** 仅为定时检测的综合状态变化追加低噪声事件。 */
  private appendTransitionEventSafely(
    previousStatus: HealthSnapshot['status'] | null,
    snapshot: HealthSnapshot,
  ): void {
    try {
      this.options.store.appendEvent({
        type: 'health_status_changed',
        severity: ['internet_down', 'entry_down', 'proxy_error'].includes(
          snapshot.status,
        )
          ? 'error'
          : snapshot.status === 'healthy'
            ? 'info'
            : 'warning',
        retention: 'ordinary',
        summary: `健康状态变更为 ${snapshot.status}`,
        details: { previousStatus, currentStatus: snapshot.status },
        profileUid: snapshot.profile?.uid ?? null,
        occurredAt: snapshot.updatedAt,
      });
    } catch {
      // 状态变化事件属于辅助审计，失败不能反转已保存的健康结果。
    }
  }
}
