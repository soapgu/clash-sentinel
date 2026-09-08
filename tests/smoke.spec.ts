import { test, expect } from '@playwright/test';
test('生产页面连接同源健康 API', async ({ page, request }) => {
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Clash Sentinel' }),
  ).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('后台已连接');
  expect((await request.get('/api/health')).status()).toBe(200);
  expect((await request.get('/api/missing')).status()).toBe(404);
  expect((await request.get('/assets/missing.js')).status()).toBe(404);
  await page.goto('/overview');
  await expect(page.getByRole('status')).toHaveText('后台已连接');
});
test('后台不可达时给出明确反馈', async ({ page }) => {
  await page.route('**/api/health', (route) => route.abort());
  await page.goto('/');
  await expect(page.getByRole('status')).toHaveText(
    '后台连接失败，请检查服务是否启动。',
  );
});
