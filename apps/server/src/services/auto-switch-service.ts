import type {
  DiagnosisCandidate,
  HealthSnapshot,
  OperationResult,
  StoredJsonObject,
  StreamResource,
  TaskRecoveryStatus,
} from '@clash-sentinel/shared';
import { LegacyAdapterError, type LegacyAdapter } from '../legacy/adapter.js';
import { noopLogger, type AppLogger } from '../logging.js';
import type { SqliteStore } from '../storage/store.js';
import type {
  HealthCheckExecution,
  HealthCheckSource,
} from './health/health-check.js';

type AutoSwitchLegacyOperations = Pick<LegacyAdapter, 'diagnose' | 'applyIp'>;

export interface AutoSwitchServiceOptions {
  store: SqliteStore;
  adapter: AutoSwitchLegacyOperations;
  now?: () => Date;
  logger?: AppLogger;
}

/** TaskService 创建自动任务前得到的业务执行计划。 */
export interface AutoSwitchPlan {
  input: StoredJsonObject;
  snapshot: HealthSnapshot;
  source: HealthCheckSource;
  parentId: string;
  reuseDiagnosis: boolean;
  phase: 'diagnose' | 'apply';
}

/** 自动切换动作交给 TaskService 持久化的业务结果。 */
export interface AutoSwitchExecution {
  result: StoredJsonObject;
  changedResources: StreamResource[];
  eventSummary?: string;
  eventDetails?: StoredJsonObject | null;
}

/** 自动切换失败后的恢复状态和资源变化。 */
export interface AutoSwitchFailureHandling {
  recoveryStatus: TaskRecoveryStatus;
  changedResources: StreamResource[];
}

/** 在健康轮次持有的全局租约内执行自动诊断、切换、冷却和故障保护。 */
export class AutoSwitchService {
  private readonly now: () => Date;
  private readonly logger: AppLogger;

  constructor(private readonly options: AutoSwitchServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? noopLogger;
  }

  prepare(
    health: HealthCheckExecution,
    source: HealthCheckSource,
    parentId: string,
  ): AutoSwitchPlan | null {
    const settings = this.options.store.getSettings();
    const snapshot = health.snapshot;
    if (
      !settings.autoSwitchEnabled ||
      !snapshot.profile ||
      settings.autoSwitchProfileUid !== snapshot.profile.uid ||
      snapshot.status !== 'entry_down' ||
      (snapshot.internetSuccess ?? 0) < 2 ||
      snapshot.consecutiveFailures < settings.entryFailureThreshold ||
      (snapshot.autoSwitchCooldownUntil !== null &&
        Date.parse(snapshot.autoSwitchCooldownUntil) > this.now().getTime())
    )
      return null;
    if (!snapshot.lock.locked) return null;
    return {
      input: {
        trigger: source,
        parentId,
        currentIp: snapshot.lock.ip,
      },
      snapshot,
      source,
      parentId,
      reuseDiagnosis: health.changes.candidatesUpdated,
      phase: 'diagnose',
    };
  }

  async execute(plan: AutoSwitchPlan): Promise<AutoSwitchExecution> {
    const settings = this.options.store.getSettings();
    const snapshot = plan.snapshot;
    if (!snapshot.lock.locked) throw new Error('自动切换计划缺少锁定入口');
    const lock = snapshot.lock;
    const diagnosis = plan.reuseDiagnosis
      ? this.options.store.getDiagnosis()
      : this.options.store.replaceDiagnosis(
          await this.options.adapter.diagnose(),
        );
    const changedResources: StreamResource[] = ['monitoring', 'status'];
    if (!plan.reuseDiagnosis) changedResources.push('candidates');
    const candidate = this.selectCandidate(
      diagnosis?.candidates ?? [],
      lock.ip,
    );
    if (!candidate) {
      this.writeCooldown(snapshot, settings.autoSwitchCooldownMs, null);
      const result: OperationResult = {
        status: 'no_change',
        domain: lock.domain,
        ip: lock.ip,
        message: '严格诊断未找到不同于当前地址的合格候选',
      };
      return {
        result: result as StoredJsonObject,
        changedResources,
        eventSummary: '自动切换未找到合格备选，已进入冷却',
        eventDetails: { currentIp: lock.ip },
      };
    }
    this.writeRecommended(snapshot, candidate.ip);
    plan.phase = 'apply';
    const result = await this.options.adapter.applyIp(candidate.ip);
    this.writeSuccess(snapshot, candidate.ip, settings.autoSwitchCooldownMs);
    return {
      result: result as StoredJsonObject,
      changedResources,
      eventSummary: `自动切换已完成：${lock.ip} → ${candidate.ip}`,
      eventDetails: {
        previousIp: lock.ip,
        currentIp: candidate.ip,
      },
    };
  }

