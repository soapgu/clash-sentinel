import { z } from 'zod';

import { ipv4Schema } from './common.js';

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
/** 校验一次 Legacy 健康检查结果的共享 Schema。 */
export const healthCheckResultSchema = z.object({
  status: legacyHealthStatusSchema,
  checkedAt: z.string().min(1),
  internetSuccess: z.number().int().nonnegative(),
  internetTotal: z.number().int().positive(),
  currentIp: ipv4Schema,
  consecutiveFailures: z.number().int().nonnegative(),
  recommendedIp: ipv4Schema.nullable(),
  profileUid: z.string().min(1).nullable(),
  rawFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  identityChanged: z.enum(['profile', 'content']).nullable(),
});
/** 一次互联网基线和锁定入口健康检查的结果。 */
export type HealthCheckResult = z.infer<typeof healthCheckResultSchema>;
/** 校验服务综合健康状态的共享 Schema。 */
export const healthStatusSchema = z.enum([
  'healthy',
  'internet_uncertain',
  'internet_down',
  'entry_suspected',
  'entry_down',
  'proxy_error',
  'unknown',
]);
/** 服务持久化和页面展示使用的综合健康状态。 */
export type HealthStatus = z.infer<typeof healthStatusSchema>;
/** 校验服务当前健康快照的共享 Schema。 */
export const healthSnapshotSchema = z
  .object({
    status: healthStatusSchema,
    profile: z.object({ uid: z.string().min(1), name: z.string() }).nullable(),
    lock: z.discriminatedUnion('locked', [
      z.object({ locked: z.literal(false) }),
      z.object({
        locked: z.literal(true),
        domain: z.string().min(1),
        ip: ipv4Schema,
      }),
    ]),
    internetSuccess: z.number().int().nonnegative().nullable(),
    internetTotal: z.number().int().positive().nullable(),
    consecutiveFailures: z.number().int().nonnegative(),
    recommendedIp: ipv4Schema.nullable(),
    autoSwitchCooldownUntil: z.string().datetime().nullable(),
    updatedAt: z.string().datetime(),
  })
  .refine(
    (value) =>
      (value.internetSuccess === null && value.internetTotal === null) ||
      (value.internetSuccess !== null &&
        value.internetTotal !== null &&
        value.internetSuccess <= value.internetTotal),
    { message: '互联网探测成功数和总数必须同时存在且成功数不能超过总数' },
  );
/** 服务重启后可恢复的当前健康快照。 */
export type HealthSnapshot = z.infer<typeof healthSnapshotSchema>;

/** 校验固定网络探测目标标识的共享 Schema。 */
export const siteTargetSchema = z.enum([
  'baidu',
  'taobao',
  'tencent',
  'google',
  'github',
  'openai_status',
]);
/** 可独立记录状态和历史的网络探测目标。 */
export type SiteTarget = z.infer<typeof siteTargetSchema>;

/** 校验站点探测失败分类的共享 Schema。 */
export const siteErrorTypeSchema = z.enum([
  'dns',
  'timeout',
  'connection',
  'tls',
  'http',
  'proxy',
  'parse',
  'unknown',
]);
/** 站点探测失败的稳定分类。 */
export type SiteErrorType = z.infer<typeof siteErrorTypeSchema>;

/** 校验外部服务官方状态的共享 Schema。 */
export const serviceStatusSchema = z.enum([
  'operational',
  'degraded',
  'partial_outage',
  'major_outage',
  'maintenance',
  'unknown',
]);
/** OpenAI 等外部服务的官方总体状态。 */
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;

/** 校验单次站点探测结果的共享 Schema。 */
export const siteResultSchema = z
  .object({
    target: siteTargetSchema,
    reachable: z.boolean(),
    httpStatus: z.number().int().min(100).max(599).nullable(),
    durationMs: z.number().nonnegative().nullable(),
    errorType: siteErrorTypeSchema.nullable(),
    checkedAt: z.string().datetime(),
    serviceStatus: serviceStatusSchema.nullable(),
    incidentSummary: z.string().max(2_000).nullable(),
  })
  .superRefine((value, context) => {
    if (value.reachable && value.errorType !== null)
      context.addIssue({
        code: 'custom',
        message: '站点可达时不能包含错误类型',
      });
    if (
      !value.reachable &&
      (value.httpStatus !== null || value.durationMs !== null)
    )
      context.addIssue({
        code: 'custom',
        message: '站点不可达时不能保存 HTTP 状态或虚假耗时',
      });
    if (
      value.target !== 'openai_status' &&
      (value.serviceStatus !== null || value.incidentSummary !== null)
    )
      context.addIssue({
        code: 'custom',
        message: '只有 OpenAI 状态目标可以保存官方服务状态',
      });
  });
/** 单个网络目标在一个独立时间点的探测结果。 */
export type SiteResult = z.infer<typeof siteResultSchema>;
