import Router from '@koa/router';
import type { Context } from 'koa';
import type { ZodType } from 'zod';
import {
  applyActionRequestSchema,
  candidatesResponseSchema,
  emptyActionRequestSchema,
  eventsQuerySchema,
  eventsResponseSchema,
  healthResponseSchema,
  monitoringResponseSchema,
  settingsResponseSchema,
  settingsUpdateSchema,
  siteTargetSchema,
  sitesResponseSchema,
  statusResponseSchema,
  taskAcceptedResponseSchema,
  taskParamsSchema,
  taskResponseSchema,
  type SiteSnapshotMap,
  type StreamNotification,
} from '@clash-sentinel/shared';
import type { HealthScheduler } from '../services/health/health-scheduler.js';
import type { DiagnosisRepository } from '../storage/diagnosis-repository.js';
import type { EventRepository } from '../storage/event-repository.js';
import type { HealthRepository } from '../storage/health-repository.js';
import type { SettingsRepository } from '../storage/settings-repository.js';
import type { SiteRepository } from '../storage/site-repository.js';
import type { TaskRepository } from '../storage/task-repository.js';
import type { TaskEngine } from '../services/tasks/task-engine.js';
import type { StatusNotificationCenter } from '../services/status-notifier.js';
import { ApiError } from './errors.js';
import { noopLogger, type AppLogger } from '../logging.js';

/** API 路由访问持久化数据和异步任务服务所需的依赖。 */
export interface ApiRouterOptions {
  /** SQLite 数据访问门面。 */
  store: {
    settings: Pick<SettingsRepository, 'getSettings' | 'updateSettings'>;
    health: Pick<HealthRepository, 'getHealthSnapshot'>;
    sites: Pick<SiteRepository, 'getSiteSnapshot'>;
    diagnoses: Pick<DiagnosisRepository, 'getDiagnosis'>;
    tasks: Pick<TaskRepository, 'getTask'>;
    events: Pick<EventRepository, 'listEvents' | 'countEvents'>;
  };
  /** 全局串行且通过 Handler 执行业务动作的任务引擎。 */
  taskEngine: TaskEngine;
  /** 当前进程中的定时健康检测调度器。 */
  scheduler: Pick<HealthScheduler, 'getSnapshot'>;
  /** 当前进程中的 SSE 通知和连接生命周期中心。 */
  notifier: Pick<StatusNotificationCenter, 'subscribe'>;
  /** HTTP、设置和 SSE 生命周期使用的统一日志器。 */
  logger?: AppLogger;
  /** 测试站点过期边界时可注入的 Unix 毫秒时钟。 */
  now?: () => number;
  /** SSE 保活周期；生产默认 15 秒，测试可缩短。 */
  streamHeartbeatMs?: number;
}

/** 使用 Zod 校验不可信请求数据并只公开字段路径。 */
function parseRequest<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ApiError(400, 'VALIDATION_ERROR', '请求参数无效', {
    issues: [
      ...new Set(
        result.error.issues.map((issue) => issue.path.join('.') || 'request'),
      ),
    ],
  });
}

/** 读取 Koa bodyparser 解析后的请求体；无正文按空对象处理。 */
function requestBody(ctx: Context): unknown {
  return (ctx.request as typeof ctx.request & { body?: unknown }).body ?? {};
}

