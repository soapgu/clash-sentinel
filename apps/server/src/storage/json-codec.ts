import type { StoredJsonObject } from '@clash-sentinel/shared';
import { StorageError } from './errors.js';

/** 单个任务或事件 JSON 字段允许保存的最大字节数。 */
export const STORED_JSON_LIMIT = 32 * 1024;

const SENSITIVE_KEY =
  /(?:secret|password|token|authorization|authHeader|mihomo|config(?:uration)?|subscription(?:Content)?|raw(?:Content|Config)?)/i;
const LOCAL_PATH = /\/(?:Users|private|tmp|var|Volumes)(?:\/[^,;\n]*)+/g;
const ABSOLUTE_LOCAL_PATH = /^\/(?:Users|private|tmp|var|Volumes)\//;

/** 递归移除结构化扩展数据中的敏感字段、完整订阅和本机路径。 */
export function normalizeJson(
  value: unknown,
  redactSensitiveData: boolean,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number')
    return value;
  if (typeof value === 'string') {
    if (
      redactSensitiveData &&
      (/^\s*proxies\s*:/m.test(value) || /^\s*proxy-groups\s*:/m.test(value))
    )
      return '[订阅内容已脱敏]';
    if (!redactSensitiveData) return value;
    if (ABSOLUTE_LOCAL_PATH.test(value)) return '[路径已脱敏]';
    return value.replace(LOCAL_PATH, '[路径已脱敏]');
  }
  if (typeof value !== 'object')
    throw new StorageError('SERIALIZATION', '扩展数据包含不可序列化值');
  if (seen.has(value))
    throw new StorageError('SERIALIZATION', '扩展数据不能包含循环引用');
  seen.add(value);
  if (Array.isArray(value))
    return value.map((item) => normalizeJson(item, redactSensitiveData, seen));
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value))
    output[key] =
      redactSensitiveData && SENSITIVE_KEY.test(key)
        ? '[敏感字段已脱敏]'
        : normalizeJson(item, redactSensitiveData, seen);
  return output;
}

/** 将扩展对象脱敏并限制大小后编码为 JSON。 */
export function encodeJson(
  value: StoredJsonObject | null | undefined,
  redactSensitiveData: boolean,
) {
  if (value === null || value === undefined) return null;
  const encoded = JSON.stringify(normalizeJson(value, redactSensitiveData));
  if (Buffer.byteLength(encoded, 'utf8') > STORED_JSON_LIMIT)
    throw new StorageError('SERIALIZATION', '扩展数据超过 32 KiB 上限');
  return encoded;
}

/** 将 SQLite 中的扩展 JSON 解码为对象。 */
export function decodeJson(value: unknown): StoredJsonObject | null {
  if (value === null) return null;
  try {
    return JSON.parse(String(value)) as StoredJsonObject;
  } catch {
    throw new StorageError('SERIALIZATION', '数据库中的扩展 JSON 已损坏');
  }
}

/** 清除面向用户文本中的本机路径和完整订阅片段。 */
export function sanitizeText(value: string, redactSensitiveData: boolean) {
  const sanitized = normalizeJson(value, redactSensitiveData);
  return typeof sanitized === 'string' ? sanitized : '[内容已脱敏]';
}
