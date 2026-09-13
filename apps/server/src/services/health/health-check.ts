import type {
  HealthSnapshot,
  LegacyStatus,
  SiteResult,
  SiteTarget,
} from '@clash-sentinel/shared';
import type { DiagnosisRepository } from '../../storage/diagnosis-repository.js';
import type { EventRepository } from '../../storage/event-repository.js';
import type { HealthRepository } from '../../storage/health-repository.js';
import type { SettingsRepository } from '../../storage/settings-repository.js';
import type { SiteRepository } from '../../storage/site-repository.js';
import type { LegacyAdapter } from '../../legacy/adapter.js';
import type { ClashProxyConfig } from './proxy-config.js';
import type { SiteProbe } from './site-probe.js';
import { randomUUID } from 'node:crypto';
import { noopLogger, type AppLogger } from '../../logging.js';
import {
  canAutoSwitch,
  selectAutoSwitchCandidate,
} from '../auto-switch-policy.js';

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
  'getStatus' | 'healthCheck' | 'diagnose'
>;

/** 创建完整健康检测编排器所需的依赖。 */
export interface HealthCheckServiceOptions {
  /** SQLite 快照、历史、诊断和事件门面。 */
  store: {
    settings: Pick<SettingsRepository, 'getSettings' | 'updateSettings'>;
    health: Pick<
      HealthRepository,
      'getHealthSnapshot' | 'upsertHealthSnapshot'
    >;
    sites: Pick<SiteRepository, 'appendSiteResult'>;
    diagnoses: Pick<DiagnosisRepository, 'clearDiagnosis' | 'replaceDiagnosis'>;
    events: Pick<EventRepository, 'appendEvent'>;
  };
  /** 可注入的六站 HTTP 探测器。 */
  siteProbe: SiteProbe;
  /** 从固定 Clash 配置解析代理端口的读取器。 */
  proxyConfig: Pick<ClashProxyConfig, 'getProxyUrl'>;
  /** 复用原始 Shell 状态机的 Legacy 能力。 */
  legacy: HealthLegacyOperations;
  /** 测试可注入的当前时间。 */
  now?: () => Date;
  /** 记录健康检测摘要和状态变化。 */
  logger?: AppLogger;
}

/** 完整健康检测的调用来源。 */
export type HealthCheckSource = 'manual' | 'scheduled';

/** 一轮健康检查实际成功写入的资源摘要。 */
export interface HealthCheckChanges {
  statusUpdated: boolean;
  sitesUpdated: boolean;
  candidatesUpdated: boolean;
  eventAppended: boolean;
  settingsUpdated: boolean;
}

/** 健康检测产生的自动切换业务请求，不包含任务系统元数据。 */
export interface AutoSwitchRequest {
  currentIp: string;
  profileUid: string;
  reuseDiagnosis: boolean;
}

/** 健康快照和仅供服务端通知层使用的执行摘要。 */
export interface HealthCheckExecution {
  snapshot: HealthSnapshot;
  changes: HealthCheckChanges;
  autoSwitchRequest: AutoSwitchRequest | null;
}

/** 编排六站探测、入口判断、诊断持久化和综合快照。 */
export class HealthCheckService {
  private readonly now: () => Date;
  private readonly logger: AppLogger;

  /** 使用隔离探测器、Legacy 能力和 SQLite 创建编排器。 */
  constructor(private readonly options: HealthCheckServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? noopLogger;
  }

  /**
   * 执行一轮完整健康检测。
   *
   * @param source 手动任务或定时调度来源。
   * @returns 已持久化的综合健康快照。
   */
  async run(
    source: HealthCheckSource,
    runId: string = randomUUID(),
  ): Promise<HealthCheckExecution> {
    const startedAt = Date.now();
    this.logger.info('health:check', 'started', { source, runId });
    try {
      return await this.execute(source, runId, startedAt);
    } catch (error) {
      this.logger.error('health:check', 'failed', {
        source,
        runId,
        durationMs: Date.now() - startedAt,
        errorCode:
          error instanceof Error && 'code' in error
            ? String(error.code)
            : 'INTERNAL_ERROR',
      });
      throw error;
    }
  }

