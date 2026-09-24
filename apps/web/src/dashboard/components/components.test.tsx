// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type {
  HealthSnapshot,
  Settings,
  StoredTask,
} from '@clash-sentinel/shared';
import { ConfirmDialog } from './ConfirmDialog.js';
import { EntryCard } from './EntryCard.js';
import { FeedbackBanners } from './FeedbackBanners.js';
import { SettingsDrawer } from './SettingsDrawer.js';
import { TaskPanel } from './TaskPanel.js';

const settings: Settings = {
  checkIntervalMs: 60_000,
  requestTimeoutMs: 5_000,
  entryFailureThreshold: 3,
  autoSwitchCooldownMs: 300_000,
  monitoringEnabled: true,
  autoSwitchEnabled: false,
  autoSwitchProfileUid: null,
  updatedAt: '2026-09-19T00:00:00.000Z',
};

const snapshot: HealthSnapshot = {
  status: 'healthy',
  profile: { uid: 'profile-1', name: '测试订阅' },
  lock: { locked: true, domain: 'example.test', ip: '192.0.2.1' },
  internetSuccess: 3,
  internetTotal: 3,
  consecutiveFailures: 0,
  recommendedIp: null,
  autoSwitchCooldownUntil: null,
  updatedAt: '2026-09-19T00:00:00.000Z',
};

const failedTask: StoredTask = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'apply',
  status: 'failed',
  createdAt: '2026-09-19T00:00:00.000Z',
  startedAt: '2026-09-19T00:00:01.000Z',
  finishedAt: '2026-09-19T00:00:02.000Z',
  input: null,
  result: null,
  errorCode: 'APPLY_FAILED',
  errorMessage: '应用失败',
  recoveryStatus: 'recovery_failed',
};

afterEach(cleanup);

describe('Dashboard 展示组件', () => {
  test.each<{
    name: string;
    changes?: Partial<StoredTask>;
    expected: string;
  }>([
    { name: '无任务', expected: '正在读取任务' },
    {
      name: '等待执行',
      changes: { status: 'queued', recoveryStatus: null },
      expected: '任务等待执行',
    },
    {
      name: '执行中',
      changes: { status: 'running', recoveryStatus: null },
      expected: '任务执行中',
    },
    {
      name: '成功',
      changes: { status: 'succeeded', recoveryStatus: null },
      expected: '任务已完成',
    },
    {
      name: '失败',
      changes: { status: 'failed', recoveryStatus: null },
      expected: '任务失败',
    },
    {
      name: '中断',
      changes: { status: 'interrupted', recoveryStatus: null },
      expected: '任务已中断',
    },
    {
      name: '失败但已恢复',
      changes: { status: 'failed', recoveryStatus: 'recovered' },
      expected: '失败但已恢复',
    },
    {
      name: '需人工处理',
      changes: { status: 'failed', recoveryStatus: 'recovery_failed' },
      expected: '需人工处理',
    },
    {
      name: '成功优先于恢复异常',
      changes: { status: 'succeeded', recoveryStatus: 'recovery_failed' },
      expected: '任务已完成',
    },
    {
      name: '配置任务恢复未知需人工处理',
      changes: { status: 'interrupted', recoveryStatus: 'unknown' },
      expected: '需人工处理',
    },
    {
      name: '普通任务恢复未知仍显示状态',
      changes: {
        type: 'health_check',
        status: 'interrupted',
        recoveryStatus: 'unknown',
      },
      expected: '任务已中断',
    },
  ])('任务标题：$name', ({ changes, expected }) => {
    render(
      <TaskPanel
        task={changes ? { ...failedTask, ...changes } : undefined}
        loading={!changes}
        error={null}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: expected })).toBeInTheDocument();
  });

  test('入口和手动任务显示控制接口认证失败原因', () => {
    const failedSnapshot: HealthSnapshot = {
      ...snapshot,
      status: 'proxy_error',
      statusDetail: 'controller_auth_failed',
    };
    render(
      <>
        <EntryCard
          snapshot={failedSnapshot}
          settings={settings}
          offline={false}
          busy={false}
          onAction={vi.fn()}
        />
        <TaskPanel
          task={{
            ...failedTask,
            type: 'health_check',
            status: 'succeeded',
            result: failedSnapshot,
            errorCode: null,
            errorMessage: null,
          }}
          loading={false}
          error={null}
          onClose={vi.fn()}
        />
      </>,
    );
    expect(screen.getAllByRole('alert')).toHaveLength(2);
    expect(screen.getAllByText(/控制接口认证失败/)).toHaveLength(2);
  });
  test('设置抽屉转换单位、校验并提交完整设置', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <SettingsDrawer
        open
        settings={settings}
        onClose={vi.fn()}
        busy={false}
        saving={false}
        saveError={null}
        onSave={onSave}
        snapshot={snapshot}
        offline={false}
        autoSaving={false}
        onAutoChange={vi.fn()}
      />,
    );
    const interval = screen.getByLabelText(/检测间隔/);
    await user.clear(interval);
    await user.type(interval, '120');
    await user.click(screen.getByRole('button', { name: '保存设置' }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        checkIntervalMs: 120_000,
        requestTimeoutMs: 5_000,
      }),
    );

    await user.clear(interval);
    await user.type(interval, '0');
    await user.click(screen.getByRole('button', { name: '保存设置' }));
    expect(screen.getByRole('alert')).toHaveTextContent('检测间隔');
  });

  test('确认框获得焦点并支持 Escape 取消', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        confirmation={{ action: 'reset' }}
        snapshot={snapshot}
        diagnosis={null}
        settings={settings}
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: '确认执行' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledOnce();
  });

  test('区分离线、部分错误和操作错误提示', () => {
    const { rerender } = render(
      <FeedbackBanners
        initialLoading={false}
        offline
        streamState="offline"
        partialError="部分失败"
        actionError={null}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('后台不可达');
    rerender(
      <FeedbackBanners
        initialLoading={false}
        offline={false}
        streamState="connected"
        partialError="部分失败"
        actionError="任务冲突"
      />,
    );
    expect(screen.getAllByRole('alert')).toHaveLength(2);
  });

  test('恢复失败任务要求人工处理', () => {
    render(
      <TaskPanel
        task={failedTask}
        loading={false}
        error={null}
        onClose={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('heading', { name: '需人工处理' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/无法确认配置已安全恢复/)).toBeInTheDocument();
  });
});
