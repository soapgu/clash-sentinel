import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';

const fixtures = JSON.parse(
  readFileSync(
    new URL('../docs/design/high-fidelity/fixtures.json', import.meta.url),
    'utf8',
  ),
) as Record<string, unknown>;

async function mockDashboardSnapshots(
  page: Page,
  overrides: Record<string, unknown> = {},
) {
  const responses: Record<string, unknown> = {
    health: {
      ok: true,
      data: { service: 'clash-sentinel', status: 'ok' },
    },
    monitoring: {
      ok: true,
      data: {
        monitoring: {
          enabled: true,
          state: 'waiting',
          lastStartedAt: '2026-09-09T02:26:02.000Z',
          lastCompletedAt: '2026-09-09T02:26:18.000Z',
          nextRunAt: '2026-09-09T02:27:18.000Z',
        },
      },
    },
    ...fixtures,
    ...overrides,
  };
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/stream') {
      await route.continue();
      return;
    }
    const key = path.slice('/api/'.length);
    if (!(key in responses)) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(responses[key]),
    });
  });
}

test('生产页面读取同源快照并建立 SSE', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByText('Clash Sentinel', { exact: true })).toBeVisible();
  await expect(page.getByText('实时同步', { exact: true })).toBeVisible();
  await expect(page.getByText('当前入口', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '国内互联网' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: '站点访问质量' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: '候选 IP' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '最近事件' })).toBeVisible();
  expect((await request.get('/api/health')).status()).toBe(200);
  expect((await request.get('/api/missing')).status()).toBe(404);
  expect((await request.get('/assets/missing.js')).status()).toBe(404);
  await page.goto('/overview');
  await expect(page.getByText('实时同步', { exact: true })).toBeVisible();
});

test('完整快照展示入口、六站、候选和官方服务状态', async ({ page }) => {
  await mockDashboardSnapshots(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '演示订阅 A' })).toBeVisible();
  await expect(page.getByText('3 / 3 可达', { exact: true })).toBeVisible();
  for (const name of ['百度', '淘宝', '腾讯', 'Google', 'GitHub', 'OpenAI'])
    await expect(page.getByText(name, { exact: true })).toBeVisible();
  await expect(page.getByText('官方服务正常')).toBeVisible();
  await expect(page.getByText('198.51.100.18', { exact: true })).toBeVisible();
  await expect(page.getByText('推荐', { exact: true })).toBeVisible();
  await expect(page.getByText('严格诊断完成')).toBeVisible();
});

test('首次加载与空快照使用独立状态且不会触发检测', async ({ page }) => {
  await page.route('**/api/status', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: { snapshot: null } }),
    });
  });
  await page.route('**/api/candidates', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, data: { diagnosis: null } }),
    }),
  );
  await page.goto('/');
  await expect(page.getByText('正在读取已有快照')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: '尚未识别订阅' }),
  ).toBeVisible();
  await expect(page.getByText('尚无候选数据')).toBeVisible();
});

test('单个代理站点失败不会覆盖其他站点的独立状态', async ({ page }) => {
  const siteFixture = structuredClone(fixtures.sites) as {
    data: { sites: Record<string, Record<string, unknown>> };
  };
  siteFixture.data.sites.github = {
    ...siteFixture.data.sites.github,
    reachable: false,
    httpStatus: null,
    durationMs: null,
    errorType: 'timeout',
  };
  await mockDashboardSnapshots(page, { sites: siteFixture });
  await page.goto('/');
  await expect(
    page.locator('article').filter({ hasText: 'GitHub' }).getByText('不可达'),
  ).toBeVisible();
  await expect(
    page.locator('article').filter({ hasText: 'Google' }).getByText('可达'),
  ).toBeVisible();
  await expect(
    page.locator('article').filter({ hasText: 'OpenAI' }).getByText('可达'),
  ).toBeVisible();
});

test('刷新和所有预留操作保持只读', async ({ page }) => {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET')
      writes.push(`${request.method()} ${request.url()}`);
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '立即检测' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '重新诊断' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '解除锁定' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '回滚变更' })).toBeDisabled();
  const refreshed = page.waitForResponse((response) =>
    response.url().endsWith('/api/status'),
  );
  await page.getByRole('button', { name: '刷新状态' }).click();
  await refreshed;

  await page.getByRole('button', { name: '打开设置' }).click();
  await expect(page.getByRole('heading', { name: '监测设置' })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存设置' })).toBeDisabled();
  await page
    .getByRole('button', { name: '关闭设置', exact: true })
    .last()
    .click();
  const settingsButton = page.getByRole('button', { name: '打开设置' });
  await settingsButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.settings-drawer')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.settings-drawer')).toBeHidden();
  expect(writes).toEqual([]);
});

test('SSE 断线后进入低频同步并在重连后全量校准', async ({ page }) => {
  let rejectStream = true;
  await page.route('**/api/stream', async (route) => {
    if (rejectStream) await route.abort('connectionfailed');
    else await route.continue();
  });
  await page.goto('/');
  await expect(page.getByText('低频同步', { exact: true })).toBeVisible();
  await expect(page.getByText('实时连接已中断')).toBeVisible();
  rejectStream = false;
  await page.unroute('**/api/stream');
  await expect(page.getByText('实时同步', { exact: true })).toBeVisible({
    timeout: 6_000,
  });
});

test('多个页面可以同时建立独立 SSE 连接', async ({ context }) => {
  const first = await context.newPage();
  const second = await context.newPage();
  await Promise.all([first.goto('/'), second.goto('/')]);
  await expect(first.getByText('实时同步', { exact: true })).toBeVisible();
  await expect(second.getByText('实时同步', { exact: true })).toBeVisible();
  await first.close();
  await expect(second.getByText('实时同步', { exact: true })).toBeVisible();
});

test('390px 窄屏没有横向溢出且设置使用全屏抽屉', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '国内互联网' })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole('button', { name: '打开设置' }).click();
  const drawer = page.locator('.settings-drawer');
  await expect(drawer).toBeVisible();
  expect(
    await drawer.evaluate((element) => element.getBoundingClientRect().width),
  ).toBeCloseTo(390, 2);
});

test('后台不可达时保留页面结构并明确标记旧数据', async ({ page }) => {
  await page.route('**/api/health', (route) => route.abort());
  await page.goto('/');
  await expect(
    page.getByRole('alert').filter({ hasText: '后台不可达' }),
  ).toBeVisible();
  await expect(page.getByText('数据可能过期').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: '国内互联网' })).toBeVisible();
});
