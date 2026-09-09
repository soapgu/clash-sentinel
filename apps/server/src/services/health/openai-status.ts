import type { ServiceStatus } from '@clash-sentinel/shared';

/** OpenAI 官方状态摘要中对业务有用的脱敏字段。 */
export interface OpenAiStatusSummary {
  /** 映射到共享枚举的总体状态。 */
  serviceStatus: ServiceStatus;
  /** 第一条未解决事故标题；没有事故时为 null。 */
  incidentSummary: string | null;
}

/** 将未知值收窄为普通 JSON 对象。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 将 Statuspage indicator 映射为服务总体状态。 */
function mapIndicator(value: unknown): ServiceStatus {
  const mapping: Record<string, ServiceStatus> = {
    none: 'operational',
    minor: 'degraded',
    major: 'partial_outage',
    critical: 'major_outage',
    maintenance: 'maintenance',
  };
  return typeof value === 'string' ? (mapping[value] ?? 'unknown') : 'unknown';
}

/**
 * 解析 OpenAI Statuspage summary JSON。
 *
 * @param text HTTP 响应正文。
 * @returns 总体状态和第一条活动事故标题；格式异常时返回 unknown。
 */
export function parseOpenAiStatus(text: string): OpenAiStatusSummary {
  try {
    const root = asRecord(JSON.parse(text));
    const status = asRecord(root?.status);
    const incidents = Array.isArray(root?.incidents) ? root.incidents : [];
    const active = incidents
      .map(asRecord)
      .find(
        (incident) =>
          incident &&
          typeof incident.name === 'string' &&
          !['resolved', 'completed'].includes(String(incident.status)),
      );
    return {
      serviceStatus: mapIndicator(status?.indicator),
      incidentSummary:
        active && typeof active.name === 'string'
          ? active.name.replace(/[\r\n\t]+/g, ' ').slice(0, 2_000)
          : null,
    };
  } catch {
    return { serviceStatus: 'unknown', incidentSummary: null };
  }
}
