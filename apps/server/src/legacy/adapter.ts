import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  ipv4Schema,
  type DiagnosisResult,
  type HealthCheckResult,
  type LegacyErrorCode,
  type LegacyStatus,
  type OperationResult,
  type TaskRecoveryStatus,
} from '@clash-sentinel/shared';
import {
  LegacyParseError,
  parseDiagnosisReport,
  parseMonitorState,
  parseOperationOutput,
  parseStatusOutput,
} from './parsers.js';
import { noopLogger, type AppLogger } from '../logging.js';

/** Legacy 适配层允许执行的固定 Shell 命令。 */
type LegacyCommand =
  'status' | 'diagnose' | 'health' | 'apply' | 'reset' | 'rollback';

/** 创建 Legacy 适配器所需的脚本、隔离目录和进程控制配置。 */
export interface LegacyAdapterOptions {
  /** Legacy Shell 脚本的绝对或相对路径。 */
  scriptPath: string;
  /** Clash Verge Rev 配置根目录。 */
  appDir: string;
  /** `monitor-state.tsv` 和 `latest-report.tsv` 的保存目录。 */
  stateDir: string;
  /** 带时间戳的历史诊断报告保存目录。 */
  reportDir: string;
  /** apply、reset 和 rollback 使用的配置备份目录。 */
  backupDir: string;
  /** 传递给子进程的附加环境变量；固定目录变量仍由适配器覆盖。 */
  environment?: NodeJS.ProcessEnv;
  /** Mihomo TCP 控制接口密钥；不写入任务和日志。 */
  controllerSecret?: string;
  /** 按命令覆盖默认超时时间，单位为毫秒。 */
  timeouts?: Partial<Record<LegacyCommand, number>>;
  /** 发送 SIGTERM 后等待 SIGKILL 的宽限时间，单位为毫秒。 */
  terminateGraceMs?: number;
  /** 记录命令类别、耗时和脱敏结果摘要。 */
  logger?: AppLogger;
}

/** 各 Legacy 命令的默认执行超时时间，单位为毫秒。 */
const DEFAULT_TIMEOUTS: Record<LegacyCommand, number> = {
  status: 10_000,
  diagnose: 180_000,
  health: 45_000,
  apply: 60_000,
  reset: 60_000,
  rollback: 60_000,
};
/** 单个输出流和合并日志允许保留的最大字符数。 */
const OUTPUT_LIMIT = 256 * 1024;

/** Legacy 命令执行、解析或超时时向业务层暴露的稳定错误。 */
export class LegacyAdapterError extends Error {
  /**
   * 创建带稳定错误码和可选子进程退出码的适配层错误。
   *
   * @param code 供业务层判断失败类型的稳定错误码。
   * @param message 已移除敏感路径和密钥的错误说明。
   * @param exitCode Legacy 子进程退出码；进程未正常启动时为 null。
   */
  constructor(
    public readonly code: LegacyErrorCode,
    message: string,
    public readonly exitCode: number | null = null,
    public readonly recoveryStatus: TaskRecoveryStatus | null = null,
  ) {
    super(message);
    this.name = 'LegacyAdapterError';
  }
}

/** Legacy 子进程成功退出后捕获的原始输出。 */
interface CommandOutput {
  /** 标准输出文本。 */
  stdout: string;
  /** 标准错误文本。 */
  stderr: string;
}

/** 在固定安全边界内调用 Legacy Shell，并将结果转换为领域对象。 */
export class LegacyAdapter {
  private readonly options: LegacyAdapterOptions;
  private readonly logger: AppLogger;

  /**
   * 创建 Legacy Shell 适配器，并将所有运行目录规范化为绝对路径。
   *
   * @param options 脚本路径、隔离目录、环境变量和可选超时配置。
   */
  constructor(options: LegacyAdapterOptions) {
    this.options = {
      ...options,
      scriptPath: resolve(options.scriptPath),
      appDir: resolve(options.appDir),
      stateDir: resolve(options.stateDir),
      reportDir: resolve(options.reportDir),
      backupDir: resolve(options.backupDir),
    };
    this.logger = options.logger ?? noopLogger;
  }

  /**
   * 查询当前订阅、入口锁定、Mihomo 控制接口和最近任务摘要。
   *
   * @returns 类型化且不包含原始配置路径的当前状态。
   * @throws {LegacyAdapterError} 命令失败、超时或输出无法解析时抛出。
   */
  async getStatus(): Promise<LegacyStatus> {
    const { stdout } = await this.run('status', []);
    return this.parse(() => parseStatusOutput(stdout));
  }

