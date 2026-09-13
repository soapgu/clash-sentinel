import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  EventRecord,
  HealthSnapshot,
  MonitoringSnapshot,
  Settings,
  SiteResult,
  SiteSnapshotView,
  SiteTarget,
  StoredDiagnosis,
  StoredTask,
  SettingsUpdate,
} from '@clash-sentinel/shared';
import { settingsUpdateSchema } from '@clash-sentinel/shared';
import { api, ApiClientError, type ManualAction } from './api.js';
import { CANDIDATE_FRESHNESS_MS, isDiagnosisFresh } from './freshness.js';
import {
  dashboardQueries,
  queryKeys,
  refreshDashboard,
  taskPollingInterval,
  taskQuery,
} from './queries.js';
import { DashboardStream, type StreamState } from './stream.js';
import baiduLogo from '../../../docs/design/high-fidelity/assets/baidu-official.png';
import githubLogo from '../../../docs/design/high-fidelity/assets/github.svg';
import googleLogo from '../../../docs/design/high-fidelity/assets/google.svg';
import openaiLogo from '../../../docs/design/high-fidelity/assets/openai.svg';
import taobaoLogo from '../../../docs/design/high-fidelity/assets/taobao-official.png';
import tencentLogo from '../../../docs/design/high-fidelity/assets/tencent-official.png';

const siteMeta: Record<
  SiteTarget,
  { name: string; logo: string; group: 'direct' | 'proxy' }
> = {
  baidu: { name: '百度', logo: baiduLogo, group: 'direct' },
  taobao: { name: '淘宝', logo: taobaoLogo, group: 'direct' },
  tencent: { name: '腾讯', logo: tencentLogo, group: 'direct' },
  google: { name: 'Google', logo: googleLogo, group: 'proxy' },
  github: { name: 'GitHub', logo: githubLogo, group: 'proxy' },
  openai_status: { name: 'OpenAI', logo: openaiLogo, group: 'proxy' },
};

const healthLabels: Record<HealthSnapshot['status'], string> = {
  healthy: '入口正常',
  internet_uncertain: '互联网状态不确定',
  internet_down: '互联网不可达',
  entry_suspected: '入口疑似异常',
  entry_down: '入口异常',
  proxy_error: 'Clash 不可用',
  unknown: '状态未知',
};

const serviceLabels: Record<
  NonNullable<SiteResult['serviceStatus']>,
  string
> = {
  operational: '官方服务正常',
  degraded: '官方服务降级',
  partial_outage: '官方服务部分中断',
  major_outage: '官方服务大面积中断',
  maintenance: '官方服务维护中',
  unknown: '官方状态未知',
};

function formatTime(value: string | null | undefined) {
  if (!value) return '尚无记录';
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(timestamp);
}

function formatDateTime(value: string) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(timestamp);
}

function toneForHealth(status: HealthSnapshot['status'] | undefined) {
  if (status === 'healthy') return 'success';
  if (status === 'internet_uncertain' || status === 'entry_suspected')
    return 'warning';
  if (
    status === 'internet_down' ||
    status === 'entry_down' ||
    status === 'proxy_error'
  )
    return 'danger';
  return 'neutral';
}

function StreamStatus({
  state,
  offline,
}: {
  state: StreamState;
  offline: boolean;
}) {
  const label = offline
    ? '后台不可达'
    : state === 'connected'
      ? '实时同步'
      : state === 'offline'
        ? '低频同步'
        : '正在连接';
  return (
    <span
      className={`connection ${offline || state === 'offline' ? 'degraded' : ''}`}
      role="status"
    >
      <i aria-hidden="true" />
      {label}
    </span>
  );
}

const ACTIVE_TASK_KEY = 'clash-sentinel.active-task-id';

function settingsValidationMessage(path: PropertyKey | undefined) {
  const messages: Record<string, string> = {
    checkIntervalMs: '检测间隔必须在 1～86400 秒之间',
    requestTimeoutMs: '请求超时必须在 0.1～60 秒之间',
    entryFailureThreshold: '失败阈值必须是 1～100 的整数',
    autoSwitchCooldownMs: '冷却时间必须在 0～1440 分钟之间',
  };
  return messages[String(path)] ?? '设置格式无效';
}

