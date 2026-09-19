import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Settings, SettingsUpdate } from '@clash-sentinel/shared';
import { api } from '../../api.js';
import { queryKeys } from '../../queries.js';
import { formatApiError } from '../formatters.js';

export function useDashboardSettings({
  settings,
  profileUid,
  onSaved,
}: {
  settings: Settings | undefined;
  profileUid: string | null;
  onSaved: () => void;
}) {
  const client = useQueryClient();
  const updateCache = (
    response: Awaited<ReturnType<typeof api.updateSettings>>,
  ) => {
    client.setQueryData(queryKeys.settings, response);
    void client.invalidateQueries({
      queryKey: queryKeys.monitoring,
      exact: true,
    });
  };
  const saveMutation = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: (response) => {
      updateCache(response);
      onSaved();
    },
  });
  const autoMutation = useMutation({
    mutationFn: (enabled: boolean) => {
      if (!settings) throw new Error('设置尚未载入');
      const editable: SettingsUpdate = {
        checkIntervalMs: settings.checkIntervalMs,
        requestTimeoutMs: settings.requestTimeoutMs,
        entryFailureThreshold: settings.entryFailureThreshold,
        autoSwitchCooldownMs: settings.autoSwitchCooldownMs,
        monitoringEnabled: settings.monitoringEnabled,
        autoSwitchEnabled: settings.autoSwitchEnabled,
        autoSwitchProfileUid: settings.autoSwitchProfileUid,
      };
      return api.updateSettings({
        ...editable,
        autoSwitchEnabled: enabled,
        autoSwitchProfileUid: enabled ? profileUid : null,
      });
    },
    onSuccess: updateCache,
  });
  const error = saveMutation.error ?? autoMutation.error;
  return {
    save: (value: SettingsUpdate) => saveMutation.mutate(value),
    enableAutoSwitch: () => autoMutation.mutate(true),
    disableAutoSwitch: () => autoMutation.mutate(false),
    saving: saveMutation.isPending,
    autoSaving: autoMutation.isPending,
    error: error ? formatApiError(error) : null,
    resetError: () => {
      saveMutation.reset();
      autoMutation.reset();
    },
  };
}
