import {
  diagnosisResultSchema,
  healthCheckResultSchema,
  legacyStatusSchema,
  operationResultSchema,
  type DiagnosisResult,
  type HealthCheckResult,
  type LegacyStatus,
  type OperationResult,
} from '@clash-sentinel/shared';

/** Legacy 状态文件或控制台输出不符合约定格式时抛出的错误。 */
export class LegacyParseError extends Error {
  /** 创建一个表示 Legacy 文件或控制台输出结构无效的解析错误。 */
  constructor(message: string) {
    super(message);
    this.name = 'LegacyParseError';
  }
}

/**
 * 将必填 TSV 字段解析为非负整数。
 *
 * @param value 原始字段值。
 * @param field 用于错误信息的字段名。
 * @returns 解析后的非负整数。
 * @throws {LegacyParseError} 字段为空、含非数字字符或格式非法时抛出。
 */
function parseInteger(value: string | undefined, field: string) {
  if (!value || !/^\d+$/.test(value))
    throw new LegacyParseError(`字段 ${field} 不是非负整数`);
  return Number(value);
}

/**
 * 将必填 TSV 字段解析为正整数。
 *
 * @param value 原始字段值。
 * @param field 用于错误信息的字段名。
 * @returns 解析后的正整数。
 * @throws {LegacyParseError} 字段不是大于零的整数时抛出。
 */
function parsePositiveInteger(value: string | undefined, field: string) {
  const parsed = parseInteger(value, field);
  if (parsed < 1) throw new LegacyParseError(`字段 ${field} 不是正整数`);
  return parsed;
}

/**
 * 将空值或 Legacy 占位符转换为 null。
 *
 * @param value 原始字段值。
 * @returns 有效文本，或表示无值的 null。
 */
function nullIfEmptyOrDash(value: string | undefined) {
  return value && value !== '-' ? value : null;
}

/** 诊断跳过原因对应的固定脱敏说明。 */
const skipDetails = {
  no_real_nodes: '未识别到可检测的真实代理节点',
  fixed_ip: '订阅已使用固定 IP',
  multiple_ips: '订阅包含多个独立 IP',
  mixed_endpoints: '订阅同时包含域名和 IP',
  multiple_domains: '订阅包含多个入口域名',
  ipv6_only: '入口仅解析到 IPv6',
  no_ipv4: '入口未解析到有效 IPv4',
  single_dns_ip: '入口只解析到一个 IPv4',
} as const;

/**
 * 收集诊断报告中以 `# ` 开头的 TSV 元数据。
 *
 * @param content 完整诊断报告文本。
 * @returns 以元数据名称为键的值映射。
 */
function parseMetadata(content: string) {
  const metadata = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    if (!line.startsWith('# ')) continue;
    const separator = line.indexOf('\t');
    if (separator < 0) continue;
    metadata.set(line.slice(2, separator), line.slice(separator + 1));
  }
  return metadata;
}

/**
 * 将 Legacy 严格诊断 TSV 转换为脱敏、类型化的诊断结果。
 *
 * @param content `latest-report.tsv` 或时间戳诊断报告的完整内容。
 * @returns 通过共享 Schema 校验的诊断结果。
 * @throws {LegacyParseError} 缺少关键元数据、候选表结构错误或字段校验失败时抛出。
 */
