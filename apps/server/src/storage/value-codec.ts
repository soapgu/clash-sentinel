import { StorageError } from './errors.js';

/** 将 Unix 毫秒转换为领域对象使用的 ISO 8601 时间。 */
export function fromEpoch(value: number) {
  return new Date(value).toISOString();
}

/** 将领域对象中的时间转换为 Unix 毫秒。 */
export function toEpoch(value: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new StorageError('VALIDATION', '时间字段格式无效');
  return parsed;
}
