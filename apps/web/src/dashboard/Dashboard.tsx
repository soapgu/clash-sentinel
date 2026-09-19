import { useCallback, useRef, useState } from 'react';
import { CandidatePanel } from './components/CandidatePanel.js';
import { ConfirmDialog } from './components/ConfirmDialog.js';
import { DashboardHeader } from './components/DashboardHeader.js';
import { EntryCard } from './components/EntryCard.js';
import { EventsPanel } from './components/EventsPanel.js';
import { FeedbackBanners } from './components/FeedbackBanners.js';
import { MonitoringStrip } from './components/MonitoringStrip.js';
import { SettingsDrawer } from './components/SettingsDrawer.js';
import { SiteSection } from './components/SiteSection.js';
import { TaskPanel } from './components/TaskPanel.js';
import { useDashboardActions } from './hooks/useDashboardActions.js';
import { useDashboardData } from './hooks/useDashboardData.js';
import { useDashboardSettings } from './hooks/useDashboardSettings.js';
import { useDashboardStream } from './hooks/useDashboardStream.js';
import { useTrackedTask } from './hooks/useTrackedTask.js';
import { directTargets, proxyTargets } from './site-meta.js';

/** Clash Sentinel 状态与手动操作工作台。 */
export function Dashboard() {
  const data = useDashboardData();
  const streamState = useDashboardStream();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const closeSettingsAfterSave = useCallback(() => {
    setSettingsOpen(false);
    settingsButtonRef.current?.focus();
  }, []);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    settingsButtonRef.current?.focus();
  }, []);
  const settings = useDashboardSettings({
    settings: data.settings,
    profileUid: data.snapshot?.profile?.uid ?? null,
    onSaved: closeSettingsAfterSave,
  });
  const trackedTask = useTrackedTask({
    streamState,
    activeTaskId: data.activeTaskId,
  });
  const actions = useDashboardActions({
    busy: trackedTask.busy,
    onTaskCreated: trackedTask.track,
    onEnableAuto: settings.enableAutoSwitch,
  });
  const busy = trackedTask.busy || actions.submitting;

  return (
    <div className="app-shell">
      <DashboardHeader
        streamState={streamState}
        offline={data.offline}
        lastSyncedAt={data.lastSyncedAt}
        fetching={data.fetching}
        settingsButtonRef={settingsButtonRef}
        onRefresh={() => void data.refresh()}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="workspace">
        <MonitoringStrip
          monitoring={data.monitoring}
          settings={data.settings}
        />
        <FeedbackBanners
          initialLoading={data.initialLoading}
          offline={data.offline}
          streamState={streamState}
          partialError={data.partialError}
          actionError={actions.error}
        />
        <TaskPanel
          task={trackedTask.task}
          loading={trackedTask.loading}
          error={trackedTask.error}
          onClose={() => {
            trackedTask.dismiss();
            actions.clearError();
          }}
        />
        <EntryCard
          snapshot={data.snapshot}
          settings={data.settings}
          offline={data.offline}
          busy={busy}
          onAction={actions.request}
        />
        <SiteSection
          kind="direct"
          targets={directTargets}
          siteMap={data.siteMap}
          offline={data.offline}
          reachable={data.directReachable}
        />
        <SiteSection
          kind="proxy"
          targets={proxyTargets}
          siteMap={data.siteMap}
          offline={data.offline}
        />
        <div className="lower-grid">
          <CandidatePanel
            diagnosis={data.diagnosis}
            now={data.now}
            offline={data.offline}
            currentIp={
              data.snapshot?.lock.locked ? data.snapshot.lock.ip : null
            }
            busy={busy}
            onApply={(ip) => actions.request('apply', ip)}
          />
          <EventsPanel events={data.events} />
        </div>
      </main>
      <SettingsDrawer
        open={settingsOpen}
        settings={data.settings}
        onClose={() => {
          settings.resetError();
          closeSettings();
        }}
        busy={busy}
        saving={settings.saving}
        saveError={settings.error}
        onSave={settings.save}
        snapshot={data.snapshot}
        offline={data.offline}
        autoSaving={settings.autoSaving}
        onAutoChange={(enabled) => {
          settings.resetError();
          if (enabled) actions.requestEnableAuto();
          else settings.disableAutoSwitch();
        }}
      />
      <ConfirmDialog
        confirmation={actions.confirmation}
        snapshot={data.snapshot}
        diagnosis={data.diagnosis}
        settings={data.settings}
        onCancel={actions.cancel}
        onConfirm={actions.confirm}
      />
    </div>
  );
}
