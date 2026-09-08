import { z } from 'zod';

/** 校验 Koa 健康接口成功响应的共享 Schema。 */
export const healthResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    service: z.literal('clash-sentinel'),
    status: z.literal('ok'),
  }),
});
/** Koa 健康接口成功响应。 */
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** 校验四段十进制 IPv4 地址的共享 Schema。 */
export const ipv4Schema = z.string().refine((value) => {
  const parts = value.split('.');
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}, '必须是合法的 IPv4 地址');

/** 校验 Legacy 健康检查状态枚举的共享 Schema。 */
export const legacyHealthStatusSchema = z.enum([
  'healthy',
  'internet_uncertain',
  'internet_down',
  'entry_suspected',
  'entry_down',
]);
/** Legacy 健康检查产生的稳定状态。 */
export type LegacyHealthStatus = z.infer<typeof legacyHealthStatusSchema>;

/** 校验 Legacy 诊断跳过原因枚举的共享 Schema。 */
export const diagnosisSkipReasonSchema = z.enum([
  'no_real_nodes',
  'fixed_ip',
  'multiple_ips',
  'mixed_endpoints',
  'multiple_domains',
  'ipv6_only',
  'no_ipv4',
  'single_dns_ip',
]);
/** Legacy 诊断无法进入候选测试时的稳定原因。 */
export type DiagnosisSkipReason = z.infer<typeof diagnosisSkipReasonSchema>;

/** 校验单个入口候选 IP 测试结果的共享 Schema。 */
export const diagnosisCandidateSchema = z.object({
  ip: ipv4Schema,
  eligible: z.boolean(),
  success: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  successRate: z.number().min(0).max(100),
  averageMs: z.number().nonnegative(),
  failedPorts: z.array(z.number().int().min(1).max(65535)),
  sources: z.array(z.string().min(1)),
});
/** 单个入口候选 IP 的严格测试结果。 */
export type DiagnosisCandidate = z.infer<typeof diagnosisCandidateSchema>;

/** 校验完整 Legacy 诊断结果的共享 Schema。 */
export const diagnosisResultSchema = z.object({
  status: z.enum(['testable', 'skipped']),
  generatedAt: z.string().min(1),
  profile: z.object({ uid: z.string().min(1), name: z.string() }),
  domain: z.string().nullable(),
  skipReason: diagnosisSkipReasonSchema.nullable(),
  detail: z.string().nullable(),
  testedPorts: z.array(z.number().int().min(1).max(65535)),
  testRounds: z.number().int().positive(),
  candidates: z.array(diagnosisCandidateSchema),
  recommendedIp: ipv4Schema.nullable(),
});
/** 包含订阅摘要、候选列表和推荐 IP 的完整诊断结果。 */
export type DiagnosisResult = z.infer<typeof diagnosisResultSchema>;

/** 校验 Legacy 当前订阅、锁定及最近任务摘要的共享 Schema。 */
export const legacyStatusSchema = z.object({
  profile: z.object({ uid: z.string().min(1), name: z.string() }),
  lock: z.discriminatedUnion('locked', [
    z.object({ locked: z.literal(false) }),
    z.object({
      locked: z.literal(true),
      domain: z.string().min(1),
      ip: ipv4Schema,
    }),
  ]),
  controllerAvailable: z.boolean(),
  report: z
    .object({
      status: z.enum(['testable', 'skipped']),
      profileName: z.string(),
      domain: z.string().nullable(),
      skipReason: z.string().nullable(),
    })
    .nullable(),
  health: z
    .object({
      status: legacyHealthStatusSchema,
      consecutiveFailures: z.number().int().nonnegative(),
      recommendedIp: ipv4Schema.nullable(),
    })
    .nullable(),
});
/** Legacy 当前订阅、入口锁定和最近运行状态摘要。 */
export type LegacyStatus = z.infer<typeof legacyStatusSchema>;

/** 校验一次 Legacy 健康检查结果的共享 Schema。 */
export const healthCheckResultSchema = z.object({
  status: legacyHealthStatusSchema,
  checkedAt: z.string().min(1),
  internetSuccess: z.number().int().nonnegative(),
  internetTotal: z.number().int().positive(),
  currentIp: ipv4Schema,
  consecutiveFailures: z.number().int().nonnegative(),
  recommendedIp: ipv4Schema.nullable(),
});
/** 一次互联网基线和锁定入口健康检查的结果。 */
export type HealthCheckResult = z.infer<typeof healthCheckResultSchema>;

/** 校验 apply、reset 或 rollback 成功结果的共享 Schema。 */
export const operationResultSchema = z.object({
  status: z.enum(['applied', 'reset', 'rolled_back', 'no_change']),
  domain: z.string().nullable(),
  ip: ipv4Schema.nullable(),
  message: z.string().min(1),
});
/** 配置应用、解除锁定、回滚或无需变更的稳定结果。 */
export type OperationResult = z.infer<typeof operationResultSchema>;

/** 校验 Legacy 适配层稳定错误码枚举的共享 Schema。 */
export const legacyErrorCodeSchema = z.enum([
  'NO_CANDIDATE',
  'REPORT_EXPIRED',
  'PROFILE_CHANGED',
  'SUBSCRIPTION_UPDATED',
  'INVALID_CANDIDATE',
  'CONTROLLER_UNAVAILABLE',
  'APPLY_FAILED',
  'RESET_FAILED',
  'ROLLBACK_FAILED',
  'NOT_LOCKED',
  'NO_BACKUP',
  'UNSUPPORTED_CONFIG',
  'PARSE_ERROR',
  'TIMEOUT',
  'PROCESS_EXITED',
]);
/** Legacy 执行、解析、安全校验和超时失败的稳定错误码。 */
export type LegacyErrorCode = z.infer<typeof legacyErrorCodeSchema>;
