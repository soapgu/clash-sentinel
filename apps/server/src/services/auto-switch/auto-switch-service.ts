import type {
  HealthSnapshot,
  OperationResult,
  StoredJsonObject,
  StreamResource,
  TaskRecoveryStatus,
} from '@clash-sentinel/shared';
import { inject, injectable } from 'tsyringe';
import {
  LegacyAdapterError,
  type LegacyAdapter,
} from '../../legacy/adapter.js';
import { noopLogger, type AppLogger } from '../../logging.js';
import { TOKENS } from '../../composition/tokens.js';
import type { DiagnosisRepository } from '../../storage/diagnosis-repository.js';
import type { HealthRepository } from '../../storage/health-repository.js';
import type { SettingsRepository } from '../../storage/settings-repository.js';
import type { HealthCheckSource } from '../health/health-check.js';
import {
  canAutoSwitch,
  selectAutoSwitchCandidate,
} from './auto-switch-policy.js';

/** 自动切换服务允许调用的最小 Legacy 诊断和应用能力。 */
type AutoSwitchLegacyOperations = Pick<LegacyAdapter, 'diagnose' | 'applyIp'>;

/** 自动切换 Handler 内部使用的单次业务执行状态。 */
export interface AutoSwitchPlan {
  /** 创建任务时已持久化、可在执行前重新验证的输入。 */
  input: StoredJsonObject;
  /** Handler 开始执行时重新读取的权威健康快照。 */
  snapshot: HealthSnapshot;
  /** 触发自动处理的健康检查来源。 */
  source: HealthCheckSource;
  /** 手动健康任务 ID 或定时检测 runId。 */
  parentId: string;
  /** 是否可以复用当前健康轮次刚写入的诊断报告。 */
  reuseDiagnosis: boolean;
  /** 用于区分修改前失败与应用阶段失败的当前阶段。 */
  phase: 'diagnose' | 'apply';
}

/** 写入 auto_switch 任务 input_json 的最小可恢复上下文。 */
export interface AutoSwitchTaskInput extends StoredJsonObject {
  /** 触发来源，用于日志和审计关联。 */
  trigger: HealthCheckSource;
  /** 触发自动处理的健康任务 ID 或调度 runId。 */
  parentId: string;
  /** 规划时的锁定 IP，用于执行前检测上下文漂移。 */
  currentIp: string;
  /** 规划时的订阅 UID，用于阻止跨订阅执行。 */
  profileUid: string;
  /** 当前健康轮次是否已经产生可复用诊断。 */
  reuseDiagnosis: boolean;
}

/** 自动切换动作交给 TaskEngine 持久化的业务结果。 */
export interface AutoSwitchExecution {
  /** 写入任务 result_json 的操作结果。 */
  result: StoredJsonObject;
  /** 自动处理实际改变的前端资源。 */
  changedResources: StreamResource[];
  /** 覆盖默认任务成功摘要的业务说明。 */
  eventSummary?: string;
  /** 自动切换前后 IP 等安全审计详情。 */
  eventDetails?: StoredJsonObject | null;
}

/** 自动切换失败后的恢复状态和资源变化。 */
export interface AutoSwitchFailureHandling {
  /** 修改前拒绝、已恢复或需要人工处理的状态。 */
  recoveryStatus: TaskRecoveryStatus;
  /** 冷却、健康或设置变化对应的失效资源。 */
  changedResources: StreamResource[];
}

/** 在健康轮次持有的全局租约内执行自动诊断、切换、冷却和故障保护。 */
@injectable()
export class AutoSwitchService {
  /** 统一生成冷却截止时间的可注入时钟。 */
  private readonly now: () => Date;
  /** 自动处理领域日志器。 */
  private readonly logger: AppLogger;

  /**
   * @param settings 读取和更新自动切换设置的设置仓储。
   * @param health 读取和写入健康快照的健康仓储。
   * @param diagnoses 读取和替换诊断摘要的诊断仓储。
   * @param adapter 执行严格诊断和应用候选 IP 的 Legacy 能力。
   * @param now 测试可注入的当前时间提供器。
   * @param logger 记录自动处理结果和拒绝原因的统一日志器。
   */
  constructor(
    @inject(TOKENS.settingsRepository)
    private readonly settings: Pick<
      SettingsRepository,
      'getSettings' | 'updateSettings'
    >,
    @inject(TOKENS.healthRepository)
    private readonly health: Pick<
      HealthRepository,
      'getHealthSnapshot' | 'upsertHealthSnapshot'
    >,
    @inject(TOKENS.diagnosisRepository)
    private readonly diagnoses: Pick<
      DiagnosisRepository,
      'getDiagnosis' | 'replaceDiagnosis'
    >,
    @inject(TOKENS.legacyAdapter)
    private readonly adapter: AutoSwitchLegacyOperations,
    @inject(TOKENS.dateClock) now: () => Date = () => new Date(),
    @inject(TOKENS.appLogger) logger: AppLogger = noopLogger,
  ) {
    this.now = now;
    this.logger = logger;
  }

