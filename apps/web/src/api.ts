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
  taskAcceptedResponseSchema,
  taskResponseSchema,
  type ApiErrorDetails,
  type SettingsUpdate,
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
    public readonly details?: ApiErrorDetails,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export interface RequestJsonOptions {
  timeoutMs: number;
  method?: 'GET' | 'POST' | 'PUT';
  body?: unknown;
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
      ...(options.method && options.method !== 'GET'
        ? { method: options.method }
        : {}),
      headers: {
        Accept: 'application/json',
        ...(options.body === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
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
          error.data.error.details,
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

/** 使用统一超时和响应校验提交业务写请求。 */
const writeJson = <T>(
  url: string,
  method: 'POST' | 'PUT',
  body: unknown,
  schema: ZodType<T>,
) =>
  requestJson(url, schema, {
    timeoutMs: SNAPSHOT_REQUEST_TIMEOUT_MS,
    method,
    body,
  });

export type ManualAction =
  'health-check' | 'diagnose' | 'apply' | 'reset' | 'rollback';

/** 看板读写 API；业务写操作只能通过这里进入统一错误处理。 */
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
  task: (id: string) => readSnapshot(`/api/tasks/${id}`, taskResponseSchema),
  action: (action: ManualAction, body: object = {}) =>
    writeJson(
      `/api/actions/${action}`,
      'POST',
      body,
      taskAcceptedResponseSchema,
    ),
  updateSettings: (settings: SettingsUpdate) =>
    writeJson('/api/settings', 'PUT', settings, settingsResponseSchema),
};
