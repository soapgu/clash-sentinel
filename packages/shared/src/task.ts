import { z } from 'zod';

import { storedJsonObjectSchema } from './common.js';

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

/** 校验配置类任务失败后的恢复结论。 */
export const taskRecoveryStatusSchema = z.enum([
  'not_required',
  'recovered',
  'recovery_failed',
  'unknown',
]);
/** 配置类任务失败后原配置和运行状态的恢复结论。 */
export type TaskRecoveryStatus = z.infer<typeof taskRecoveryStatusSchema>;
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
  recoveryStatus: taskRecoveryStatusSchema.nullable(),
});
/** 服务重启后仍可查询的后台任务记录。 */
export type StoredTask = z.infer<typeof storedTaskSchema>;
