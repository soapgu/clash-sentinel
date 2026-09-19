import { useCallback, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, ApiClientError, type ManualAction } from '../../api.js';
import { formatApiError } from '../formatters.js';
import type { Confirmation } from '../model.js';

export function useDashboardActions({
  busy,
  onTaskCreated,
  onEnableAuto,
}: {
  busy: boolean;
  onTaskCreated: (taskId: string) => void;
  onEnableAuto: () => void;
}) {
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
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
  });
  const submit = useCallback(
    (action: ManualAction, body?: object) => {
      if (!busy) mutation.mutate({ action, body });
    },
    [busy, mutation],
  );
  const rememberTrigger = () => {
    triggerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  };
  const close = useCallback(() => {
    setConfirmation(null);
    window.setTimeout(() => triggerRef.current?.focus());
  }, []);
  const request = (action: ManualAction, ip?: string) => {
    setError(null);
    if (action === 'health-check' || action === 'diagnose') {
      submit(action);
      return;
    }
    rememberTrigger();
    setConfirmation({ action, ip });
  };
  const requestEnableAuto = () => {
    setError(null);
    rememberTrigger();
    setConfirmation({ action: 'auto' });
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
