import type { LegacyAdapter } from '../../legacy/adapter.js';
import type { SqliteStore } from '../../storage/store.js';
import { asStoredJson, type TaskHandler } from './contracts.js';
import { legacyFailure } from './handler-helpers.js';

/** 执行严格诊断并用最新结果原子替换持久化候选报告。 */
export class DiagnoseTaskHandler implements TaskHandler {
  /** 注册表使用的稳定任务类型。 */
  readonly type = 'diagnose' as const;
  /** 默认任务审计摘要使用的动作名称。 */
  readonly auditName = '严格诊断';
  /** 诊断只读取网络并写报告，不属于配置恢复任务。 */
  readonly critical = false;

  /** @returns 诊断任务不接受业务参数，因此始终返回空输入。 */
  parseInput() {
    return {};
  }

  /**
   * @param store 候选报告存储。
   * @param adapter 严格诊断 Legacy 能力。
   */
  constructor(
    private readonly store: SqliteStore,
    private readonly adapter: Pick<LegacyAdapter, 'diagnose'>,
  ) {}

  /** @returns 最新持久化诊断以及 candidates/events 资源变化。 */
  async execute() {
    return {
      result: asStoredJson(
        this.store.replaceDiagnosis(await this.adapter.diagnose()),
      ),
      changedResources: ['candidates', 'events'] as const,
    };
  }

  /**
   * @param error Legacy 或未知诊断异常。
   * @returns 不包含配置恢复状态的安全诊断失败结果。
   */
  handleFailure({ error }: { error: unknown }) {
    return legacyFailure(error, false);
  }
}