function formatApiError(error: unknown) {
  if (!(error instanceof ApiClientError)) return '操作失败，请稍后重试。';
  return `${error.message}${error.requestId ? ` · 请求 ID ${error.requestId}` : ''}`;
}

function MonitoringStrip({
  monitoring,
  settings,
}: {
  monitoring?: MonitoringSnapshot;
  settings?: Settings;
}) {
  const stateLabel = !monitoring
    ? '尚无调度数据'
    : monitoring.state === 'running'
      ? '正在执行定时检测'
      : monitoring.state === 'disabled'
        ? '定时监测已暂停'
        : '等待下一轮';
  const enabled = monitoring?.enabled ?? settings?.monitoringEnabled;
  return (
    <section className="monitor-strip panel" aria-labelledby="monitor-title">
      <div className="monitor-heading">
        <span className="monitor-icon" aria-hidden="true">
          ◴
        </span>
        <div>
          <span className="eyebrow">自动调度</span>
          <h2 id="monitor-title">定时监测</h2>
        </div>
      </div>
      <div className="monitor-state">
        <span className={`status-pill ${enabled ? 'success' : 'neutral'}`}>
          ● {enabled ? '已开启' : '已暂停'}
        </span>
        <strong>{stateLabel}</strong>
        <small>
          {settings
            ? `每 ${Math.round(settings.checkIntervalMs / 1_000)} 秒检测一次`
            : '正在读取监测策略'}
        </small>
      </div>
      <div className="monitor-time">
        <span>上次检测</span>
        <strong>{formatTime(monitoring?.lastCompletedAt)}</strong>
      </div>
      <div className="monitor-time">
        <span>{monitoring?.state === 'running' ? '本轮开始' : '预计下次'}</span>
        <strong>
          {formatTime(
            monitoring?.state === 'running'
              ? monitoring.lastStartedAt
              : monitoring?.nextRunAt,
          )}
        </strong>
      </div>
    </section>
  );
}

function EntryCard({
  snapshot,
  settings,
  offline,
  busy,
  onAction,
}: {
  snapshot: HealthSnapshot | null | undefined;
  settings?: Settings;
  offline: boolean;
  busy: boolean;
  onAction: (action: ManualAction) => void;
}) {
  const profileName = snapshot?.profile?.name ?? '尚未识别订阅';
  const healthTone = offline ? 'neutral' : toneForHealth(snapshot?.status);
  const cooldownUntil = snapshot?.autoSwitchCooldownUntil
    ? Date.parse(snapshot.autoSwitchCooldownUntil)
    : 0;
  const cooldownSeconds = Math.max(
    0,
    Math.ceil((cooldownUntil - Date.now()) / 1_000),
  );
  return (
    <section
      className={`entry-card panel ${offline ? 'is-offline' : ''}`}
      aria-labelledby="entry-title"
    >
      <div className="entry-main">
        <div className="section-heading">
          <div>
            <span className="eyebrow">当前入口</span>
            <h1 id="entry-title">{profileName}</h1>
          </div>
          <span className={`status-pill ${healthTone}`}>
            ●{' '}
            {offline
              ? '数据可能过期'
              : snapshot
                ? healthLabels[snapshot.status]
                : '尚无健康数据'}
          </span>
        </div>
        <div className="entry-details">
          <div>
            <span>入口域名</span>
            <strong>
              {snapshot?.lock.locked ? snapshot.lock.domain : '未锁定'}
            </strong>
          </div>
          <div>
            <span>锁定 IP</span>
            <strong>{snapshot?.lock.locked ? snapshot.lock.ip : '—'}</strong>
          </div>
          <div>
            <span>连续失败</span>
            <strong>
              {snapshot
                ? `${snapshot.consecutiveFailures} / ${settings?.entryFailureThreshold ?? '—'}`
                : '—'}
            </strong>
          </div>
          <div>
            <span>自动切换</span>
            <strong>
              {settings?.autoSwitchEnabled
                ? cooldownSeconds > 0
                  ? `冷却 ${Math.floor(cooldownSeconds / 60)}:${String(cooldownSeconds % 60).padStart(2, '0')}`
                  : '已开启'
                : '已关闭'}
            </strong>
          </div>
          <div>
            <span>状态更新</span>
            <strong>{formatTime(snapshot?.updatedAt)}</strong>
          </div>
        </div>
      </div>
      <div className="entry-actions" aria-label="手动操作">
        <button
          className="button primary"
          disabled={busy || offline}
          onClick={() => onAction('health-check')}
        >
          立即检测
        </button>
        <button
          className="button secondary"
          disabled={busy || offline}
          onClick={() => onAction('diagnose')}
        >
          重新诊断
        </button>
        <button
          className="button ghost"
          disabled={busy || offline || !snapshot?.lock.locked}
          onClick={() => onAction('reset')}
        >
          解除锁定
        </button>
        <button
          className="button ghost"
          disabled={busy || offline}
          onClick={() => onAction('rollback')}
        >
          回滚变更
        </button>
        <small>{busy ? '已有任务正在执行' : '高风险操作需要确认'}</small>
      </div>
    </section>
  );
}

