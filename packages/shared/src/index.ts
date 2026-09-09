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

/** 设置持久化和 API 更新共同使用的可编辑字段定义。 */
const settingsEditableShape = {
  checkIntervalMs: z.number().int().min(1_000).max(86_400_000),
  requestTimeoutMs: z.number().int().min(100).max(60_000),
  entryFailureThreshold: z.number().int().min(1).max(100),
  autoSwitchCooldownMs: z.number().int().min(0).max(86_400_000),
  monitoringEnabled: z.boolean(),
  autoSwitchEnabled: z.boolean(),
  autoSwitchProfileUid: z.string().min(1).nullable(),
};

/** 判断设置是否满足自动切换必须绑定订阅的业务约束。 */
function hasAutoSwitchProfile(value: {
  autoSwitchEnabled: boolean;
  autoSwitchProfileUid: string | null;
}) {
  return !value.autoSwitchEnabled || value.autoSwitchProfileUid !== null;
}

/** 校验用户可调整监测与自动切换策略的共享 Schema。 */
export const settingsSchema = z
  .object({
    ...settingsEditableShape,
    updatedAt: z.string().datetime(),
  })
  .refine(hasAutoSwitchProfile, {
    message: '启用自动切换时必须绑定订阅 UID',
  });
/** 用户监测和自动切换策略。 */
export type Settings = z.infer<typeof settingsSchema>;

/** 首次初始化数据库时写入的策略默认值。 */
export const settingsDefaults = {
  checkIntervalMs: 60_000,
  requestTimeoutMs: 5_000,
  entryFailureThreshold: 3,
  autoSwitchCooldownMs: 300_000,
  monitoringEnabled: true,
  autoSwitchEnabled: false,
  autoSwitchProfileUid: null,
} satisfies Omit<Settings, 'updatedAt'>;

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

/** 校验持久化诊断快照及候选结果的共享 Schema。 */
export const storedDiagnosisSchema = diagnosisResultSchema.extend({
  id: z.string().uuid(),
  savedAt: z.string().datetime(),
});
/** 数据库中保存的最近一次脱敏诊断及候选结果。 */
export type StoredDiagnosis = z.infer<typeof storedDiagnosisSchema>;

/** 校验持久化任务类型的共享 Schema。 */
export const taskTypeSchema = z.enum([
  'health_check',
  'diagnose',
  'apply',
  'reset',
  'rollback',
  'auto_switch',
]);
/** 后台能够持久化追踪的任务类型。 */
export type TaskType = z.infer<typeof taskTypeSchema>;

/** 校验持久化任务状态的共享 Schema。 */
export const taskStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'interrupted',
]);
/** 后台任务生命周期中的稳定状态。 */
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/** 校验可安全持久化的 JSON 对象。 */
export const storedJsonObjectSchema = z.record(z.string(), z.unknown());
/** 经过大小限制和敏感字段过滤的 JSON 对象。 */
export type StoredJsonObject = z.infer<typeof storedJsonObjectSchema>;

/** 校验持久化任务记录的共享 Schema。 */
export const storedTaskSchema = z.object({
  id: z.string().uuid(),
  type: taskTypeSchema,
  status: taskStatusSchema,
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  input: storedJsonObjectSchema.nullable(),
  result: storedJsonObjectSchema.nullable(),
  errorCode: z.string().min(1).max(100).nullable(),
  errorMessage: z.string().max(2_000).nullable(),
});
/** 服务重启后仍可查询的后台任务记录。 */
export type StoredTask = z.infer<typeof storedTaskSchema>;

/** 校验事件严重级别的共享 Schema。 */
export const eventSeveritySchema = z.enum([
  'info',
  'warning',
  'error',
  'critical',
]);
/** 事件对用户和系统的影响级别。 */
export type EventSeverity = z.infer<typeof eventSeveritySchema>;

/** 校验事件保留分类的共享 Schema。 */
export const eventRetentionSchema = z.enum(['ordinary', 'critical']);
/** 决定事件历史清理上限的保留分类。 */
export type EventRetention = z.infer<typeof eventRetentionSchema>;

/** 校验持久化事件记录的共享 Schema。 */
export const eventRecordSchema = z.object({
  id: z.number().int().positive(),
  type: z.string().min(1).max(100),
  severity: eventSeveritySchema,
  retention: eventRetentionSchema,
  summary: z.string().min(1).max(2_000),
  details: storedJsonObjectSchema.nullable(),
  taskId: z.string().uuid().nullable(),
  profileUid: z.string().min(1).nullable(),
  occurredAt: z.string().datetime(),
});
/** 按普通或关键策略保留的服务事件记录。 */
export type EventRecord = z.infer<typeof eventRecordSchema>;

