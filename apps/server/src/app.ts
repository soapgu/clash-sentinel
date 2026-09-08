import Koa from 'koa';
import Router from '@koa/router';
import bodyParser from 'koa-bodyparser';
import serve from 'koa-static';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { healthResponseSchema } from '@clash-sentinel/shared';

/**
 * 创建 Clash Sentinel 的 Koa 应用，并注册健康接口、API 兜底和可选静态资源托管。
 *
 * @param staticRoot 生产前端构建产物目录；省略时仅提供 API。
 * @returns 尚未开始监听端口的 Koa 应用实例。
 */
export function createApp(staticRoot?: string) {
  const app = new Koa();
  app.use(async (ctx, next) => {
    try {
      await next();
    } catch {
      ctx.status = 500;
      ctx.body = {
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: '后台处理失败' },
      };
    }
  });
  app.use(bodyParser());
  const router = new Router();
  router.get('/api/health', (ctx) => {
    ctx.body = healthResponseSchema.parse({
      ok: true,
      data: { service: 'clash-sentinel', status: 'ok' },
    });
  });
  app.use(router.routes());
  app.use(async (ctx, next) => {
    if (ctx.path === '/api' || ctx.path.startsWith('/api/')) {
      ctx.status = 404;
      ctx.body = {
        ok: false,
        error: { code: 'NOT_FOUND', message: '接口不存在' },
      };
      return;
    }
    await next();
  });
  if (staticRoot) {
    app.use(serve(staticRoot, { hidden: false }));
    app.use(async (ctx) => {
      if (
        !['GET', 'HEAD'].includes(ctx.method) ||
        extname(ctx.path) ||
        ctx.path.startsWith('/assets/')
      )
        return;
      try {
        const html = await readFile(join(staticRoot, 'index.html'), 'utf8');
        ctx.type = 'html';
        ctx.body = html;
      } catch {
        ctx.status = 404;
      }
    });
  }
  return app;
}
