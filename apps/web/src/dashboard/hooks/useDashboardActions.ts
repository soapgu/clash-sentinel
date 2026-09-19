import { useCallback, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, ApiClientError, type ManualAction } from '../../api.js';
import { formatApiError } from '../formatters.js';
import type { Confirmation } from '../model.js';

interface DashboardActionsOptions {
  busy: boolean;
  onTaskCreated: (taskId: string) => void;
  onEnableAuto: () => void;
}

export function useDashboardActions({
  busy,
  onTaskCreated,
  onEnableAuto,
}: DashboardActionsOptions) {
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const submittingRef = useRef(false);

  const mutation = useMutation({
    mutationFn: ({ action, body }: { action: ManualAction; body?: object }) =>
      api.action(action, body),
    onSuccess: (response) => {
      onTaskCreated(response.data.taskId);
      setError(null);
    },
    onError: (cause) => {
      if (cause instanceof ApiClientError && cause.details?.activeTaskId) {
        onTaskCreated(cause.details.activeTaskId);
        setError('已有手动任务正在执行，已切换到该任务。');
        return;
      }
      setError(formatApiError(cause));
    },
    onSettled: () => {
      submittingRef.current = false;
    },
  });

  const submit = (action: ManualAction, body?: object) => {
    // ref 在同一次渲染的连续调用间立即生效，避免等待 isPending 更新时重复提交。
    if (busy || mutation.isPending || submittingRef.current) return;
    submittingRef.current = true;
    mutation.mutate({ action, body });
  };

  const openConfirmation = (next: Confirmation) => {
    setError(null);
    triggerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setConfirmation(next);
  };

  const close = useCallback(() => {
    setConfirmation(null);
    // 等弹窗卸载、原按钮重新可聚焦后再恢复焦点。
    window.setTimeout(() => triggerRef.current?.focus());
  }, []);

  const request = (action: ManualAction, ip?: string) => {
    // 检测和诊断直接执行；其余手动操作需要用户确认。
    if (action === 'health-check' || action === 'diagnose') {
      setError(null);
      submit(action);
      return;
    }
    openConfirmation(action === 'apply' ? { action, ip } : { action });
  };
  const requestEnableAuto = () => {
    openConfirmation({ action: 'auto' });
  };

  const confirm = () => {
    if (!confirmation) return;
    if (confirmation.action === 'auto') onEnableAuto();
    else
      submit(
        confirmation.action,
        confirmation.action === 'apply' ? { ip: confirmation.ip } : {},
      );
    close();
  };
  return {
    confirmation,
    error,
    submitting: mutation.isPending,
    request,
    requestEnableAuto,
    confirm,
    cancel: close,
    clearError: () => setError(null),
  };
}
