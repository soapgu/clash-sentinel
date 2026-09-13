import { z } from 'zod';

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
/** 校验客户端提交的完整可编辑策略。 */
export const settingsUpdateSchema = z
  .object(settingsEditableShape)
  .strict()
  .refine(hasAutoSwitchProfile, {
    message: '启用自动切换时必须绑定订阅 UID',
  });
/** 客户端提交的完整可编辑策略。 */
export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;
