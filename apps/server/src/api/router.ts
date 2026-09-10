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
import type { SqliteStore } from '../storage/store.js';
import type { TaskService } from '../services/task-service.js';
import type { StatusNotificationCenter } from '../services/status-notifier.js';
import { ApiError } from './errors.js';

/** API 路由访问持久化数据和异步任务服务所需的依赖。 */
export interface ApiRouterOptions {
  /** SQLite 数据访问门面。 */
  store: SqliteStore;
  /** 全局串行的 Legacy 任务服务。 */
  taskService: TaskService;
  /** 当前进程中的定时健康检测调度器。 */
  scheduler: Pick<HealthScheduler, 'getSnapshot'>;
  /** 当前进程中的 SSE 通知和连接生命周期中心。 */
  notifier: Pick<StatusNotificationCenter, 'subscribe'>;
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
  const { store, taskService, scheduler, notifier } = options;
  const now = options.now ?? Date.now;
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
      data: { snapshot: store.getHealthSnapshot() },
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
      if (!ctx.res.destroyed && !ctx.res.writableEnded) ctx.res.end();
    };
    const writeNotification = (notification: StreamNotification) => {
      const frame = `id: ${notification.id}\nevent: invalidate\ndata: ${JSON.stringify(notification)}\n\n`;
      if (!ctx.res.write(frame)) {
        cleanup();
        throw new Error('SSE 客户端读取过慢');
      }
    };

    ctx.req.setTimeout(0);
    ctx.status = 200;
    ctx.set('Content-Type', 'text/event-stream; charset=utf-8');
    ctx.set('Cache-Control', 'no-cache, no-transform');
    ctx.set('Connection', 'keep-alive');
    ctx.set('X-Accel-Buffering', 'no');
    ctx.respond = false;
    ctx.res.flushHeaders();
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
    const staleAfterMs = store.getSettings().checkIntervalMs * 2;
    const sites = Object.fromEntries(
      siteTargetSchema.options.map((target) => {
        const result = store.getSiteSnapshot(target);
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
      data: { diagnosis: store.getDiagnosis() },
    });
  });

  router.get('/api/events', (ctx) => {
    const query = parseRequest(eventsQuerySchema, ctx.query);
    ctx.body = eventsResponseSchema.parse({
      ok: true,
      data: {
        items: store.listEvents(query.limit, query.offset),
        ...query,
        total: store.countEvents(),
      },
    });
  });

  router.get('/api/settings', (ctx) => {
    ctx.body = settingsResponseSchema.parse({
      ok: true,
      data: { settings: store.getSettings() },
    });
  });

  router.get('/api/tasks/:id', (ctx) => {
    const { id } = parseRequest(taskParamsSchema, ctx.params);
    const task = store.getTask(id);
    if (!task) throw new ApiError(404, 'NOT_FOUND', '任务不存在');
    ctx.body = taskResponseSchema.parse({ ok: true, data: { task } });
  });

  router.put('/api/settings', (ctx) => {
    const input = parseRequest(settingsUpdateSchema, requestBody(ctx));
    const normalized = input.autoSwitchEnabled
      ? input
      : { ...input, autoSwitchProfileUid: null };
    if (normalized.autoSwitchEnabled) {
      if (taskService.hasActiveOperation())
        throw new ApiError(409, 'ACTION_CONFLICT', '已有操作正在执行', {
          ...taskService.getConflictDetails(),
        });
      const snapshot = store.getHealthSnapshot();
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
    ctx.body = settingsResponseSchema.parse({
      ok: true,
      data: { settings: store.updateSettings(normalized) },
    });
  });

  const enqueueEmpty =
    (type: 'health_check' | 'diagnose' | 'reset' | 'rollback') =>
    (ctx: Context) => {
      parseRequest(emptyActionRequestSchema, requestBody(ctx));
      const task = taskService.enqueue(type);
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
    const diagnosis = store.getDiagnosis();
    if (!diagnosis)
      throw new ApiError(409, 'NO_DIAGNOSIS', '没有可用诊断，请先重新诊断');
    const candidate = diagnosis.candidates.find((item) => item.ip === input.ip);
    if (diagnosis.status !== 'testable' || !candidate?.eligible)
      throw new ApiError(409, 'INVALID_CANDIDATE', '候选 IP 不合格或已失效');
    const task = taskService.enqueue('apply', { ip: input.ip });
    ctx.status = 202;
    ctx.body = taskAcceptedResponseSchema.parse({
      ok: true,
      data: { taskId: task.id, status: 'queued' },
    });
  });

  return router;
}
