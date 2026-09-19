import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { taskPollingInterval, taskQuery } from '../../queries.js';
import type { StreamState } from '../../stream.js';

export const ACTIVE_TASK_KEY = 'clash-sentinel.active-task-id';

export function useTrackedTask({
  streamState,
  activeTaskId,
}: {
  streamState: StreamState;
  activeTaskId: string | null | undefined;
}) {
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(() =>
    sessionStorage.getItem(ACTIVE_TASK_KEY),
  );
  const taskQueryResult = useQuery({
    ...taskQuery(currentTaskId ?? ''),
    enabled: currentTaskId !== null,
    refetchInterval: (query) =>
      taskPollingInterval(streamState, query.state.data?.data.task),
  });
  const track = useCallback((taskId: string) => {
    setCurrentTaskId(taskId);
    sessionStorage.setItem(ACTIVE_TASK_KEY, taskId);
  }, []);
  const dismiss = useCallback(() => {
    setCurrentTaskId(null);
    sessionStorage.removeItem(ACTIVE_TASK_KEY);
  }, []);
  useEffect(() => {
    if (activeTaskId && activeTaskId !== currentTaskId) track(activeTaskId);
  }, [activeTaskId, currentTaskId, track]);
  const task = taskQueryResult.data?.data.task;
  return {
    task,
    loading: taskQueryResult.isPending && currentTaskId !== null,
    error: taskQueryResult.error,
    busy: task?.status === 'queued' || task?.status === 'running',
    track,
    dismiss,
  };
}