  /**
   * 执行严格入口诊断并读取最新诊断报告。
   *
   * @returns 候选 IP、测试结果、推荐地址或稳定跳过原因。
   * @throws {LegacyAdapterError} 命令失败、超时、报告缺失或格式非法时抛出。
   */
  async diagnose(): Promise<DiagnosisResult> {
    await this.run('diagnose', []);
    return this.readLatestDiagnosis();
  }

  /**
   * 只读取并解析 Legacy 最近诊断，不启动新的 Shell 诊断。
   *
   * @returns 最近候选、测试结果、推荐地址或稳定跳过原因。
   * @throws {LegacyAdapterError} 报告缺失、读取失败或格式非法时抛出。
   */
  async readLatestDiagnosis(): Promise<DiagnosisResult> {
    const report = await this.readRequiredFile(
      resolve(this.options.stateDir, 'latest-report.tsv'),
      '诊断报告不存在',
    );
    return this.parse(() => parseDiagnosisReport(report));
  }

  /**
   * 检查互联网基线和当前锁定入口，并读取最新健康状态快照。
   *
   * @returns 类型化健康状态、连续失败次数和可选推荐 IP。
   * @throws {LegacyAdapterError} 命令失败、超时、状态文件缺失或格式非法时抛出。
   */
  async healthCheck(failureThreshold?: number): Promise<HealthCheckResult> {
    await this.run(
      'health',
      [],
      failureThreshold === undefined
        ? undefined
        : { CLASH_ENTRY_FAIL_THRESHOLD: String(failureThreshold) },
    );
    const state = await this.readRequiredFile(
      resolve(this.options.stateDir, 'monitor-state.tsv'),
      '监控状态不存在',
    );
    return this.parse(() => parseMonitorState(state));
  }

  /**
   * 将当前订阅锁定到最近严格诊断中合格的 IPv4。
   *
   * @param ip 用户确认应用的候选 IPv4。
   * @returns 应用成功或无需重复应用的稳定结果。
   * @throws {LegacyAdapterError} IP 非法、报告失效、订阅变化或应用失败时抛出。
   */
  async applyIp(ip: string): Promise<OperationResult> {
    const validated = ipv4Schema.safeParse(ip);
    if (!validated.success)
      throw new LegacyAdapterError('INVALID_CANDIDATE', '候选 IP 格式无效');
    const { stdout } = await this.run('apply', [validated.data]);
    return this.parse(() => parseOperationOutput('apply', stdout));
  }

  /**
   * 移除工具管理的入口锁定并恢复订阅原始域名。
   *
   * @returns 重置成功或当前无需重置的稳定结果。
   * @throws {LegacyAdapterError} 命令超时、控制接口不可用或恢复失败时抛出。
   */
  async resetLock(): Promise<OperationResult> {
    const { stdout } = await this.run('reset', []);
    return this.parse(() => parseOperationOutput('reset', stdout));
  }

  /**
   * 撤销最近一次成功的 apply 或 reset 操作。
   *
   * @returns 回滚成功的稳定结果。
   * @throws {LegacyAdapterError} 没有备份、命令超时或恢复失败时抛出。
   */
  async rollback(): Promise<OperationResult> {
    const { stdout } = await this.run('rollback', []);
    return this.parse(() => parseOperationOutput('rollback', stdout));
  }

  /**
   * 执行解析函数，并将所有解析异常统一包装为适配层错误。
   *
   * @param parser 延迟执行的领域结果解析函数。
   * @returns 解析函数产生的类型化结果。
   * @throws {LegacyAdapterError} 解析失败时抛出 `PARSE_ERROR`。
   */
  private parse<T>(parser: () => T): T {
    try {
      return parser();
    } catch (error) {
      if (error instanceof LegacyAdapterError) throw error;
      const message =
        error instanceof LegacyParseError
          ? error.message
          : 'Legacy 输出解析失败';
      throw new LegacyAdapterError('PARSE_ERROR', message);
    }
  }