  handleFailure(
    plan: AutoSwitchPlan,
    error: unknown,
    recoveryStatus: TaskRecoveryStatus | null,
  ): AutoSwitchFailureHandling {
    const handling = this.applyFailurePolicy(
      plan.snapshot,
      this.options.store.getSettings().autoSwitchCooldownMs,
      plan.phase,
      error,
      recoveryStatus,
    );
    this.logger.info('health:scheduler', 'automatic handling completed', {
      trigger: plan.source,
      parentId: plan.parentId,
      succeeded: false,
    });
    return handling;
  }

  private selectCandidate(candidates: DiagnosisCandidate[], currentIp: string) {
    return candidates
      .filter((item) => item.eligible && item.ip !== currentIp)
      .sort(
        (left, right) =>
          left.averageMs - right.averageMs || left.ip.localeCompare(right.ip),
      )[0];
  }

  private applyFailurePolicy(
    snapshot: HealthSnapshot,
    cooldownMs: number,
    phase: 'diagnose' | 'apply',
    error: unknown,
    recoveryStatus: TaskRecoveryStatus | null,
  ) {
    const effectiveRecovery =
      phase === 'diagnose' ? 'not_required' : (recoveryStatus ?? 'unknown');
    const changedResources: StreamResource[] = [
      'monitoring',
      'status',
      'candidates',
    ];
    if (
      effectiveRecovery === 'recovery_failed' ||
      effectiveRecovery === 'unknown'
    ) {
      this.options.store.updateSettings({
        autoSwitchEnabled: false,
        autoSwitchProfileUid: null,
      });
      changedResources.push('settings');
    } else {
      this.writeCooldown(snapshot, cooldownMs, snapshot.recommendedIp);
    }
    if (error instanceof LegacyAdapterError)
      this.logger.warn('health:scheduler', 'automatic handling rejected', {
        errorCode: error.code,
        recoveryStatus: effectiveRecovery,
      });
    return { recoveryStatus: effectiveRecovery, changedResources };
  }

  private writeRecommended(snapshot: HealthSnapshot, recommendedIp: string) {
    this.options.store.upsertHealthSnapshot({
      ...snapshot,
      recommendedIp,
      updatedAt: this.now().toISOString(),
    });
  }

  private writeCooldown(
    snapshot: HealthSnapshot,
    cooldownMs: number,
    recommendedIp: string | null,
  ) {
    const completedAt = this.now();
    this.options.store.upsertHealthSnapshot({
      ...snapshot,
      recommendedIp,
      autoSwitchCooldownUntil: new Date(
        completedAt.getTime() + cooldownMs,
      ).toISOString(),
      updatedAt: completedAt.toISOString(),
    });
  }

  private writeSuccess(
    snapshot: HealthSnapshot,
    ip: string,
    cooldownMs: number,
  ) {
    const completedAt = this.now();
    this.options.store.upsertHealthSnapshot({
      ...snapshot,
      status: 'healthy',
      lock: {
        locked: true,
        domain: snapshot.lock.locked ? snapshot.lock.domain : '',
        ip,
      },
      consecutiveFailures: 0,
      recommendedIp: null,
      autoSwitchCooldownUntil: new Date(
        completedAt.getTime() + cooldownMs,
      ).toISOString(),
      updatedAt: completedAt.toISOString(),
    });
  }
}
