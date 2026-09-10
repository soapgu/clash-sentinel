import type { ZodType } from 'zod';
import {
  apiErrorResponseSchema,
  candidatesResponseSchema,
  eventsResponseSchema,
  healthResponseSchema,
  monitoringResponseSchema,
  settingsResponseSchema,
  sitesResponseSchema,
  statusResponseSchema,
} from '@clash-sentinel/shared';

/** 便宜的后台存活探针应快速失败。 */
export const HEALTH_REQUEST_TIMEOUT_MS = 3_000;
/** 普通请求略长于后端统一的十秒超时，以保留结构化 504。 */
export const SNAPSHOT_REQUEST_TIMEOUT_MS = 12_000;

export type ApiClientErrorKind = 'api' | 'timeout' | 'network' | 'response';

/** 前端统一处理的安全 API 错误。 */
export class ApiClientError extends Error {
  constructor(
    public readonly kind: ApiClientErrorKind,
    message: string,
    public readonly status?: number,
    public readonly code?: string,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export interface RequestJsonOptions {
  timeoutMs: number;
  fetcher?: typeof fetch;
  timeoutSignal?: (timeoutMs: number) => AbortSignal;
}

/** 读取同源 JSON，并统一执行超时、错误解析与共享 Schema 校验。 */
export async function requestJson<T>(
  url: string,
  schema: ZodType<T>,
  options: RequestJsonOptions,
): Promise<T> {
  const fetcher = options.fetcher ?? fetch;
  const timeoutSignal = options.timeoutSignal ?? AbortSignal.timeout;
  try {
    const response = await fetcher(url, {
      headers: { Accept: 'application/json' },
      signal: timeoutSignal(options.timeoutMs),
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = apiErrorResponseSchema.safeParse(body);
      if (error.success)
        throw new ApiClientError(
          'api',
          error.data.error.message,
          response.status,
          error.data.error.code,
          error.data.requestId,
        );
      throw new ApiClientError(
        'response',
        `后台返回了无法识别的错误（HTTP ${response.status}）`,
        response.status,
      );
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success)
      throw new ApiClientError('response', '后台响应格式无效');
    return parsed.data;
  } catch (error) {
    if (error instanceof ApiClientError) throw error;
    if (
      error instanceof DOMException &&
      (error.name === 'AbortError' || error.name === 'TimeoutError')
    )
      throw new ApiClientError('timeout', '请求超时，请稍后重试');
    throw new ApiClientError('network', '无法连接后台服务');
  }
}

const readSnapshot = <T>(url: string, schema: ZodType<T>) =>
  requestJson(url, schema, { timeoutMs: SNAPSHOT_REQUEST_TIMEOUT_MS });

/** 看板只读 API。 */
export const api = {
  health: () =>
    requestJson('/api/health', healthResponseSchema, {
      timeoutMs: HEALTH_REQUEST_TIMEOUT_MS,
    }),
  monitoring: () => readSnapshot('/api/monitoring', monitoringResponseSchema),
  status: () => readSnapshot('/api/status', statusResponseSchema),
  sites: () => readSnapshot('/api/sites', sitesResponseSchema),
  candidates: () => readSnapshot('/api/candidates', candidatesResponseSchema),
  events: () =>
    readSnapshot('/api/events?limit=50&offset=0', eventsResponseSchema),
  settings: () => readSnapshot('/api/settings', settingsResponseSchema),
};