/** 创建严格遵循共享 Schema 的业务 API 路由。 */
export function createApiRouter(options: ApiRouterOptions) {
  const { store, taskEngine, scheduler, notifier } = options;
  const now = options.now ?? Date.now;
  const logger = options.logger ?? noopLogger;
  const streamHeartbeatMs = options.streamHeartbeatMs ?? 15_000;
  const router = new Router();

  router.get('/api/health', (ctx) => {
    ctx.body = healthResponseSchema.parse({
      ok: true,
      data: { service: 'clash-sentinel', status: 'ok' },
    });
  });

  router.get('/api/status', (ctx) => {
    ctx.body = statusResponseSchema.parse({
      ok: true,
      data: { snapshot: store.health.getHealthSnapshot() },
    });
  });

  router.get('/api/monitoring', (ctx) => {
    ctx.body = monitoringResponseSchema.parse({
      ok: true,
      data: { monitoring: scheduler.getSnapshot() },
    });
  });

  router.get('/api/stream', (ctx) => {
    let heartbeat: NodeJS.Timeout | null = null;
    let unsubscribe: () => void = () => undefined;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      unsubscribe();
      logger.debug('sse:stream', 'disconnected', {
        requestId: ctx.state.requestId,
        durationMs: now() - connectedAt,
      });
      if (!ctx.res.destroyed && !ctx.res.writableEnded) ctx.res.end();
    };
    const writeNotification = (notification: StreamNotification) => {
      const frame = `id: ${notification.id}\nevent: invalidate\ndata: ${JSON.stringify(notification)}\n\n`;
      if (!ctx.res.write(frame)) {
        cleanup();
        throw new Error('SSE 客户端读取过慢');
      }
    };

    const connectedAt = now();
    ctx.req.setTimeout(0);
    ctx.status = 200;
    ctx.set('Content-Type', 'text/event-stream; charset=utf-8');
    ctx.set('Cache-Control', 'no-cache, no-transform');
    ctx.set('Connection', 'keep-alive');
    ctx.set('X-Accel-Buffering', 'no');
    ctx.respond = false;
    ctx.res.flushHeaders();
    logger.debug('sse:stream', 'connected', {
      requestId: ctx.state.requestId,
    });
    ctx.res.once('close', cleanup);
    ctx.res.once('error', cleanup);
    unsubscribe = notifier.subscribe(writeNotification, cleanup);
    if (!cleaned) {
      heartbeat = setInterval(() => {
        if (!ctx.res.write(': keepalive\n\n')) cleanup();
      }, streamHeartbeatMs);
      heartbeat.unref();
    }
  });

  router.get('/api/sites', (ctx) => {
    const staleAfterMs = store.settings.getSettings().checkIntervalMs * 2;
    const sites = Object.fromEntries(
      siteTargetSchema.options.map((target) => {
        const result = store.sites.getSiteSnapshot(target);
        return [
          target,
          result
            ? {
                ...result,
                stale: now() - Date.parse(result.checkedAt) > staleAfterMs,
              }
            : null,
        ];
      }),
    ) as SiteSnapshotMap;
    ctx.body = sitesResponseSchema.parse({ ok: true, data: { sites } });
  });

  router.get('/api/candidates', (ctx) => {
    ctx.body = candidatesResponseSchema.parse({
      ok: true,
      data: { diagnosis: store.diagnoses.getDiagnosis() },
    });
  });

  router.get('/api/events', (ctx) => {
    const query = parseRequest(eventsQuerySchema, ctx.query);
    ctx.body = eventsResponseSchema.parse({
      ok: true,
      data: {
        items: store.events.listEvents(query.limit, query.offset),
        ...query,
        total: store.events.countEvents(),
      },
    });
  });

  router.get('/api/settings', (ctx) => {
    ctx.body = settingsResponseSchema.parse({
      ok: true,
      data: { settings: store.settings.getSettings() },
    });
  });

  router.get('/api/tasks/:id', (ctx) => {
    const { id } = parseRequest(taskParamsSchema, ctx.params);
    const task = store.tasks.getTask(id);
    if (!task) throw new ApiError(404, 'NOT_FOUND', '任务不存在');
    ctx.body = taskResponseSchema.parse({ ok: true, data: { task } });
  });

  router.put('/api/settings', (ctx) => {
    try {
      const input = parseRequest(settingsUpdateSchema, requestBody(ctx));
      const normalized = input.autoSwitchEnabled
        ? input
        : { ...input, autoSwitchProfileUid: null };
      if (normalized.autoSwitchEnabled) {
        if (taskEngine.hasActiveOperation())
          throw new ApiError(409, 'ACTION_CONFLICT', '已有操作正在执行', {
            ...taskEngine.getConflictDetails(),
          });
        const snapshot = store.health.getHealthSnapshot();
        if (!snapshot?.lock.locked)
          throw new ApiError(
            409,
            'AUTO_SWITCH_REQUIRES_LOCK',
            '当前入口未锁定，不能开启自动切换',
          );
        if (
          !snapshot.profile ||
          snapshot.profile.uid !== normalized.autoSwitchProfileUid
        )
          throw new ApiError(
            409,
            'PROFILE_MISMATCH',
            '自动切换绑定订阅与当前订阅不一致',
          );
      }
      const previous = store.settings.getSettings();
      const updated = store.settings.updateSettings(normalized);
      const changedFields = Object.keys(normalized).filter(
        (key) =>
          previous[key as keyof typeof previous] !==
          updated[key as keyof typeof updated],
      );
      logger.info('settings:service', 'settings updated', {
        requestId: ctx.state.requestId,
        changedFields,
      });
      ctx.body = settingsResponseSchema.parse({
        ok: true,
        data: { settings: updated },
      });
    } catch (error) {
      logger.warn('settings:service', 'settings update failed', {
        requestId: ctx.state.requestId,
        errorCode: error instanceof ApiError ? error.code : 'INTERNAL_ERROR',
      });
      throw error;
    }
  });

  const enqueueEmpty =
    (type: 'health_check' | 'diagnose' | 'reset' | 'rollback') =>
    (ctx: Context) => {
      parseRequest(emptyActionRequestSchema, requestBody(ctx));
      const task = taskEngine.enqueue(type, null, {
        requestId: String(ctx.state.requestId),
      });
      ctx.status = 202;
      ctx.body = taskAcceptedResponseSchema.parse({
        ok: true,
        data: { taskId: task.id, status: 'queued' },
      });
    };

  router.post('/api/actions/health-check', enqueueEmpty('health_check'));
  router.post('/api/actions/diagnose', enqueueEmpty('diagnose'));
  router.post('/api/actions/reset', enqueueEmpty('reset'));
  router.post('/api/actions/rollback', enqueueEmpty('rollback'));
  router.post('/api/actions/apply', (ctx) => {
    const input = parseRequest(applyActionRequestSchema, requestBody(ctx));
    const diagnosis = store.diagnoses.getDiagnosis();
    if (!diagnosis)
      throw new ApiError(409, 'NO_DIAGNOSIS', '没有可用诊断，请先重新诊断');
    const candidate = diagnosis.candidates.find((item) => item.ip === input.ip);
    if (diagnosis.status !== 'testable' || !candidate?.eligible)
      throw new ApiError(409, 'INVALID_CANDIDATE', '候选 IP 不合格或已失效');
    const task = taskEngine.enqueue(
      'apply',
      { ip: input.ip },
      {
        requestId: String(ctx.state.requestId),
      },
    );
    ctx.status = 202;
    ctx.body = taskAcceptedResponseSchema.parse({
      ok: true,
      data: { taskId: task.id, status: 'queued' },
    });
  });

  return router;
}