export function parseDiagnosisReport(content: string): DiagnosisResult {
  const metadata = parseMetadata(content);
  const status = metadata.get('status');
  if (status !== 'testable' && status !== 'skipped')
    throw new LegacyParseError('诊断报告缺少有效状态');

  const candidates = [];
  let headerFound = false;
  for (const line of content.split(/\r?\n/)) {
    if (
      line ===
      'ip\teligible\tsuccess\ttotal\tsuccess_rate\taverage_ms\tfailed_ports\tsources'
    ) {
      headerFound = true;
      continue;
    }
    if (!headerFound || !line) continue;
    const fields = line.split('\t');
    if (fields.length !== 8)
      throw new LegacyParseError('诊断候选行字段数量错误');
    const [ip, eligible, success, total, rate, average, failed, sources] =
      fields;
    if (eligible !== 'yes' && eligible !== 'no')
      throw new LegacyParseError('诊断候选资格字段错误');
    const successRate = Number(rate?.replace(/%$/, ''));
    const averageMs = Number(average);
    if (!Number.isFinite(successRate) || !Number.isFinite(averageMs))
      throw new LegacyParseError('诊断候选数值字段错误');
    candidates.push({
      ip,
      eligible: eligible === 'yes',
      success: parseInteger(success, 'success'),
      total: parsePositiveInteger(total, 'total'),
      successRate,
      averageMs,
      failedPorts:
        failed === '-'
          ? []
          : (failed ?? '')
              .split(',')
              .map((port) => parsePositiveInteger(port, 'failed_ports')),
      sources:
        sources === '-' ? [] : (sources ?? '').split(',').filter(Boolean),
    });
  }
  if (status === 'testable' && !headerFound)
    throw new LegacyParseError('可测试报告缺少候选表头');

  const ports = metadata.get('tested_ports');
  const skipReason =
    status === 'skipped'
      ? nullIfEmptyOrDash(metadata.get('skip_reason'))
      : null;
  const result = diagnosisResultSchema.safeParse({
    status,
    generatedAt: metadata.get('generated_at'),
    profile: {
      uid: metadata.get('profile_uid'),
      name: metadata.get('profile_name') ?? '',
    },
    domain: nullIfEmptyOrDash(metadata.get('domain')),
    skipReason,
    detail:
      skipReason && skipReason in skipDetails
        ? skipDetails[skipReason as keyof typeof skipDetails]
        : null,
    testedPorts:
      !ports || ports === '-'
        ? []
        : ports
            .split(',')
            .map((port) => parsePositiveInteger(port, 'tested_ports')),
    testRounds: parsePositiveInteger(
      metadata.get('test_rounds'),
      'test_rounds',
    ),
    candidates,
    recommendedIp:
      candidates.find((candidate) => candidate.eligible)?.ip ?? null,
  });
  if (!result.success)
    throw new LegacyParseError(
      `诊断报告校验失败：${result.error.issues[0]?.message}`,
    );
  return result.data;
}

/**
 * 将 Legacy 健康状态 TSV 转换为类型化健康检查结果。
 *
 * @param content `monitor-state.tsv` 的完整内容。
 * @returns 通过共享 Schema 校验的健康检查结果。
 * @throws {LegacyParseError} 行结构、数值、状态枚举或 IP 字段非法时抛出。
 */
export function parseMonitorState(content: string): HealthCheckResult {
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    if (!line) continue;
    const fields = line.split('\t');
    if (fields.length !== 2)
      throw new LegacyParseError('监控状态行字段数量错误');
    values.set(fields[0]!, fields[1]!);
  }
  const result = healthCheckResultSchema.safeParse({
    status: values.get('status'),
    checkedAt: values.get('checked_at'),
    internetSuccess: parseInteger(
      values.get('internet_success'),
      'internet_success',
    ),
    internetTotal: parsePositiveInteger(
      values.get('internet_total'),
      'internet_total',
    ),
    currentIp: values.get('current_ip'),
    consecutiveFailures: parseInteger(
      values.get('consecutive_failures'),
      'consecutive_failures',
    ),
    recommendedIp: nullIfEmptyOrDash(values.get('recommended_ip')),
    profileUid: nullIfEmptyOrDash(values.get('profile_uid')),
    rawFingerprint: nullIfEmptyOrDash(values.get('raw_fingerprint')),
    identityChanged: nullIfEmptyOrDash(values.get('identity_changed')),
  });
  if (!result.success)
    throw new LegacyParseError(
      `监控状态校验失败：${result.error.issues[0]?.message}`,
    );
  return result.data;
}

/**
 * 将 `status` 命令的控制台文本转换为当前订阅和运行状态摘要。
 *
 * @param output Legacy `status` 命令的标准输出。
 * @returns 不包含原始配置路径的类型化状态。
 * @throws {LegacyParseError} 输出缺少订阅、锁定状态或字段校验失败时抛出。
 */
