// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { PropsWithChildren } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Settings, StoredTask } from '@clash-sentinel/shared';
import { api, ApiClientError } from '../../api.js';
import { queryKeys } from '../../queries.js';
import { ACTIVE_TASK_KEY, useTrackedTask } from './useTrackedTask.js';
import { useDashboardActions } from './useDashboardActions.js';
import { useDashboardSettings } from './useDashboardSettings.js';

const task: StoredTask = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'health_check',
  status: 'running',
  createdAt: '2026-09-19T00:00:00.000Z',
  startedAt: '2026-09-19T00:00:01.000Z',
  finishedAt: null,
  input: null,
  result: null,
  errorCode: null,
  errorMessage: null,
  recoveryStatus: null,
};

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

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('Dashboard 业务 Hooks', () => {
  test('恢复、接管和清除当前任务', async () => {
    sessionStorage.setItem(ACTIVE_TASK_KEY, task.id);
    vi.spyOn(api, 'task').mockResolvedValue({ ok: true, data: { task } });
    const { wrapper } = setup();
    const { result, rerender } = renderHook(
      ({ activeTaskId }) =>
        useTrackedTask({ streamState: 'connected', activeTaskId }),
      { wrapper, initialProps: { activeTaskId: null as string | null } },
    );
    await waitFor(() => expect(result.current.task?.id).toBe(task.id));
    expect(result.current.busy).toBe(true);
    const adopted = '22222222-2222-4222-8222-222222222222';
    rerender({ activeTaskId: adopted });
    expect(sessionStorage.getItem(ACTIVE_TASK_KEY)).toBe(adopted);
    rerender({ activeTaskId: null });
    act(() => result.current.dismiss());
    expect(sessionStorage.getItem(ACTIVE_TASK_KEY)).toBeNull();
  });

  test('手动操作成功跟踪任务，冲突时接管已有任务', async () => {
    const onTaskCreated = vi.fn();
    const onEnableAuto = vi.fn();
    const action = vi
      .spyOn(api, 'action')
      .mockResolvedValueOnce({
        ok: true,
        data: { taskId: task.id, status: 'queued' },
      })
      .mockRejectedValueOnce(
        new ApiClientError('api', '冲突', 409, 'TASK_CONFLICT', 'req-2', {
          activeTaskId: '22222222-2222-4222-8222-222222222222',
        }),
      );
    const { wrapper } = setup();
    const { result } = renderHook(
      () => useDashboardActions({ busy: false, onTaskCreated, onEnableAuto }),
      { wrapper },
    );
    act(() => result.current.request('health-check'));
    await waitFor(() => expect(onTaskCreated).toHaveBeenCalledWith(task.id));
    act(() => result.current.request('diagnose'));
    await waitFor(() =>
      expect(result.current.error).toContain('已切换到该任务'),
    );
    expect(onTaskCreated).toHaveBeenLastCalledWith(
      '22222222-2222-4222-8222-222222222222',
    );
    expect(action).toHaveBeenCalledTimes(2);
  });

  test('保存设置更新缓存并使监测状态失效', async () => {
    const response = { ok: true as const, data: { settings } };
    vi.spyOn(api, 'updateSettings').mockResolvedValue(response);
    const onSaved = vi.fn();
    const { client, wrapper } = setup();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(
      () =>
        useDashboardSettings({ settings, profileUid: 'profile-1', onSaved }),
      { wrapper },
    );
    act(() => result.current.save(settings));
    await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
    expect(client.getQueryData(queryKeys.settings)).toEqual(response);
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.monitoring,
      exact: true,
    });
  });
});
