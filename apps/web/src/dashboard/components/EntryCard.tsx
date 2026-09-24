import type { HealthSnapshot, Settings } from '@clash-sentinel/shared';
import { formatTime, healthLabels, toneForHealth } from '../formatters.js';
import type { DashboardAction } from '../model.js';

export function EntryCard({
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
  onAction: (action: DashboardAction) => void;
}) {
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
            <h1 id="entry-title">
              {snapshot?.profile?.name ?? '尚未识别订阅'}
            </h1>
          </div>
          <span
            className={`status-pill ${offline ? 'neutral' : toneForHealth(snapshot?.status)}`}
          >
            ●{' '}
            {offline
              ? '数据可能过期'
              : snapshot
                ? healthLabels[snapshot.status]
                : '尚无健康数据'}
          </span>
        </div>
        {snapshot?.statusDetail === 'controller_auth_failed' ? (
          <p role="alert" className="form-error">
            控制接口认证失败，请检查 Sentinel 密钥与 Clash Verge Rev 是否一致。
          </p>
        ) : null}
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