export function parseStatusOutput(output: string): LegacyStatus {
  const profile = output.match(/^当前订阅：(.*)（([^（）]+)）$/m);
  if (!profile) throw new LegacyParseError('状态输出缺少当前订阅');
  const lock = output.match(/^入口锁定：(.*) -> ((?:\d{1,3}\.){3}\d{1,3})$/m);
  const unlocked = /^入口锁定：未锁定$/m.test(output);
  if (!lock && !unlocked)
    throw new LegacyParseError('状态输出缺少入口锁定状态');

  const report = output.match(
    /^最近报告：(testable|skipped)，订阅=(.*?)，域名=(.*?)，原因=(.*)$/m,
  );
  const health = output.match(
    /^后台健康：(healthy|internet_uncertain|internet_down|entry_suspected|entry_down)，连续失败=(\d+)，推荐=(.*)$/m,
  );
  const result = legacyStatusSchema.safeParse({
    profile: { name: profile[1], uid: profile[2] },
    lock: lock
      ? { locked: true, domain: lock[1], ip: lock[2] }
      : { locked: false },
    controllerAvailable: /^Mihomo控制接口：可用/m.test(output),
    controllerAuthFailed: /^Mihomo控制接口：认证失败/m.test(output),
    report: report
      ? {
          status: report[1],
          profileName: report[2],
          domain: report[3] === '-' ? null : report[3],
          skipReason: report[4] === '-' ? null : report[4],
        }
      : null,
    health: health
      ? {
          status: health[1],
          consecutiveFailures: Number(health[2]),
          recommendedIp: nullIfEmptyOrDash(health[3]),
        }
      : null,
  });
  if (!result.success)
    throw new LegacyParseError(
      `状态输出校验失败：${result.error.issues[0]?.message}`,
    );
  return result.data;
}

/**
 * 将配置修改命令的控制台文本转换为稳定操作结果。
 *
 * @param command 已执行的配置修改命令。
 * @param output 命令的标准输出。
 * @returns 应用、重置、回滚或无需变更的类型化结果。
 * @throws {LegacyParseError} 输出与指定命令的成功格式不匹配时抛出。
 */
export function parseOperationOutput(
  command: 'apply' | 'reset' | 'rollback',
  output: string,
): OperationResult {
  let value: unknown;
  const applied = output.match(
    /^已锁定当前订阅：(.*) -> ((?:\d{1,3}\.){3}\d{1,3})$/m,
  );
  const duplicate = output.match(
    /^已经锁定 (.*) -> ((?:\d{1,3}\.){3}\d{1,3})，无需重复写入$/m,
  );
  const reset = output.match(/^已恢复当前订阅的原始入口：(.*)$/m);
  if (command === 'apply' && applied)
    value = {
      status: 'applied',
      domain: applied[1],
      ip: applied[2],
      message: applied[0],
    };
  else if (command === 'apply' && duplicate)
    value = {
      status: 'no_change',
      domain: duplicate[1],
      ip: duplicate[2],
      message: duplicate[0],
    };
  else if (command === 'reset' && reset)
    value = { status: 'reset', domain: reset[1], ip: null, message: reset[0] };
  else if (
    command === 'reset' &&
    /没有由 clash-entry-ip\.sh 创建的入口锁定，无需恢复/.test(output)
  )
    value = {
      status: 'no_change',
      domain: null,
      ip: null,
      message: '当前订阅未锁定，无需恢复',
    };
  else if (command === 'rollback' && /^已恢复：/m.test(output))
    value = {
      status: 'rolled_back',
      domain: null,
      ip: null,
      message: '最近一次变更已撤销',
    };
  else throw new LegacyParseError(`${command} 输出不符合预期`);

  const result = operationResultSchema.safeParse(value);
  if (!result.success)
    throw new LegacyParseError(
      `操作结果校验失败：${result.error.issues[0]?.message}`,
    );
  return result.data;
}
