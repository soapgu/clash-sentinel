import { useEffect, useRef, useState } from 'react';
import type {
  HealthSnapshot,
  Settings,
  SettingsUpdate,
} from '@clash-sentinel/shared';
import { settingsUpdateSchema } from '@clash-sentinel/shared';
import { settingsValidationMessage } from '../formatters.js';
import { NumberField } from './NumberField.js';

export function SettingsDrawer({
  open,
  settings,
  onClose,
  busy,
  saving,
  saveError,
  onSave,
  snapshot,
  offline,
  autoSaving,
  onAutoChange,
}: {
  open: boolean;
  settings?: Settings;
  onClose: () => void;
  busy: boolean;
  saving: boolean;
  saveError: string | null;
  onSave: (settings: SettingsUpdate) => void;
  snapshot: HealthSnapshot | null | undefined;
  offline: boolean;
  autoSaving: boolean;
  onAutoChange: (enabled: boolean) => void;
}) {
  const [draft, setDraft] = useState({
    monitoringEnabled: true,
    checkIntervalSeconds: '60',
    requestTimeoutSeconds: '5',
    entryFailureThreshold: '3',
    cooldownMinutes: '5',
  });
  const [validationError, setValidationError] = useState<string | null>(null);
  const initialized = useRef(false);
  useEffect(() => {
    if (!open) {
      initialized.current = false;
      return;
    }
    if (!settings || initialized.current) return;
    initialized.current = true;
    setDraft({
      monitoringEnabled: settings.monitoringEnabled,
      checkIntervalSeconds: String(settings.checkIntervalMs / 1_000),
      requestTimeoutSeconds: String(settings.requestTimeoutMs / 1_000),
      entryFailureThreshold: String(settings.entryFailureThreshold),
      cooldownMinutes: String(settings.autoSwitchCooldownMs / 60_000),
    });
    setValidationError(null);
  }, [open, settings]);
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose, open]);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!settings) return;
    const parsed = settingsUpdateSchema.safeParse({
      checkIntervalMs: Number(draft.checkIntervalSeconds) * 1_000,
      requestTimeoutMs: Number(draft.requestTimeoutSeconds) * 1_000,
      entryFailureThreshold: Number(draft.entryFailureThreshold),
      autoSwitchCooldownMs: Number(draft.cooldownMinutes) * 60_000,
      monitoringEnabled: draft.monitoringEnabled,
      autoSwitchEnabled: settings.autoSwitchEnabled,
      autoSwitchProfileUid: settings.autoSwitchProfileUid,
    });
    if (!parsed.success) {
      setValidationError(
        settingsValidationMessage(parsed.error.issues[0]?.path[0]),
      );
      return;
    }
    setValidationError(null);
    onSave(parsed.data);
  };
  return (
    <>
      {open ? (
        <button
          className="drawer-backdrop"
          aria-label="关闭设置"
          onClick={onClose}
        />
      ) : null}
      <aside
        className={`settings-drawer ${open ? 'open' : ''}`}
        aria-hidden={!open}
        aria-labelledby="settings-title"
      >
        <header>
          <div>
            <span className="eyebrow">监测策略</span>
            <h2 id="settings-title">监测设置</h2>
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="关闭设置"
          >
            ×
          </button>
        </header>
        {!settings ? (
          <div className="empty-state">
            <strong>设置尚未载入</strong>
            <span>请稍后刷新重试。</span>
          </div>
        ) : (
          <form
            className="settings-form"
            id="settings-form"
            onSubmit={submit}
            noValidate
          >
            <label className="toggle-row">
              <span>定时监测</span>
              <input
                type="checkbox"
                checked={draft.monitoringEnabled}
                disabled={busy || saving}
                onChange={(event) =>
                  setDraft((value) => ({
                    ...value,
                    monitoringEnabled: event.target.checked,
                  }))
                }
              />
            </label>
            <NumberField
              label="检测间隔"
              unit="秒"
              min="1"
              max="86400"
              value={draft.checkIntervalSeconds}
              disabled={busy || saving}
              onChange={(value) =>
                setDraft((item) => ({ ...item, checkIntervalSeconds: value }))
              }
            />
            <NumberField
              label="站点请求超时"
              unit="秒"
              min="0.1"
              max="60"
              step="0.1"
              value={draft.requestTimeoutSeconds}
              disabled={busy || saving}
              onChange={(value) =>
                setDraft((item) => ({ ...item, requestTimeoutSeconds: value }))
              }
            />
            <NumberField
              label="入口失败阈值"
              unit="次"
              min="1"
              max="100"
              value={draft.entryFailureThreshold}
              disabled={busy || saving}
              onChange={(value) =>
                setDraft((item) => ({ ...item, entryFailureThreshold: value }))
              }
            />
            <NumberField
              label="自动切换冷却"
              unit="分钟"
              min="0"
              max="1440"
              value={draft.cooldownMinutes}
              disabled={busy || saving}
              onChange={(value) =>
                setDraft((item) => ({ ...item, cooldownMinutes: value }))
              }
            />
            <label className="toggle-row emphasized">
              <span>自动切换入口 IP</span>
              <input
                type="checkbox"
                aria-label="自动切换"
                checked={settings.autoSwitchEnabled}
                disabled={
                  saving ||
                  autoSaving ||
                  offline ||
                  (!settings.autoSwitchEnabled &&
                    (busy || !snapshot?.lock.locked || !snapshot.profile))
                }
                onChange={(event) => onAutoChange(event.target.checked)}
              />
            </label>
            <p className="setting-hint">
              {!snapshot?.lock.locked
                ? '请先诊断并确认锁定当前订阅。'
                : '仅在互联网正常、入口达到失败阈值且冷却结束后执行。'}
            </p>
            <div className="setting-row readonly">
              <span>绑定订阅 UID</span>
              <strong>{settings.autoSwitchProfileUid ?? '未绑定'}</strong>
            </div>
            {validationError || saveError ? (
              <p className="form-error" role="alert">
                {validationError ?? saveError}
              </p>
            ) : null}
          </form>
        )}
        <div className="drawer-actions">
          <button className="button secondary" onClick={onClose}>
            取消
          </button>
          <button
            className="button primary"
            type="submit"
            form="settings-form"
            disabled={!settings || busy || saving}
          >
            {saving ? '保存中' : '保存设置'}
          </button>
        </div>
      </aside>
    </>
  );
}