  /**
   * 读取命令成功后必须存在的状态文件。
   *
   * @param path 状态文件绝对路径。
   * @param message 文件无法读取时使用的公开错误说明。
   * @returns 文件的 UTF-8 文本内容。
   * @throws {LegacyAdapterError} 文件不存在或不可读时抛出 `PARSE_ERROR`。
   */
  private async readRequiredFile(path: string, message: string) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      throw new LegacyAdapterError('PARSE_ERROR', message);
    }
  }

  /**
   * 以固定命令和参数数组启动 Legacy 脚本，并负责超时、进程组终止及安全摘要日志。
   *
   * @param command 允许执行的固定 Legacy 命令。
   * @param extraArgs 已完成上层校验的附加参数数组。
   * @returns 子进程成功退出时捕获的标准输出和标准错误。
   * @throws {LegacyAdapterError} 启动失败、异常退出或超过命令超时时抛出。
   */
  private async run(
    command: LegacyCommand,
    extraArgs: readonly string[],
    environmentOverrides?: NodeJS.ProcessEnv,
  ): Promise<CommandOutput> {
    const args = [command, ...extraArgs];
    const timeoutMs =
      this.options.timeouts?.[command] ?? DEFAULT_TIMEOUTS[command];
    const startedAt = Date.now();
    this.logger.debug('legacy:adapter', 'command started', {
      command,
      timeoutMs,
    });
    const environment = {
      ...process.env,
      ...this.options.environment,
      CLASH_APP_DIR: this.options.appDir,
      CLASH_ENTRY_STATE_DIR: this.options.stateDir,
      CLASH_ENTRY_REPORT_DIR: this.options.reportDir,
      CLASH_ENTRY_BACKUP_DIR: this.options.backupDir,
      CLASH_SENTINEL_CONTROLLER_SECRET:
        this.options.controllerSecret ?? 'set-your-secret',
      ...environmentOverrides,
    };

    return await new Promise<CommandOutput>((resolvePromise, rejectPromise) => {
      const child = spawn(this.options.scriptPath, args, {
        detached: true,
        env: environment,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let combined = '';
      let truncated = false;
      let timedOut = false;
      let spawnError: Error | null = null;
      let forceTimer: NodeJS.Timeout | undefined;

      const append = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
        const value = chunk.toString('utf8');
        if (stream === 'stdout') stdout = this.appendLimited(stdout, value);
        else stderr = this.appendLimited(stderr, value);
        if (combined.length < OUTPUT_LIMIT) {
          const room = OUTPUT_LIMIT - combined.length;
          combined += value.slice(0, room);
          if (value.length > room) truncated = true;
        } else truncated = true;
      };
      child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
      child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
      child.once('error', (error) => {
        spawnError = error;
      });

      const timeout = setTimeout(() => {
        timedOut = true;
        this.signalProcessGroup(child.pid, 'SIGTERM');
        forceTimer = setTimeout(
          () => this.signalProcessGroup(child.pid, 'SIGKILL'),
          this.options.terminateGraceMs ?? 750,
        );
        forceTimer.unref();
      }, timeoutMs);
      timeout.unref();

      child.once('close', async (code) => {
        clearTimeout(timeout);
        if (forceTimer) clearTimeout(forceTimer);
        const durationMs = Date.now() - startedAt;
        const outputMetadata = {
          command,
          durationMs,
          exitCode: code,
          stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
          stderrBytes: Buffer.byteLength(stderr, 'utf8'),
          outputTruncated: truncated,
        };
        if (timedOut) {
          this.logger.error('legacy:adapter', 'command timeout', {
            ...outputMetadata,
            errorCode: 'TIMEOUT',
          });
          rejectPromise(
            new LegacyAdapterError(
              'TIMEOUT',
              `${command} 执行超时`,
              code,
              this.isCritical(command) ? 'unknown' : null,
            ),
          );
          return;
        }
        if (spawnError) {
          this.logger.error('legacy:adapter', 'command failed to start', {
            ...outputMetadata,
            errorCode: 'PROCESS_EXITED',
          });
          rejectPromise(
            new LegacyAdapterError(
              'PROCESS_EXITED',
              `${command} 无法启动`,
              null,
              this.isCritical(command) ? 'unknown' : null,
            ),
          );
          return;
        }
        if (code !== 0) {
          const safeOutput = this.sanitize(`${stderr}\n${stdout}`).trim();
          const errorCode = this.mapErrorCode(command, safeOutput);
          const recoveryStatus = this.recoveryStatus(
            command,
            errorCode,
            safeOutput,
          );
          this.logger.error('legacy:adapter', 'command failed', {
            ...outputMetadata,
            errorCode,
          });
          rejectPromise(
            new LegacyAdapterError(
              errorCode,
              this.publicErrorMessage(command, safeOutput),
              code,
              recoveryStatus,
            ),
          );
          return;
        }
        this.logger.debug(
          'legacy:adapter',
          'command completed',
          outputMetadata,
        );
        resolvePromise({ stdout, stderr });
      });
    });
  }

  /**
   * 在固定上限内追加子进程输出，防止异常输出耗尽内存。
   *
   * @param current 已捕获的输出。
   * @param value 本次收到的输出片段。
   * @returns 截断到输出上限的合并文本。
   */
  private appendLimited(current: string, value: string) {
    if (current.length >= OUTPUT_LIMIT) return current;
    return current + value.slice(0, OUTPUT_LIMIT - current.length);
  }

  /**
   * 优先向独立进程组发送信号，无法定位进程组时回退到单个子进程。
   *
   * @param pid Legacy 根子进程 ID。
   * @param signal 需要发送的终止信号。
   */
  private signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals) {
    if (!pid) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // 进程已经退出。
      }
    }
  }

  /**
   * 从命令输出中替换用户目录、运行目录和控制密钥。
   *
   * @param output 原始命令输出。
   * @returns 可安全用于日志和公开错误的脱敏文本。
   */
  private sanitize(output: string) {
    const replacements = [
      this.options.appDir,
      this.options.stateDir,
      this.options.reportDir,
      this.options.backupDir,
      process.env.HOME,
    ].filter((value): value is string => Boolean(value));
    let sanitized = output;
    for (const value of [...new Set(replacements)].sort(
      (a, b) => b.length - a.length,
    ))
      sanitized = sanitized.split(value).join('[路径已脱敏]');
    sanitized = sanitized.replace(/(secret\s*[:=]\s*)\S+/gi, '$1[已脱敏]');
    return sanitized;
  }

  /**
   * 根据固定 Legacy 错误文案和命令上下文映射稳定错误码。
   *
   * @param command 执行失败的 Legacy 命令。
   * @param output 已脱敏的错误输出。
   * @returns 供业务层处理的稳定错误码。
   */
  private mapErrorCode(
    command: LegacyCommand,
    output: string,
  ): LegacyErrorCode {
    if (/报告已过期/.test(output)) return 'REPORT_EXPIRED';
    if (/当前订阅已切换/.test(output)) return 'PROFILE_CHANGED';
    if (/当前订阅已更新/.test(output)) return 'SUBSCRIPTION_UPDATED';
    if (/控制接口认证失败/.test(output)) return 'CONTROLLER_UNAVAILABLE';
    if (/未通过最近一次严格检测|非法 IPv4/.test(output))
      return 'INVALID_CANDIDATE';
    if (/控制接口不可连接/.test(output)) return 'CONTROLLER_UNAVAILABLE';
    if (/尚未锁定入口 IP/.test(output)) return 'NOT_LOCKED';
    if (/没有可回滚|备份清单不存在/.test(output)) return 'NO_BACKUP';
    if (/没有候选|推荐 IP：无/.test(output)) return 'NO_CANDIDATE';
    if (
      /自定义逻辑|最近诊断已跳过|脚本覆写不存在|受管脚本内容不完整|运行配置中没有可替换/.test(
        output,
      )
    )
      return 'UNSUPPORTED_CONFIG';
    if (command === 'apply' && /应用失败/.test(output)) return 'APPLY_FAILED';
    if (command === 'reset' && /恢复失败/.test(output)) return 'RESET_FAILED';
    if (command === 'rollback' && /恢复失败|重载失败/.test(output))
      return 'ROLLBACK_FAILED';
    return 'PROCESS_EXITED';
  }

  /**
   * 从脱敏输出提取首条有效信息，构造可公开的命令错误说明。
   *
   * @param command 执行失败的 Legacy 命令。
   * @param output 已脱敏的错误输出。
   * @returns 不包含运行路径和密钥的错误信息。
   */
  private publicErrorMessage(command: LegacyCommand, output: string) {
    const detail = output
      .split(/\r?\n/)
      .map((line) =>
        line
          .replace(/RECOVERY_STATUS=(?:recovered|recovery_failed)\s*/g, '')
          .trim(),
      )
      .find(Boolean);
    return detail ? `${command} 失败：${detail}` : `${command} 异常退出`;
  }

  /** 配置动作失败时将脚本恢复标记转换为稳定任务契约。 */
  private recoveryStatus(
    command: LegacyCommand,
    errorCode: LegacyErrorCode,
    output: string,
  ): TaskRecoveryStatus | null {
    if (!this.isCritical(command)) return null;
    const marker = output.match(
      /RECOVERY_STATUS=(recovered|recovery_failed)\b/,
    )?.[1];
    if (marker === 'recovered' || marker === 'recovery_failed') return marker;
    if (
      [
        'NO_CANDIDATE',
        'REPORT_EXPIRED',
        'PROFILE_CHANGED',
        'SUBSCRIPTION_UPDATED',
        'INVALID_CANDIDATE',
        'CONTROLLER_UNAVAILABLE',
        'NOT_LOCKED',
        'NO_BACKUP',
        'UNSUPPORTED_CONFIG',
      ].includes(errorCode)
    )
      return 'not_required';
    return 'unknown';
  }

  private isCritical(command: LegacyCommand) {
    return command === 'apply' || command === 'reset' || command === 'rollback';
  }
}