function SiteCard({
  target,
  result,
  offline,
}: {
  target: SiteTarget;
  result: SiteSnapshotView | null | undefined;
  offline: boolean;
}) {
  const meta = siteMeta[target];
  const stale = offline || result?.stale;
  const tone = stale
    ? 'neutral'
    : result?.reachable
      ? 'success'
      : result
        ? 'danger'
        : 'neutral';
  const primary = !result
    ? '尚无检测数据'
    : result.reachable
      ? `HTTP ${result.httpStatus} · ${Math.round(result.durationMs ?? 0)} ms`
      : `连接失败 · ${result.errorType ?? 'unknown'}`;
  return (
    <article
      className={`site-card ${meta.group === 'direct' ? 'mini-site' : ''} ${stale ? 'is-stale' : ''}`}
    >
      <div className="site-identity">
        <img src={meta.logo} alt="" />
        <div>
          <strong>{meta.name}</strong>
          <span className={`site-state ${tone}`}>
            ●{' '}
            {stale
              ? '数据可能过期'
              : result?.reachable
                ? '可达'
                : result
                  ? '不可达'
                  : '未知'}
          </span>
        </div>
      </div>
      <div className="site-metrics">
        <strong>{primary}</strong>
        <span>检测于 {formatTime(result?.checkedAt)}</span>
      </div>
      {target === 'openai_status' && result?.serviceStatus ? (
        <div className="service-status">
          {serviceLabels[result.serviceStatus]}
          {result.incidentSummary ? ` · ${result.incidentSummary}` : ''}
        </div>
      ) : null}
    </article>
  );
}