  /** 执行检测主体并记录成功摘要。 */
  private async execute(
    source: HealthCheckSource,
    runId: string,
    startedAt: number,
  ): Promise<HealthCheckExecution> {
    const changes: HealthCheckChanges = {
      statusUpdated: false,
      sitesUpdated: false,
      candidatesUpdated: false,
      eventAppended: false,
      settingsUpdated: false,
    };
    const settings = this.options.store.settings.getSettings();
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
      this.logger.debug('health:check', 'site checked', {
        runId,
        target: result.target,
        reachable: result.reachable,
        httpStatus: result.httpStatus,
        durationMs: result.durationMs,
        errorType: result.errorType,
      });
    for (const result of [...directResults, ...proxyResults])
      this.options.store.sites.appendSiteResult(result);
    changes.sitesUpdated = true;

    const previous = this.options.store.health.getHealthSnapshot();
    const status = await this.readStatusSafely();
    const directSuccess = directResults.filter((item) => item.reachable).length;
    let snapshot = this.baseSnapshot(previous, status, directSuccess);
    let identityChanged: 'profile' | 'content' | null =
      previous?.profile && status && previous.profile.uid !== status.profile.uid
        ? 'profile'
        : null;

    if (directSuccess >= 2 && status?.lock.locked) {
      const legacyHealth = await this.options.legacy.healthCheck(
        settings.entryFailureThreshold,
      );
      snapshot = {
        ...snapshot,
        status: legacyHealth.status,
        internetSuccess: directSuccess,
        internetTotal: directResults.length,
        consecutiveFailures: legacyHealth.consecutiveFailures,
        recommendedIp: legacyHealth.recommendedIp,
      };
      identityChanged = legacyHealth.identityChanged ?? identityChanged;
    }
    if (identityChanged) {
      if (this.options.store.diagnoses.clearDiagnosis())
        changes.candidatesUpdated = true;
      snapshot.consecutiveFailures = 0;
      snapshot.recommendedIp = null;
      if (identityChanged === 'profile') {
        const currentSettings = this.options.store.settings.getSettings();
        if (
          currentSettings.autoSwitchEnabled ||
          currentSettings.autoSwitchProfileUid !== null
        ) {
          this.options.store.settings.updateSettings({
            autoSwitchEnabled: false,
            autoSwitchProfileUid: null,
          });
          changes.settingsUpdated = true;
        }
      }
      changes.eventAppended = this.appendIdentityEventSafely(
        identityChanged,
        snapshot,
      );
    }

    snapshot.status = this.finalStatus(snapshot, status, proxyResults);
    let saved = this.options.store.health.upsertHealthSnapshot(snapshot);
    changes.statusUpdated = true;
    if (snapshot.status === 'entry_down' && previous?.status !== 'entry_down') {
      const diagnosis = this.options.store.diagnoses.replaceDiagnosis(
        await this.options.legacy.diagnose(),
      );
      changes.candidatesUpdated = true;
      snapshot.recommendedIp =
        selectAutoSwitchCandidate(
          diagnosis.candidates,
          snapshot.lock.locked ? snapshot.lock.ip : null,
        )?.ip ?? null;
      saved = this.options.store.health.upsertHealthSnapshot(snapshot);
    }
    if (source === 'scheduled' && previous?.status !== saved.status) {
      changes.eventAppended =
        this.appendTransitionEventSafely(previous?.status ?? null, saved) ||
        changes.eventAppended;
      this.logger.info('health:check', 'status changed', {
        runId,
        previousStatus: previous?.status ?? null,
        currentStatus: saved.status,
        eventAppended: changes.eventAppended,
      });
    }
    const changedResources: string[] = [];
    if (changes.statusUpdated) changedResources.push('status');
    if (changes.sitesUpdated) changedResources.push('sites');
    if (changes.candidatesUpdated) changedResources.push('candidates');
    if (changes.eventAppended) changedResources.push('events');
    if (changes.settingsUpdated) changedResources.push('settings');
    this.logger.info('health:check', 'completed', {
      source,
      runId,
      status: saved.status,
      reachableSites: [...directResults, ...proxyResults].filter(
        (item) => item.reachable,
      ).length,
      totalSites: directResults.length + proxyResults.length,
      durationMs: Date.now() - startedAt,
      changedResources,
    });
    return {
      snapshot: saved,
      changes,
      autoSwitchRequest: this.prepareAutoSwitch(saved, changes),
    };
  }

  /** 根据最新设置和最终健康快照决定是否建议自动切换。 */
  private prepareAutoSwitch(
    snapshot: HealthSnapshot,
    changes: HealthCheckChanges,
  ): AutoSwitchRequest | null {
    const settings = this.options.store.settings.getSettings();
    if (!canAutoSwitch(settings, snapshot, this.now().getTime())) return null;
    return {
      currentIp: snapshot.lock.ip,
      profileUid: snapshot.profile.uid,
      reuseDiagnosis: changes.candidatesUpdated,
    };
  }

  /** 记录订阅切换或同订阅内容更新，失败不影响健康快照。 */
  private appendIdentityEventSafely(
    change: 'profile' | 'content',
    snapshot: HealthSnapshot,
  ) {
    try {
      this.options.store.events.appendEvent({
        type: change === 'profile' ? 'profile_changed' : 'subscription_updated',
        severity: 'warning',
        retention: 'ordinary',
        summary:
          change === 'profile'
            ? '当前订阅已切换，自动切换已关闭'
            : '当前订阅内容已更新，旧诊断已失效',
        profileUid: snapshot.profile?.uid ?? null,
      });
      return true;
    } catch (error) {
      this.logger.warn('health:check', 'identity event append failed', {
        change,
        error,
      });
      return false;
    }
  }

  /** 状态命令失败时保留站点结果并把身份降级为未知。 */
  private async readStatusSafely(): Promise<LegacyStatus | null> {
    try {
      return await this.options.legacy.getStatus();
    } catch (error) {
      this.logger.warn('health:check', 'status read failed', {
        errorCode:
          error instanceof Error && 'code' in error
            ? String(error.code)
            : 'INTERNAL_ERROR',
      });
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
  ): boolean {
    try {
      this.options.store.events.appendEvent({
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
      return true;
    } catch (error) {
      this.logger.warn('health:check', 'status event append failed', {
        currentStatus: snapshot.status,
        error,
      });
      // 状态变化事件属于辅助审计，失败不能反转已保存的健康结果。
      return false;
    }
  }
}