/** 校验 API 向客户端公开的稳定错误码。 */
export const apiErrorCodeSchema = z.enum([
  'INVALID_JSON',
  'VALIDATION_ERROR',
  'NOT_FOUND',
  'ACTION_CONFLICT',
  'NO_DIAGNOSIS',
  'INVALID_CANDIDATE',
  'AUTO_SWITCH_REQUIRES_LOCK',
  'PROFILE_MISMATCH',
  'REQUEST_TIMEOUT',
  'INTERNAL_ERROR',
]);
/** API 请求校验、业务拒绝和内部失败的稳定错误码。 */
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

/** 校验不包含输入原文的 API 错误详情。 */
export const apiErrorDetailsSchema = z
  .object({
    issues: z.array(z.string()).optional(),
    activeTaskId: z.string().uuid().optional(),
    activeOperation: z.literal('scheduled_health').optional(),
  })
  .strict();
/** API 错误可选的脱敏结构化上下文。 */
export type ApiErrorDetails = z.infer<typeof apiErrorDetailsSchema>;

/** 校验统一 API 失败响应。 */
export const apiErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string().min(1),
    details: apiErrorDetailsSchema.optional(),
  }),
  requestId: z.string().uuid(),
});
/** 统一 API 失败响应。 */
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

/** 校验当前健康快照读取响应。 */
export const statusResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({ snapshot: healthSnapshotSchema.nullable() }),
});
/** 当前健康快照读取响应。 */
export type StatusResponse = z.infer<typeof statusResponseSchema>;

/** 校验 API 展示的站点结果及动态过期标记。 */
export const siteSnapshotViewSchema = siteResultSchema.extend({
  stale: z.boolean(),
});
/** API 展示的站点当前结果。 */
export type SiteSnapshotView = z.infer<typeof siteSnapshotViewSchema>;

/** 校验六个固定站点的当前结果映射。 */
export const siteSnapshotMapSchema = z.object({
  baidu: siteSnapshotViewSchema.nullable(),
  taobao: siteSnapshotViewSchema.nullable(),
  tencent: siteSnapshotViewSchema.nullable(),
  google: siteSnapshotViewSchema.nullable(),
  github: siteSnapshotViewSchema.nullable(),
  openai_status: siteSnapshotViewSchema.nullable(),
});
/** 六个固定站点的当前结果映射。 */
export type SiteSnapshotMap = z.infer<typeof siteSnapshotMapSchema>;

/** 校验站点当前结果读取响应。 */
export const sitesResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({ sites: siteSnapshotMapSchema }),
});
/** 站点当前结果读取响应。 */
export type SitesResponse = z.infer<typeof sitesResponseSchema>;

/** 校验最近诊断及候选读取响应。 */
export const candidatesResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({ diagnosis: storedDiagnosisSchema.nullable() }),
});
/** 最近诊断及候选读取响应。 */
export type CandidatesResponse = z.infer<typeof candidatesResponseSchema>;

/** 校验事件分页查询并将十进制文本转换为整数。 */
export const eventsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().nonnegative().default(0),
  })
  .strict();
/** 事件分页查询参数。 */
export type EventsQuery = z.infer<typeof eventsQuerySchema>;

/** 校验事件分页读取响应。 */
export const eventsResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    items: z.array(eventRecordSchema),
    limit: z.number().int().min(1).max(100),
    offset: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
});
/** 事件分页读取响应。 */
export type EventsResponse = z.infer<typeof eventsResponseSchema>;

/** 校验策略读取响应。 */
export const settingsResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({ settings: settingsSchema }),
});
/** 策略读取响应。 */
export type SettingsResponse = z.infer<typeof settingsResponseSchema>;

/** 校验客户端提交的完整可编辑策略。 */
export const settingsUpdateSchema = z
  .object(settingsEditableShape)
  .strict()
  .refine(hasAutoSwitchProfile, {
    message: '启用自动切换时必须绑定订阅 UID',
  });
/** 客户端提交的完整可编辑策略。 */
export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;

/** 校验单个任务读取响应。 */
export const taskResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({ task: storedTaskSchema }),
});
/** 单个任务读取响应。 */
export type TaskResponse = z.infer<typeof taskResponseSchema>;

/** 校验任务 UUID 路径参数。 */
export const taskParamsSchema = z.object({ id: z.string().uuid() }).strict();
/** 任务 UUID 路径参数。 */
export type TaskParams = z.infer<typeof taskParamsSchema>;

/** 校验不接受任何业务字段的动作请求。 */
export const emptyActionRequestSchema = z.object({}).strict();
/** 无业务字段的动作请求。 */
export type EmptyActionRequest = z.infer<typeof emptyActionRequestSchema>;

/** 校验应用候选 IPv4 的动作请求。 */
export const applyActionRequestSchema = z.object({ ip: ipv4Schema }).strict();
/** 应用候选 IPv4 的动作请求。 */
export type ApplyActionRequest = z.infer<typeof applyActionRequestSchema>;

/** 校验后台动作成功入队响应。 */
export const taskAcceptedResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    taskId: z.string().uuid(),
    status: z.literal('queued'),
  }),
});
/** 后台动作成功入队响应。 */
export type TaskAcceptedResponse = z.infer<typeof taskAcceptedResponseSchema>;
