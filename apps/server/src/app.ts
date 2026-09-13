import Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import serve from 'koa-static';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { apiErrorResponseSchema } from '@clash-sentinel/shared';
import { createApiRouter, type ApiRouterOptions } from './api/router.js';
import { ApiError } from './api/errors.js';
import { noopLogger, type AppLogger } from './logging.js';

/** 与 koa-bodyparser 默认 JSON 类型保持一致。 */
const JSON_CONTENT_TYPES = [
  'application/json',
  'application/json-patch+json',
  'application/vnd.api+json',
  'application/csp-report',
  'application/scim+json',
] as const;
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Koa 应用工厂依赖及可选运行参数。 */
export interface CreateAppOptions extends ApiRouterOptions {
  /** 生产前端构建产物目录；省略时仅提供 API。 */
  staticRoot?: string;
  /** API 请求处理超时，单位为毫秒。 */
  requestTimeoutMs?: number;
  /** 接收访问日志和业务日志的统一日志器。 */
  logger?: AppLogger;
}

/** 从未知异常中读取 Koa bodyparser 使用的 HTTP 状态。 */
function errorStatus(error: unknown) {
  return typeof error === 'object' && error !== null && 'status' in error
    ? Number(error.status)
    : null;
}

/**
 * 创建 Clash Sentinel 的 Koa 应用，并注册健康接口、API 兜底和可选静态资源托管。
 *
 * @param options 存储、任务服务、静态目录、超时和日志配置。
 * @returns 尚未开始监听端口的 Koa 应用实例。
 */
export function createApp(options: CreateAppOptions) {
  const app = new Koa();
  const logger = options.logger ?? noopLogger;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;

  app.use(async (ctx, next) => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    ctx.state.requestId = requestId;
    ctx.set('X-Request-Id', requestId);
    try {
      await next();
    } finally {
      if (ctx.path !== '/api/stream') {
        const metadata = {
          method: ctx.method,
          path: ctx.path,
          status: ctx.status,
          durationMs: Date.now() - startedAt,
          requestId,
          ...(ctx.state.apiErrorCode
            ? { errorCode: String(ctx.state.apiErrorCode) }
            : undefined),
          ...(ctx.state.unhandledError instanceof Error
            ? { error: ctx.state.unhandledError }
            : undefined),
        };
        const message =
          ctx.status === 504
            ? 'request timeout'
            : ctx.status >= 400
              ? 'request failed'
              : 'request completed';
        if (ctx.status >= 500) logger.error('http:access', message, metadata);
        else if (ctx.status >= 400)
          logger.warn('http:access', message, metadata);
        else if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(ctx.method))
          logger.info('http:access', message, metadata);
        else logger.debug('http:access', message, metadata);
      }
    }
  });

  app.use(async (ctx, next) => {
    try {
      await next();
    } catch (error) {
      const parserStatus = errorStatus(error);
      const apiError =
        error instanceof ApiError
          ? error
          : parserStatus === 400 || parserStatus === 413
            ? new ApiError(400, 'INVALID_JSON', '请求体不是合法 JSON')
            : parserStatus === 415
              ? new ApiError(
                  415,
                  'UNSUPPORTED_MEDIA_TYPE',
                  '请求体必须使用 application/json',
                )
              : parserStatus !== null &&
                  Number.isInteger(parserStatus) &&
                  parserStatus >= 400 &&
                  parserStatus < 500
                ? new ApiError(
                    parserStatus,
                    'INVALID_REQUEST',
                    '请求无法处理',
                  )
                : new ApiError(500, 'INTERNAL_ERROR', '后台处理失败');
      ctx.state.apiErrorCode = apiError.code;
      if (!(error instanceof ApiError)) ctx.state.unhandledError = error;
      ctx.status = apiError.status;
      ctx.body = apiErrorResponseSchema.parse({
        ok: false,
        error: {
          code: apiError.code,
          message: apiError.message,
          ...(apiError.details ? { details: apiError.details } : undefined),
        },
        requestId: ctx.state.requestId,
      });
    }
  });

  app.use(async (_ctx, next) => {
    if (_ctx.path === '/api/stream') {
      await next();
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        next(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new ApiError(
                  504,
                  'REQUEST_TIMEOUT',
                  '请求处理超时，请稍后重试',
                ),
              ),
            requestTimeoutMs,
          );
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  });

  app.use(async (ctx, next) => {
    const hasBody =
      ctx.request.length > 0 || Boolean(ctx.get('transfer-encoding'));
    if (
      (ctx.path === '/api' || ctx.path.startsWith('/api/')) &&
      BODY_METHODS.has(ctx.method) &&
      hasBody &&
      !ctx.request.is([...JSON_CONTENT_TYPES])
    )
      throw new ApiError(
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        '请求体必须使用 application/json',
      );
    await next();
  });

  app.use(
    bodyParser({
      enableTypes: ['json'],
      jsonLimit: '32kb',
    }),
  );
  const router = createApiRouter(options);
  app.use(router.routes());
  app.use(router.allowedMethods());
  app.use(async (ctx, next) => {
    if (ctx.path === '/api' || ctx.path.startsWith('/api/')) {
      throw new ApiError(404, 'NOT_FOUND', '接口不存在');
    }
    await next();
  });
  if (options.staticRoot) {
    app.use(serve(options.staticRoot, { hidden: false }));
    app.use(async (ctx) => {
      if (
        !['GET', 'HEAD'].includes(ctx.method) ||
        extname(ctx.path) ||
        ctx.path.startsWith('/assets/')
      )
        return;
      try {
        const html = await readFile(
          join(options.staticRoot!, 'index.html'),
          'utf8',
        );
        ctx.type = 'html';
        ctx.body = html;
      } catch {
        ctx.status = 404;
      }
    });
  }
  return app;
}
