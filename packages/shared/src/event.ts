import { z } from 'zod';

import { storedJsonObjectSchema } from './common.js';

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
