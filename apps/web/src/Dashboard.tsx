import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  EventRecord,
  HealthSnapshot,
  MonitoringSnapshot,
  Settings,
  SiteResult,
  SiteSnapshotView,
  SiteTarget,
  StoredDiagnosis,
} from '@clash-sentinel/shared';
import { ApiClientError } from './api.js';
import { isDiagnosisFresh } from './freshness.js';
import { dashboardQueries, refreshDashboard } from './queries.js';
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

function DisabledAction({
  children,
  className = 'button secondary',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      className={className}
      disabled
      title="将在 Step 11 操作功能完成后开放"
    >
      {children}
    </button>
  );
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
}: {
  snapshot: HealthSnapshot | null | undefined;
  settings?: Settings;
  offline: boolean;
}) {
  const profileName = snapshot?.profile?.name ?? '尚未识别订阅';
  const healthTone = offline ? 'neutral' : toneForHealth(snapshot?.status);
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
            <strong>{settings?.autoSwitchEnabled ? '已开启' : '已关闭'}</strong>
          </div>
          <div>
            <span>状态更新</span>
            <strong>{formatTime(snapshot?.updatedAt)}</strong>
          </div>
        </div>
      </div>
      <div className="entry-actions" aria-label="操作功能尚未开放">
        <DisabledAction className="button primary">立即检测</DisabledAction>
        <DisabledAction>重新诊断</DisabledAction>
        <DisabledAction className="button ghost">解除锁定</DisabledAction>
        <DisabledAction className="button ghost">回滚变更</DisabledAction>
        <small>操作功能将在 Step 11 开放</small>
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
}: {
  diagnosis: StoredDiagnosis | null | undefined;
  now: number;
  offline: boolean;
}) {
  const fresh = isDiagnosisFresh(diagnosis ?? null, now) && !offline;
  const expiresAt = diagnosis
    ? new Date(Date.parse(diagnosis.savedAt) + 30 * 60 * 1_000).toISOString()
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
          {diagnosis.candidates.map((candidate) => (
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
              <DisabledAction className="button compact">应用</DisabledAction>
            </article>
          ))}
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
}: {
  open: boolean;
  settings?: Settings;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose, open]);
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
            <span className="eyebrow">只读策略</span>
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
          <div className="settings-list">
            <Setting
              label="定时监测"
              value={settings.monitoringEnabled ? '已开启' : '已关闭'}
            />
            <Setting
              label="检测间隔"
              value={`${settings.checkIntervalMs / 1_000} 秒`}
            />
            <Setting
              label="站点请求超时"
              value={`${settings.requestTimeoutMs / 1_000} 秒`}
            />
            <Setting
              label="入口失败阈值"
              value={`${settings.entryFailureThreshold} 次`}
            />
            <Setting
              label="自动切换冷却"
              value={`${settings.autoSwitchCooldownMs / 60_000} 分钟`}
            />
            <Setting
              label="自动切换"
              value={settings.autoSwitchEnabled ? '已开启' : '已关闭'}
            />
            <Setting
              label="绑定订阅 UID"
              value={settings.autoSwitchProfileUid ?? '未绑定'}
            />
          </div>
        )}
        <div className="drawer-actions">
          <button className="button secondary" onClick={onClose}>
            关闭
          </button>
          <DisabledAction className="button primary">保存设置</DisabledAction>
        </div>
        <p className="readonly-note">
          当前步骤仅展示配置，编辑功能将在 Step 11 开放。
        </p>
      </aside>
    </>
  );
}

function Setting({ label, value }: { label: string; value: string }) {
  return (
    <div className="setting-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function errorSummary(errors: unknown[]) {
  const error = errors.find(Boolean);
  if (!(error instanceof ApiClientError)) return '部分数据读取失败，请重试。';
  const requestId = error.requestId ? ` · 请求 ID ${error.requestId}` : '';
  return `${error.message}${requestId}`;
}

/** Clash Sentinel 只读状态工作台。 */
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
  const [now, setNow] = useState(Date.now());
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const stream = useMemo(() => new DashboardStream(client), [client]);

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
        <EntryCard
          snapshot={status.data?.data.snapshot}
          settings={settings.data?.data.settings}
          offline={offline}
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
          />
          <EventsPanel events={events.data?.data.items} />
        </div>
      </main>
      <SettingsDrawer
        open={settingsOpen}
        settings={settings.data?.data.settings}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
