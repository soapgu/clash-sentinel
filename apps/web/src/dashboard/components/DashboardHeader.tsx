import type { RefObject } from 'react';
import { formatTime } from '../formatters.js';
import type { DashboardStreamState } from '../model.js';

function StreamStatus({
  state,
  offline,
}: {
  state: DashboardStreamState;
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

export function DashboardHeader({
  streamState,
  offline,
  lastSyncedAt,
  fetching,
  settingsButtonRef,
  onRefresh,
  onOpenSettings,
}: {
  streamState: DashboardStreamState;
  offline: boolean;
  lastSyncedAt: number | null;
  fetching: boolean;
  settingsButtonRef: RefObject<HTMLButtonElement | null>;
  onRefresh: () => void;
  onOpenSettings: () => void;
}) {
  return (
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
          onClick={onRefresh}
          disabled={fetching}
        >
          <span aria-hidden="true">↻</span> {fetching ? '刷新中' : '刷新状态'}
        </button>
        <button
          ref={settingsButtonRef}
          className="icon-button"
          aria-label="打开设置"
          onClick={onOpenSettings}
        >
          ⚙
        </button>
      </div>
    </header>
  );
}
