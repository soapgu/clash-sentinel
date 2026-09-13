import { z } from 'zod';

/** 校验四段十进制 IPv4 地址的共享 Schema。 */
export const ipv4Schema = z.string().refine((value) => {
  const parts = value.split('.');
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}, '必须是合法的 IPv4 地址');
/** 校验可安全持久化的 JSON 对象。 */
export const storedJsonObjectSchema = z.record(z.string(), z.unknown());
/** 经过大小限制和敏感字段过滤的 JSON 对象。 */
export type StoredJsonObject = z.infer<typeof storedJsonObjectSchema>;
