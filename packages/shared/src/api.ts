import { z } from 'zod';

import { ipv4Schema } from './common.js';
import { storedDiagnosisSchema } from './diagnosis.js';
import { eventRecordSchema } from './event.js';
import { healthSnapshotSchema, siteResultSchema } from './health.js';
import { settingsSchema } from './settings.js';
import { storedTaskSchema } from './task.js';

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
/** 校验 API 向客户端公开的稳定错误码。 */
export const apiErrorCodeSchema = z.enum([
  'INVALID_JSON',
  'INVALID_REQUEST',
  'UNSUPPORTED_MEDIA_TYPE',
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

/** 校验 SSE 可以通知客户端失效的基础资源。 */
export const streamBaseResourceSchema = z.enum([
  'monitoring',
  'status',
  'sites',
  'candidates',
  'events',
  'settings',
]);
/** SSE 可以通知客户端失效的基础资源。 */
export type StreamBaseResource = z.infer<typeof streamBaseResourceSchema>;

/** SSE 指定任务资源标识。 */
export type StreamTaskResource = `task:${string}`;
/** 校验指定任务的 SSE 资源标识。 */
export const streamTaskResourceSchema = z.custom<StreamTaskResource>(
  (value) =>
    typeof value === 'string' &&
    value.startsWith('task:') &&
    z.string().uuid().safeParse(value.slice('task:'.length)).success,
  '必须是 task:<UUID> 格式',
);

/** 校验 SSE 资源失效通知的稳定原因。 */
export const streamNotificationReasonSchema = z.enum([
  'sync',
  'monitoring_started',
  'monitoring_completed',
  'task_queued',
  'task_started',
  'task_succeeded',
  'task_failed',
]);
/** SSE 资源失效通知的稳定原因。 */
export type StreamNotificationReason = z.infer<
  typeof streamNotificationReasonSchema
>;

/** 校验 SSE 只携带资源失效信息而不携带完整业务快照。 */
export const streamNotificationSchema = z
  .object({
    version: z.literal(1),
    id: z.number().int().positive(),
    occurredAt: z.string().datetime(),
    reason: streamNotificationReasonSchema,
    resources: z
      .array(z.union([streamBaseResourceSchema, streamTaskResourceSchema]))
      .min(1),
  })
  .strict()
  .refine((value) => new Set(value.resources).size === value.resources.length, {
    path: ['resources'],
    message: '失效资源不能重复',
  });
/** SSE 资源失效通知。 */
export type StreamNotification = z.infer<typeof streamNotificationSchema>;
/** SSE 资源失效通知中的单个资源。 */
export type StreamResource = StreamNotification['resources'][number];

/** 校验当前健康快照读取响应。 */
export const statusResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({ snapshot: healthSnapshotSchema.nullable() }),
});
/** 当前健康快照读取响应。 */
export type StatusResponse = z.infer<typeof statusResponseSchema>;

/** 校验定时监测调度器的稳定运行状态枚举。 */
export const monitoringRunStateSchema = z.enum([
  'waiting',
  'running',
  'disabled',
]);
/** 当前进程中定时监测调度器的稳定运行状态。 */
export type MonitoringRunState = z.infer<typeof monitoringRunStateSchema>;

/** 校验定时监测开关、运行状态和当前进程内调度时间。 */
export const monitoringSnapshotSchema = z
  .object({
    enabled: z.boolean(),
    state: monitoringRunStateSchema,
    lastStartedAt: z.string().datetime().nullable(),
    lastCompletedAt: z.string().datetime().nullable(),
    nextRunAt: z.string().datetime().nullable(),
    activeTaskId: z.string().uuid().nullable().default(null),
  })
  .superRefine((value, context) => {
    if (value.state === 'waiting' && !value.enabled) {
      context.addIssue({
        code: 'custom',
        path: ['enabled'],
        message: '等待状态必须启用定时监测',
      });
    }
    if (value.state === 'running' && value.lastStartedAt === null) {
      context.addIssue({
        code: 'custom',
        path: ['lastStartedAt'],
        message: '运行状态必须包含本轮开始时间',
      });
    }
    if (value.state === 'disabled' && value.enabled) {
      context.addIssue({
        code: 'custom',
        path: ['enabled'],
        message: '暂停状态不能启用定时监测',
      });
    }
    if (value.state !== 'waiting' && value.nextRunAt !== null) {
      context.addIssue({
        code: 'custom',
        path: ['nextRunAt'],
        message: '只有等待状态可以包含下一轮计划时间',
      });
    }
  });
/** 当前进程中的定时监测开关、运行状态和调度时间。 */
export type MonitoringSnapshot = z.infer<typeof monitoringSnapshotSchema>;

/** 校验定时监测运行状态读取响应。 */
export const monitoringResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({ monitoring: monitoringSnapshotSchema }),
});
/** 定时监测运行状态读取响应。 */
export type MonitoringResponse = z.infer<typeof monitoringResponseSchema>;

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
