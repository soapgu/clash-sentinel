import type { HealthSnapshot, StoredTask } from '@clash-sentinel/shared';
import { ApiClientError } from '../api.js';

export const healthLabels: Record<HealthSnapshot['status'], string> = {
  healthy: '入口正常',
  internet_uncertain: '互联网状态不确定',
  internet_down: '互联网不可达',
  entry_suspected: '入口疑似异常',
  entry_down: '入口异常',
  proxy_error: 'Clash 不可用',
  unknown: '状态未知',
};

export const taskNames: Record<StoredTask['type'], string> = {
  health_check: '立即检测',
  diagnose: '重新诊断',
  apply: '应用候选',
  reset: '解除锁定',
  rollback: '回滚变更',
  auto_switch: '自动切换',
};

export const taskStatusLabels: Record<StoredTask['status'], string> = {
  queued: '等待执行',
  running: '执行中',
  succeeded: '成功',
  failed: '失败',
  interrupted: '已中断',
};

export function formatTime(value: string | null | undefined) {
  if (!value) return '尚无记录';
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(timestamp);
}

export function formatDateTime(value: string) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(timestamp);
}

export function toneForHealth(status: HealthSnapshot['status'] | undefined) {
  if (status === 'healthy') return 'success';
  if (status === 'internet_uncertain' || status === 'entry_suspected')
    return 'warning';
  if (
    status === 'internet_down' ||
    status === 'entry_down' ||
    status === 'proxy_error'
  )
    return 'danger';
  return 'neutral';
}

export function settingsValidationMessage(path: PropertyKey | undefined) {
  const messages: Record<string, string> = {
    checkIntervalMs: '检测间隔必须在 1～86400 秒之间',
    requestTimeoutMs: '请求超时必须在 0.1～60 秒之间',
    entryFailureThreshold: '失败阈值必须是 1～100 的整数',
    autoSwitchCooldownMs: '冷却时间必须在 0～1440 分钟之间',
  };
  return messages[String(path)] ?? '设置格式无效';
}

export function formatApiError(error: unknown) {
  if (!(error instanceof ApiClientError)) return '操作失败，请稍后重试。';
  return `${error.message}${error.requestId ? ` · 请求 ID ${error.requestId}` : ''}`;
}

export function errorSummary(errors: unknown[]) {
  const error = errors.find(Boolean);
  if (!(error instanceof ApiClientError)) return '部分数据读取失败，请重试。';
  const requestId = error.requestId ? ` · 请求 ID ${error.requestId}` : '';
  return `${error.message}${requestId}`;
}
