import { z } from 'zod';

import { ipv4Schema } from './common.js';

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
  controllerAuthFailed: z.boolean().optional(),
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
      status: z.enum([
        'healthy',
        'internet_uncertain',
        'internet_down',
        'entry_suspected',
        'entry_down',
      ]),
      consecutiveFailures: z.number().int().nonnegative(),
      recommendedIp: ipv4Schema.nullable(),
    })
    .nullable(),
});
/** Legacy 当前订阅、入口锁定和最近运行状态摘要。 */
export type LegacyStatus = z.infer<typeof legacyStatusSchema>;
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
/** 校验持久化诊断快照及候选结果的共享 Schema。 */
export const storedDiagnosisSchema = diagnosisResultSchema.extend({
  id: z.string().uuid(),
  savedAt: z.string().datetime(),
});
/** 数据库中保存的最近一次脱敏诊断及候选结果。 */
export type StoredDiagnosis = z.infer<typeof storedDiagnosisSchema>;
