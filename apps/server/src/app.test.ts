import { expect, test } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
test('健康接口返回已约定的结构', async () => {
  const response = await request(createApp().callback()).get('/api/health');
  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    ok: true,
    data: { service: 'clash-sentinel', status: 'ok' },
  });
});
test('未知 API 返回 JSON 404', async () => {
  const response = await request(createApp().callback()).get('/api/missing');
  expect(response.status).toBe(404);
  expect(response.body.error.code).toBe('NOT_FOUND');
});
test('内部异常不暴露路径或堆栈', async () => {
  const app = createApp();
  app.use(() => {
    throw new Error('/private/secret');
  });
  const response = await request(app.callback()).get('/broken');
  expect(response.status).toBe(500);
  expect(JSON.stringify(response.body)).not.toContain('/private');
});