function CandidatePanel({
  diagnosis,
  now,
  offline,
  currentIp,
  busy,
  onApply,
}: {
  diagnosis: StoredDiagnosis | null | undefined;
  now: number;
  offline: boolean;
  currentIp: string | null;
  busy: boolean;
  onApply: (ip: string) => void;
}) {
  const fresh = isDiagnosisFresh(diagnosis ?? null, now) && !offline;
  const expiresAt = diagnosis
    ? new Date(
        Date.parse(diagnosis.savedAt) + CANDIDATE_FRESHNESS_MS,
      ).toISOString()
    : null;
  return (
    <section
      className="panel candidates-panel"
      aria-labelledby="candidates-title"
    >
      <div className="section-heading">
        <div>
          <span className="eyebrow">最近诊断</span>
          <h2 id="candidates-title">候选 IP</h2>
        </div>
        <span className={`status-pill ${fresh ? 'success' : 'neutral'}`}>
          {diagnosis
            ? fresh
              ? `有效至 ${formatTime(expiresAt)}`
              : '报告已过期'
            : '尚无报告'}
        </span>
      </div>
      {!diagnosis ? (
        <div className="empty-state">
          <strong>尚无候选数据</strong>
          <span>完成严格诊断后将在这里显示候选。</span>
        </div>
      ) : diagnosis.status === 'skipped' ? (
        <div className="empty-state">
          <strong>当前订阅不支持候选测试</strong>
          <span>
            {diagnosis.detail ?? diagnosis.skipReason ?? '未提供原因'}
          </span>
        </div>
      ) : diagnosis.candidates.length === 0 ? (
        <div className="empty-state">
          <strong>未找到合格候选</strong>
          <span>保持当前配置，等待下一次诊断。</span>
        </div>
      ) : (
        <div className="candidate-list">
          {diagnosis.candidates.map((candidate) => {
            const applicable =
              fresh && candidate.eligible && candidate.ip !== currentIp;
            return (
              <article
                className={`candidate ${candidate.ip === diagnosis.recommendedIp ? 'recommended' : ''}`}
                key={candidate.ip}
              >
                <div>
                  <strong>{candidate.ip}</strong>
                  {candidate.ip === diagnosis.recommendedIp ? (
                    <span className="recommend-label">推荐</span>
                  ) : null}
                  <span>{candidate.sources.join(' · ') || '来源未知'}</span>
                </div>
                <div className="candidate-stats">
                  <span>
                    成功率 <strong>{candidate.successRate}%</strong>
                  </span>
                  <span>
                    平均 <strong>{Math.round(candidate.averageMs)} ms</strong>
                  </span>
                  <span>
                    {candidate.success} / {candidate.total}
                  </span>
                </div>
                <button
                  className="button compact"
                  disabled={!applicable || busy || offline}
                  onClick={() => onApply(candidate.ip)}
                >
                  {candidate.ip === currentIp ? '当前 IP' : '应用'}
                </button>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function EventsPanel({ events }: { events: EventRecord[] | undefined }) {
  return (
    <section className="panel events-panel" aria-labelledby="events-title">
      <div className="section-heading">
        <div>
          <span className="eyebrow">操作与状态变化</span>
          <h2 id="events-title">最近事件</h2>
        </div>
        <span className="event-count">{events?.length ?? 0} 条</span>
      </div>
      {!events?.length ? (
        <div className="empty-state">
          <strong>尚无事件</strong>
          <span>状态变化和任务结果将记录在这里。</span>
        </div>
      ) : (
        <ol className="event-list">
          {events.slice(0, 8).map((event) => (
            <li key={event.id} className={`severity-${event.severity}`}>
              <i aria-hidden="true" />
              <div>
                <strong>{event.summary}</strong>
                <span>{formatDateTime(event.occurredAt)}</span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function SettingsDrawer({
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
              step="1"
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

function NumberField({
  label,
  unit,
  value,
  onChange,
  disabled,
  min,
  max,
  step = '1',
}: {
  label: string;
  unit: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  min: string;
  max: string;
  step?: string;
}) {
  return (
    <label className="setting-field">
      <span>{label}</span>
      <span className="input-with-unit">
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
        <small>{unit}</small>
      </span>
    </label>
  );
}

const taskNames: Record<StoredTask['type'], string> = {
  health_check: '立即检测',
  diagnose: '重新诊断',
  apply: '应用候选',
  reset: '解除锁定',
  rollback: '回滚变更',
  auto_switch: '自动切换',
};
const taskStatusLabels: Record<StoredTask['status'], string> = {
  queued: '等待执行',
  running: '执行中',
  succeeded: '成功',
  failed: '失败',
  interrupted: '已中断',
};

function TaskPanel({
  task,
  loading,
  error,
  onClose,
}: {
  task?: StoredTask;
  loading: boolean;
  error: unknown;
  onClose: () => void;
}) {
  if (!task && !loading && !error) return null;
  const terminal =
    Boolean(error) ||
    Boolean(
      task && ['succeeded', 'failed', 'interrupted'].includes(task.status),
    );
  const needsAttention =
    task?.recoveryStatus === 'recovery_failed' ||
    (task?.recoveryStatus === 'unknown' &&
      ['apply', 'reset', 'rollback', 'auto_switch'].includes(task.type));
  const title = !task
    ? '正在读取任务'
    : task.status === 'succeeded'
      ? '任务已完成'
      : task.status === 'failed' && task.recoveryStatus === 'recovered'
        ? '失败但已恢复'
        : needsAttention
          ? '需人工处理'
          : task.status === 'interrupted'
            ? '任务已中断'
            : task.status === 'failed'
              ? '任务失败'
              : task.status === 'running'
                ? '任务执行中'
                : '任务等待执行';
  const resultSummary = task?.result
    ? [task.result.message, task.result.status, task.result.recommendedIp]
        .find((value) => typeof value === 'string')
        ?.toString()
    : null;
  return (
    <section
      className={`task-panel panel ${needsAttention ? 'danger' : task?.status === 'succeeded' ? 'success' : ''}`}
      aria-live="polite"
      aria-labelledby="task-panel-title"
    >
      <div className="section-heading">
        <div>
          <span className="eyebrow">后台任务</span>
          <h2 id="task-panel-title">{title}</h2>
        </div>
        {terminal ? (
          <button
            className="icon-button"
            aria-label="关闭任务状态"
            onClick={onClose}
          >
            ×
          </button>
        ) : null}
      </div>
      {error ? (
        <p className="form-error">{formatApiError(error)}</p>
      ) : task ? (
        <dl className="task-details">
          <div>
            <dt>类型</dt>
            <dd>{taskNames[task.type]}</dd>
          </div>
          <div>
            <dt>状态</dt>
            <dd>{taskStatusLabels[task.status]}</dd>
          </div>
          <div>
            <dt>任务 ID</dt>
            <dd>{task.id}</dd>
          </div>
          <div>
            <dt>开始时间</dt>
            <dd>{formatTime(task.startedAt)}</dd>
          </div>
          <div>
            <dt>结束时间</dt>
            <dd>{formatTime(task.finishedAt)}</dd>
          </div>
        </dl>
      ) : (
        <p>正在读取任务状态…</p>
      )}
      {task?.errorMessage ? (
        <p className="task-message">{task.errorMessage}</p>
      ) : null}
      {resultSummary ? (
        <p className="task-message">结果：{resultSummary}</p>
      ) : null}
      {task?.recoveryStatus === 'recovered' ? (
        <p className="task-recovery">原文件与运行配置已恢复。</p>
      ) : task?.recoveryStatus === 'not_required' ? (
        <p className="task-recovery">修改前已拒绝，未改动配置。</p>
      ) : needsAttention ? (
        <p className="task-recovery">
          无法确认配置已安全恢复，请检查 Clash 配置与运行状态。
        </p>
      ) : null}
    </section>
  );
}

interface Confirmation {
  action: Extract<ManualAction, 'apply' | 'reset' | 'rollback'> | 'auto';
  ip?: string;
}

function ConfirmDialog({
  confirmation,
  snapshot,
  diagnosis,
  settings,
  onCancel,
  onConfirm,
}: {
  confirmation: Confirmation | null;
  snapshot: HealthSnapshot | null | undefined;
  diagnosis: StoredDiagnosis | null | undefined;
  settings: Settings | undefined;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!confirmation) return;
    confirmRef.current?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [confirmation, onCancel]);
  if (!confirmation) return null;
  const content =
    confirmation.action === 'auto' ? (
      <>
        将为订阅“{snapshot?.profile?.name ?? '未知'}”启用自动切换。入口连续失败{' '}
        {settings?.entryFailureThreshold ?? '—'}{' '}
        次、互联网正常且存在合格备选时， 后台会自动修改配置；每次处理后冷却{' '}
        {Math.round((settings?.autoSwitchCooldownMs ?? 0) / 60_000)} 分钟。
      </>
    ) : confirmation.action === 'apply' ? (
      <>
        将为订阅“{diagnosis?.profile.name ?? snapshot?.profile?.name ?? '未知'}”
        的入口域名 {diagnosis?.domain ?? '未识别'}，把当前 IP{' '}
        {snapshot?.lock.locked ? snapshot.lock.ip : '未锁定'} 切换为{' '}
        {confirmation.ip}。
      </>
    ) : confirmation.action === 'reset' ? (
      <>
        将解除当前入口锁定
        {snapshot?.lock.locked
          ? ` ${snapshot.lock.domain} → ${snapshot.lock.ip}`
          : ''}
        ，并关闭自动切换。
      </>
    ) : (
      <>
        后台将复核最近备份、订阅和文件上下文；如条件不满足会安全拒绝，不预先假定恢复目标。
      </>
    );
  return (
    <div className="dialog-backdrop" role="presentation">
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
      >
        <h2 id="confirm-title">
          确认
          {confirmation.action === 'auto'
            ? '启用自动切换'
            : confirmation.action === 'apply'
              ? '应用候选'
              : confirmation.action === 'reset'
                ? '解除锁定'
                : '回滚变更'}
        </h2>
        <p>{content}</p>
        <div className="dialog-actions">
          <button className="button secondary" onClick={onCancel}>
            取消
          </button>
          <button
            ref={confirmRef}
            className="button primary"
            onClick={onConfirm}
          >
            {confirmation.action === 'auto' ? '启用自动切换' : '确认执行'}
          </button>
        </div>
      </div>
    </div>
  );
}

function errorSummary(errors: unknown[]) {
  const error = errors.find(Boolean);
  if (!(error instanceof ApiClientError)) return '部分数据读取失败，请重试。';
  const requestId = error.requestId ? ` · 请求 ID ${error.requestId}` : '';
  return `${error.message}${requestId}`;
}

/** Clash Sentinel 状态与手动操作工作台。 */
export function Dashboard() {
  const client = useQueryClient();
  const health = useQuery(dashboardQueries.health);
  const monitoring = useQuery(dashboardQueries.monitoring);
  const status = useQuery(dashboardQueries.status);
  const sites = useQuery(dashboardQueries.sites);
  const candidates = useQuery(dashboardQueries.candidates);
  const events = useQuery(dashboardQueries.events);
  const settings = useQuery(dashboardQueries.settings);
  const [streamState, setStreamState] = useState<StreamState>('connecting');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(() =>
    sessionStorage.getItem(ACTIVE_TASK_KEY),
  );
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const actionTriggerRef = useRef<HTMLElement | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const stream = useMemo(() => new DashboardStream(client), [client]);
  const task = useQuery({
    ...taskQuery(currentTaskId ?? ''),
    enabled: currentTaskId !== null,
    refetchInterval: (query) =>
      taskPollingInterval(streamState, query.state.data?.data.task),
  });
  const actionMutation = useMutation({
    mutationFn: ({ action, body }: { action: ManualAction; body?: object }) =>
      api.action(action, body),
    onSuccess: (response) => {
      const id = response.data.taskId;
      setCurrentTaskId(id);
      sessionStorage.setItem(ACTIVE_TASK_KEY, id);
      setActionError(null);
    },
    onError: (error) => {
      if (error instanceof ApiClientError && error.details?.activeTaskId) {
        const id = error.details.activeTaskId;
        setCurrentTaskId(id);
        sessionStorage.setItem(ACTIVE_TASK_KEY, id);
        setActionError('已有手动任务正在执行，已切换到该任务。');
        return;
      }
      setActionError(formatApiError(error));
    },
  });
  const settingsMutation = useMutation({
    mutationFn: api.updateSettings,
    onSuccess: (response) => {
      client.setQueryData(queryKeys.settings, response);
      void client.invalidateQueries({
        queryKey: queryKeys.monitoring,
        exact: true,
      });
      setSettingsOpen(false);
      settingsButtonRef.current?.focus();
    },
  });
  const autoSwitchMutation = useMutation({
    mutationFn: (enabled: boolean) => {
      const current = settings.data?.data.settings;
      const profileUid = status.data?.data.snapshot?.profile?.uid ?? null;
      if (!current) throw new Error('设置尚未载入');
      const editable: SettingsUpdate = {
        checkIntervalMs: current.checkIntervalMs,
        requestTimeoutMs: current.requestTimeoutMs,
        entryFailureThreshold: current.entryFailureThreshold,
        autoSwitchCooldownMs: current.autoSwitchCooldownMs,
        monitoringEnabled: current.monitoringEnabled,
        autoSwitchEnabled: current.autoSwitchEnabled,
        autoSwitchProfileUid: current.autoSwitchProfileUid,
      };
      return api.updateSettings({
        ...editable,
        autoSwitchEnabled: enabled,
        autoSwitchProfileUid: enabled ? profileUid : null,
      });
    },
    onSuccess: (response) => {
      client.setQueryData(queryKeys.settings, response);
      void client.invalidateQueries({
        queryKey: queryKeys.monitoring,
        exact: true,
      });
    },
  });

  useEffect(() => {
    const unsubscribe = stream.subscribe(setStreamState);
    stream.start();
    return () => {
      unsubscribe();
      stream.stop();
    };
  }, [stream]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const dashboardResults = [
    health,
    monitoring,
    status,
    sites,
    candidates,
    events,
    settings,
  ];
  const fetching = dashboardResults.some((query) => query.isFetching);
  const initialLoading = dashboardResults.some((query) => query.isPending);
  const errors = [
    health.error,
    monitoring.error,
    status.error,
    sites.error,
    candidates.error,
    events.error,
    settings.error,
  ];
  const hasError = errors.some(Boolean);
  useEffect(() => {
    if (!fetching && !hasError) setLastSyncedAt(Date.now());
  }, [fetching, hasError]);
  const offline = health.isError;
  const siteMap = sites.data?.data.sites;
  const directTargets = ['baidu', 'taobao', 'tencent'] as const;
  const proxyTargets = ['google', 'github', 'openai_status'] as const;
  const directReachable = directTargets.filter(
    (target) => siteMap?.[target]?.reachable,
  ).length;
  const trackedTask = task.data?.data.task;
  const taskBusy =
    actionMutation.isPending ||
    trackedTask?.status === 'queued' ||
    trackedTask?.status === 'running';
  useEffect(() => {
    const activeTaskId = monitoring.data?.data.monitoring.activeTaskId;
    if (!activeTaskId || activeTaskId === currentTaskId) return;
    setCurrentTaskId(activeTaskId);
    sessionStorage.setItem(ACTIVE_TASK_KEY, activeTaskId);
  }, [currentTaskId, monitoring.data?.data.monitoring.activeTaskId]);

  const submitAction = (action: ManualAction, body?: object) => {
    if (taskBusy) return;
    actionMutation.mutate({ action, body });
  };
  const requestAction = (action: ManualAction, ip?: string) => {
    setActionError(null);
    if (action === 'health-check' || action === 'diagnose') {
      submitAction(action);
      return;
    }
    actionTriggerRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setConfirmation({ action, ip });
  };
  const closeConfirmation = () => {
    setConfirmation(null);
    window.setTimeout(() => actionTriggerRef.current?.focus());
  };
  const confirmAction = () => {
    if (!confirmation) return;
    if (confirmation.action === 'auto') {
      autoSwitchMutation.mutate(true);
      closeConfirmation();
      return;
    }
    submitAction(
      confirmation.action,
      confirmation.action === 'apply' ? { ip: confirmation.ip } : {},
    );
    closeConfirmation();
  };
  const dismissTask = () => {
    setCurrentTaskId(null);
    sessionStorage.removeItem(ACTIVE_TASK_KEY);
    setActionError(null);
  };
  const closeSettings = () => {
    setSettingsOpen(false);
    settingsMutation.reset();
    settingsButtonRef.current?.focus();
  };

  const handleRefresh = async () => {
    setNow(Date.now());
    await refreshDashboard(client);
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            CS
          </span>
          <div>
            <strong>Clash Sentinel</strong>
            <span>本机入口守护</span>
          </div>
        </div>
        <div className="top-actions">
          <StreamStatus state={streamState} offline={offline} />
          <span className="sync-time">
            {lastSyncedAt
              ? `同步于 ${formatTime(new Date(lastSyncedAt).toISOString())}`
              : '首次同步中'}
          </span>
          <button
            className="button secondary"
            onClick={() => void handleRefresh()}
            disabled={fetching}
          >
            <span aria-hidden="true">↻</span> {fetching ? '刷新中' : '刷新状态'}
          </button>
          <button
            ref={settingsButtonRef}
            className="icon-button"
            aria-label="打开设置"
            onClick={() => setSettingsOpen(true)}
          >
            ⚙
          </button>
        </div>
      </header>

      <main className="workspace">
        <MonitoringStrip
          monitoring={monitoring.data?.data.monitoring}
          settings={settings.data?.data.settings}
        />
        {initialLoading ? (
          <div className="banner info" role="status">
            <strong>正在读取已有快照</strong>
            <span>首次加载只读取已保存状态，不会发起网络检测。</span>
          </div>
        ) : null}
        {offline ? (
          <div className="banner danger" role="alert">
            <strong>后台不可达</strong>
            <span>
              当前展示的是最后一次快照，所有健康状态均视为可能过期。系统正在低频重试。
            </span>
          </div>
        ) : streamState === 'offline' ? (
          <div className="banner warning" role="status">
            <strong>实时连接已中断</strong>
            <span>快照接口仍可用，已切换为每 15 秒低频同步。</span>
          </div>
        ) : null}
        {hasError && !offline ? (
          <div className="banner warning" role="alert">
            <strong>部分数据读取失败</strong>
            <span>{errorSummary(errors)}</span>
          </div>
        ) : null}
        {actionError ? (
          <div className="banner warning" role="alert">
            <strong>操作未受理</strong>
            <span>{actionError}</span>
          </div>
        ) : null}
        <TaskPanel
          task={trackedTask}
          loading={task.isPending && currentTaskId !== null}
          error={task.error}
          onClose={dismissTask}
        />
        <EntryCard
          snapshot={status.data?.data.snapshot}
          settings={settings.data?.data.settings}
          offline={offline}
          busy={taskBusy}
          onAction={requestAction}
        />

        <section aria-labelledby="internet-title">
          <div className="section-title-row">
            <div>
              <span className="eyebrow">直连基线</span>
              <h2 id="internet-title">国内互联网</h2>
            </div>
            <span
              className={`summary-status ${offline || !siteMap ? 'neutral' : directReachable >= 2 ? 'success' : 'danger'}`}
            >
              {siteMap ? `${directReachable} / 3 可达` : '尚无检测数据'}
            </span>
          </div>
          <div className="domestic-grid">
            {directTargets.map((target) => (
              <SiteCard
                key={target}
                target={target}
                result={siteMap?.[target]}
                offline={offline}
              />
            ))}
          </div>
        </section>

        <section aria-labelledby="proxy-title">
          <div className="section-title-row">
            <div>
              <span className="eyebrow">经 Clash 代理</span>
              <h2 id="proxy-title">站点访问质量</h2>
            </div>
            <span className="section-note">HTTP 总耗时，用于横向比较</span>
          </div>
          <div className="proxy-grid">
            {proxyTargets.map((target) => (
              <SiteCard
                key={target}
                target={target}
                result={siteMap?.[target]}
                offline={offline}
              />
            ))}
          </div>
        </section>

        <div className="lower-grid">
          <CandidatePanel
            diagnosis={candidates.data?.data.diagnosis}
            now={now}
            offline={offline}
            currentIp={
              status.data?.data.snapshot?.lock.locked
                ? status.data.data.snapshot.lock.ip
                : null
            }
            busy={taskBusy}
            onApply={(ip) => requestAction('apply', ip)}
          />
          <EventsPanel events={events.data?.data.items} />
        </div>
      </main>
      <SettingsDrawer
        open={settingsOpen}
        settings={settings.data?.data.settings}
        onClose={closeSettings}
        busy={taskBusy}
        saving={settingsMutation.isPending}
        saveError={
          settingsMutation.error
            ? formatApiError(settingsMutation.error)
            : autoSwitchMutation.error
              ? formatApiError(autoSwitchMutation.error)
              : null
        }
        onSave={(value) => settingsMutation.mutate(value)}
        snapshot={status.data?.data.snapshot}
        offline={offline}
        autoSaving={autoSwitchMutation.isPending}
        onAutoChange={(enabled) => {
          autoSwitchMutation.reset();
          if (!enabled) {
            autoSwitchMutation.mutate(false);
            return;
          }
          actionTriggerRef.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
          setConfirmation({ action: 'auto' });
        }}
      />
      <ConfirmDialog
        confirmation={confirmation}
        snapshot={status.data?.data.snapshot}
        diagnosis={candidates.data?.data.diagnosis}
        settings={settings.data?.data.settings}
        onCancel={closeConfirmation}
        onConfirm={confirmAction}
      />
    </div>
  );
}
