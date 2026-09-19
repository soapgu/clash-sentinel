import { describe, expect, test } from 'vitest';
import { ApiClientError } from '../api.js';
import {
  errorSummary,
  formatApiError,
  formatDateTime,
  formatTime,
  healthLabels,
  settingsValidationMessage,
  toneForHealth,
} from './formatters.js';

describe('Dashboard 展示格式化', () => {
  test('处理空时间、非法时间和合法时间', () => {
    expect(formatTime(null)).toBe('尚无记录');
    expect(formatTime('invalid')).toBe('时间未知');
    expect(formatDateTime('invalid')).toBe('时间未知');
    expect(formatTime('2026-09-19T00:00:00.000Z')).not.toBe('时间未知');
  });

  test('映射全部健康状态和色调', () => {
    expect(Object.keys(healthLabels)).toHaveLength(7);
    expect(toneForHealth('healthy')).toBe('success');
    expect(toneForHealth('entry_suspected')).toBe('warning');
    expect(toneForHealth('proxy_error')).toBe('danger');
    expect(toneForHealth(undefined)).toBe('neutral');
  });

  test('保留安全 API 错误和 Request ID', () => {
    const error = new ApiClientError('api', '请求失败', 409, 'BUSY', 'req-1');
    expect(formatApiError(error)).toBe('请求失败 · 请求 ID req-1');
    expect(errorSummary([undefined, error])).toBe('请求失败 · 请求 ID req-1');
    expect(formatApiError(new Error('secret'))).toBe('操作失败，请稍后重试。');
  });

  test('设置校验字段使用稳定文案', () => {
    expect(settingsValidationMessage('checkIntervalMs')).toContain('检测间隔');
    expect(settingsValidationMessage('unknown')).toBe('设置格式无效');
  });
});