  /**
   * 从持久化输入和当前权威快照恢复单次执行计划。
   *
   * @param input auto_switch 任务表中保存的上下文。
   * @returns 基于当前权威快照重建的进程内计划。
   * @throws 输入不完整、订阅变化或锁定 IP 漂移时拒绝恢复。
   */
  restorePlan(input: StoredJsonObject | null): AutoSwitchPlan {
    const source = input?.trigger;
    const parentId = input?.parentId;
    const currentIp = input?.currentIp;
    const profileUid = input?.profileUid;
    const reuseDiagnosis = input?.reuseDiagnosis;
    const snapshot = this.health.getHealthSnapshot();
    if (
      (source !== 'manual' && source !== 'scheduled') ||
      typeof parentId !== 'string' ||
      typeof currentIp !== 'string' ||
      typeof profileUid !== 'string' ||
      typeof reuseDiagnosis !== 'boolean' ||
      !snapshot?.profile ||
      snapshot.profile.uid !== profileUid ||
      !snapshot.lock.locked ||
      snapshot.lock.ip !== currentIp
    )
      throw new Error('自动切换任务上下文已失效');
    return {
      input: input as StoredJsonObject,
      snapshot,
      source,
      parentId,
      reuseDiagnosis,
      phase: 'diagnose',
    };
  }

  /**
   * 复核当前设置并执行诊断、候选选择、应用和冷却写入。
   *
   * @param plan Handler 从持久化输入恢复的单次执行计划。
   * @returns 任务结果、精确资源变化和定制审计信息。
   * @throws 条件失效、诊断失败或配置应用失败时交由 Handler 处理。
   */
  async execute(plan: AutoSwitchPlan): Promise<AutoSwitchExecution> {
    const settings = this.settings.getSettings();
    const snapshot = plan.snapshot;
    if (!canAutoSwitch(settings, snapshot, this.now().getTime()))
      throw new Error('自动切换执行条件已失效');
    const lock = snapshot.lock;
    const diagnosis = plan.reuseDiagnosis
      ? this.diagnoses.getDiagnosis()
      : this.diagnoses.replaceDiagnosis(await this.adapter.diagnose());
    const changedResources: StreamResource[] = ['monitoring', 'status'];
    if (!plan.reuseDiagnosis) changedResources.push('candidates');
    const candidate = selectAutoSwitchCandidate(
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
    const result = await this.adapter.applyIp(candidate.ip);
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

  /**
   * 根据失败阶段和 Legacy 恢复结论执行冷却或安全关闭。
   *
   * @param plan 正在执行且记录了当前阶段的自动切换计划。
   * @param error 诊断或应用阶段抛出的原始异常。
   * @param recoveryStatus 配置动作已经确认的恢复状态。
   * @returns TaskEngine 可持久化的恢复状态和资源变化。
   */
  handleFailure(
    plan: AutoSwitchPlan,
    error: unknown,
    recoveryStatus: TaskRecoveryStatus | null,
  ): AutoSwitchFailureHandling {
    const handling = this.applyFailurePolicy(
      plan.snapshot,
      this.settings.getSettings().autoSwitchCooldownMs,
      plan.phase,
      error,
      recoveryStatus,
    );
    this.logger.info('auto-switch:service', 'automatic handling completed', {
      trigger: plan.source,
      parentId: plan.parentId,
      succeeded: false,
    });
    return handling;
  }

  /**
   * 无法恢复持久化任务上下文时进入安全关闭状态。
   *
   * @returns recoveryStatus=unknown 并包含 settings 的资源变化。
   */
  handleInvalidContext(): AutoSwitchFailureHandling {
    this.settings.updateSettings({
      autoSwitchEnabled: false,
      autoSwitchProfileUid: null,
    });
    return {
      recoveryStatus: 'unknown',
      changedResources: ['monitoring', 'status', 'candidates', 'settings'],
    };
  }

  /** @returns 冷却或安全关闭后的最终恢复状态及资源变化。 */
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
      this.settings.updateSettings({
        autoSwitchEnabled: false,
        autoSwitchProfileUid: null,
      });
      changedResources.push('settings');
    } else {
      this.writeCooldown(snapshot, cooldownMs, snapshot.recommendedIp);
    }
    if (error instanceof LegacyAdapterError)
      this.logger.warn('auto-switch:service', 'automatic handling rejected', {
        errorCode: error.code,
        recoveryStatus: effectiveRecovery,
      });
    return { recoveryStatus: effectiveRecovery, changedResources };
  }

  /** 将诊断推荐地址写入当前健康快照。 */
  private writeRecommended(snapshot: HealthSnapshot, recommendedIp: string) {
    this.health.upsertHealthSnapshot({
      ...snapshot,
      recommendedIp,
      updatedAt: this.now().toISOString(),
    });
  }

  /** 从当前时间开始写入下一次允许自动处理的冷却截止时间。 */
  private writeCooldown(
    snapshot: HealthSnapshot,
    cooldownMs: number,
    recommendedIp: string | null,
  ) {
    const completedAt = this.now();
    this.health.upsertHealthSnapshot({
      ...snapshot,
      recommendedIp,
      autoSwitchCooldownUntil: new Date(
        completedAt.getTime() + cooldownMs,
      ).toISOString(),
      updatedAt: completedAt.toISOString(),
    });
  }

  /** 写入切换后的健康入口、清零失败次数并开始冷却。 */
  private writeSuccess(
    snapshot: HealthSnapshot,
    ip: string,
    cooldownMs: number,
  ) {
    const completedAt = this.now();
    this.health.upsertHealthSnapshot({
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
