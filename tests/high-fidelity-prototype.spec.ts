import { expect, test } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  candidatesResponseSchema,
  eventsResponseSchema,
  settingsResponseSchema,
  sitesResponseSchema,
  statusResponseSchema,
  taskResponseSchema,
} from '@clash-sentinel/shared';

const prototypeDirectory = fileURLToPath(
  new URL('../docs/design/high-fidelity/', import.meta.url),
);
const prototypeUrl = pathToFileURL(`${prototypeDirectory}/index.html`).href;

test('原型示例数据符合共享 API Schema', async () => {
  const fixtures = JSON.parse(
    await readFile(`${prototypeDirectory}/fixtures.json`, 'utf8'),
  );
  statusResponseSchema.parse(fixtures.status);
  sitesResponseSchema.parse(fixtures.sites);
  candidatesResponseSchema.parse(fixtures.candidates);
  eventsResponseSchema.parse(fixtures.events);
  settingsResponseSchema.parse(fixtures.settings);
  taskResponseSchema.parse(fixtures.task);
});

test('场景切换、设置和确认操作可交互', async ({ page }) => {
  await page.goto(prototypeUrl);
  await expect(page.getByRole('heading', { name: '演示订阅 A' })).toBeVisible();
  await expect(page.locator('.proxy-card')).toHaveCount(3);
  await expect(page.locator('.site-logo')).toHaveCount(6);
  expect(
    await page
      .locator('.site-logo')
      .evaluateAll((images) =>
        images.every(
          (image) =>
            image instanceof HTMLImageElement &&
            image.complete &&
            image.naturalWidth > 0 &&
            image.src.startsWith('file:'),
        ),
      ),
  ).toBe(true);
  await expect(page.locator('.candidate-row.current')).toHaveCount(1);
  await expect(page.locator('.candidate-row.current')).toContainText(
    '当前使用',
  );
  await expect(
    page.locator('.candidate-row.current .apply-button'),
  ).toBeDisabled();
  await expect(page.locator('#monitorState')).toHaveText('等待下一轮');
  await expect(page.locator('#monitorLastTime')).toHaveText('10:26:18');
  await expect(page.locator('#monitorNextTime')).toHaveText('10:27:18');

  await page.locator('#scenarioSelect').selectOption('scheduled_running');
  await expect(page.locator('#monitorState')).toHaveText('正在执行定时检测');
  await expect(page.locator('#monitorPhase')).toContainText('六个固定站点');
  await page.locator('#scenarioSelect').selectOption('monitoring_disabled');
  await expect(page.locator('#monitorState')).toHaveText('定时监测已暂停');
  await expect(page.locator('#monitorNextTime')).toHaveText('—');

  await page.locator('#scenarioSelect').selectOption('offline');
  await expect(page.locator('#internetSummary')).toContainText('互联网不可达');
  await page.locator('#scenarioSelect').selectOption('healthy');

  await page.locator('#monitorSettingsButton').click();
  await expect(page.getByRole('heading', { name: '监测设置' })).toBeVisible();
  await page.locator('.setting-switch.emphasized .switch').click();
  await expect(
    page.getByRole('heading', { name: '启用自动入口切换？' }),
  ).toBeVisible();
  await page.locator('#dialogCancel').click();
  await expect(page.locator('#autoSwitchInput')).not.toBeChecked();

  await page.locator('#closeSettings').click();
  await page.getByRole('button', { name: '应用', exact: true }).first().click();
  await expect(
    page.getByRole('heading', { name: '将入口切换到新 IP？' }),
  ).toBeVisible();
  await page.locator('#dialogConfirm').click();
  await expect(page.locator('#taskPanel')).toContainText('正在应用候选 IP');
  await expect(page.locator('#healthButton')).toBeDisabled();
  await expect(page.locator('#taskPanel')).toContainText('应用候选 IP 成功', {
    timeout: 2500,
  });
});

for (const viewport of [
  { name: 'desktop', width: 1440, height: 1100 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`${viewport.name} 布局无水平溢出`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(prototypeUrl);
    const dimensions = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
    await expect(page.locator('.proxy-card')).toHaveCount(3);
    if (process.env.UPDATE_PROTOTYPE_SCREENSHOTS === '1') {
      const screenshotDirectory = `${prototypeDirectory}/screenshots`;
      await mkdir(screenshotDirectory, { recursive: true });
      await page.screenshot({
        path: `${screenshotDirectory}/${viewport.name}.png`,
        fullPage: true,
      });
    }
  });
}
