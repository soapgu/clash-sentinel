/* global document, Option, clearTimeout, setTimeout */

(function () {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const scenarioSelect = $('#scenarioSelect');
  const taskPanel = $('#taskPanel');
  const defaultTaskId = '11111111-1111-4111-8111-111111111111';
  let activeDialog = null;
  let taskTimer = null;

  const baseSites = {
    baidu: { name: '百度', logo: 'assets/baidu-official.png', reachable: true, httpStatus: 200, durationMs: 86, checkedAt: '2026-09-09T02:26:12.000Z', stale: false },
    taobao: { name: '淘宝', logo: 'assets/taobao-official.png', reachable: true, httpStatus: 200, durationMs: 112, checkedAt: '2026-09-09T02:26:13.000Z', stale: false },
    tencent: { name: '腾讯', logo: 'assets/tencent-official.png', reachable: true, httpStatus: 302, durationMs: 94, checkedAt: '2026-09-09T02:26:13.000Z', stale: false },
    google: { name: 'Google', host: 'www.google.com', logo: 'assets/google.svg', reachable: true, httpStatus: 204, durationMs: 328, checkedAt: '2026-09-09T02:26:14.000Z', stale: false },
    github: { name: 'GitHub', host: 'github.com', logo: 'assets/github.svg', reachable: true, httpStatus: 200, durationMs: 462, checkedAt: '2026-09-09T02:26:14.000Z', stale: false },
    openai_status: { name: 'OpenAI', host: 'status.openai.com', logo: 'assets/openai.svg', reachable: true, httpStatus: 200, durationMs: 389, checkedAt: '2026-09-09T02:26:15.000Z', stale: false, serviceStatus: 'operational', incidentSummary: null },
  };

  const baseCandidates = [
    { ip: '192.0.2.42', eligible: true, success: 9, total: 9, successRate: 100, averageMs: 43, failedPorts: [], sources: ['DNS'], current: true },
    { ip: '198.51.100.18', eligible: true, success: 9, total: 9, successRate: 100, averageMs: 37, failedPorts: [], sources: ['DNS', '历史'], recommended: true },
    { ip: '203.0.113.27', eligible: false, success: 6, total: 9, successRate: 66.7, averageMs: 91, failedPorts: [443], sources: ['DNS'] },
  ];

  const baseEvents = [
    { severity: 'info', summary: '定时健康检测完成', detail: '入口正常，六个站点结果已更新', time: '10:26' },
    { severity: 'info', summary: '严格诊断完成', detail: '发现 2 个合格候选，推荐 198.51.100.18', time: '10:20' },
    { severity: 'warning', summary: 'GitHub 曾出现请求超时', detail: '单站异常未影响入口健康判断', time: '10:12' },
  ];

  const scenarios = {
    healthy: { label: '健康且已锁定', status: 'healthy' },
    scheduled_running: { label: '定时监测 · 检测中', status: 'healthy', monitorState: 'running' },
    monitoring_disabled: { label: '定时监测 · 已暂停', status: 'healthy', monitorState: 'disabled' },
    unlocked: { label: '首次使用 · 未锁定', status: 'unknown', locked: false, candidates: [] },
    no_diagnosis: { label: '尚无诊断报告', status: 'healthy', candidates: [] },
    loading: { label: '正在读取状态', status: 'healthy', loading: true },
    stale: { label: '数据已过期', status: 'healthy', stale: true },
    uncertain: { label: '互联网状态不确定', status: 'internet_uncertain', domesticFailures: 2 },
    offline: { label: '本机互联网不可达', status: 'internet_down', domesticFailures: 3 },
    entry_suspected: { label: '入口疑似异常', status: 'entry_suspected', failures: 2 },
    entry_down: { label: '入口故障', status: 'entry_down', failures: 3 },
    proxy_error: { label: 'Clash 代理异常', status: 'proxy_error', proxyFailures: 3 },
    clash_down: { label: 'Clash 未启动', status: 'unknown', clashDown: true, proxyFailures: 3 },
    backend_down: { label: '后台不可达', status: 'unknown', backendDown: true, stale: true },
    profile_changed: { label: '订阅已变化', status: 'unknown', profileChanged: true, candidates: [] },
    report_expired: { label: '诊断报告已过期', status: 'healthy', reportExpired: true },
    task_running: { label: '操作执行中', status: 'healthy', task: 'running' },
    task_succeeded: { label: '操作成功', status: 'healthy', task: 'succeeded' },
    recovered: { label: '操作失败 · 已恢复', status: 'healthy', task: 'recovered' },
    recovery_failed: { label: '恢复失败 · 需人工处理', status: 'unknown', task: 'recovery_failed' },
  };

  const clone = (value) => JSON.parse(JSON.stringify(value));

  function getView(scenario) {
    const view = {
      profile: { uid: 'demo-profile-a', name: '演示订阅 A' },
      lock: { locked: true, domain: 'entry.example.com', ip: '192.0.2.42' },
      status: scenario.status,
      internetSuccess: 3,
      internetTotal: 3,
      consecutiveFailures: scenario.failures || 0,
      recommendedIp: '198.51.100.18',
      autoSwitchCooldownUntil: null,
      updatedAt: '2026-09-09T02:26:18.000Z',
      monitoring: {
        enabled: true,
        state: scenario.monitorState || 'waiting',
        lastCompletedAt: '10:26:18',
        nextRunAt: '10:27:18',
        startedAt: '10:27:02',
        phase: '正在探测六个固定站点',
      },
      sites: clone(baseSites),
      candidates: scenario.candidates === undefined ? clone(baseCandidates) : clone(scenario.candidates),
      events: clone(baseEvents),
      ...scenario,
    };
    if (scenario.locked === false) view.lock = { locked: false };
    if (scenario.domesticFailures) {
      ['tencent', 'taobao', 'baidu'].slice(0, scenario.domesticFailures).forEach((key) => {
        view.sites[key] = { ...view.sites[key], reachable: false, httpStatus: null, durationMs: null, errorType: 'timeout' };
      });
      view.internetSuccess = 3 - scenario.domesticFailures;
    }
    if (scenario.proxyFailures) {
      ['google', 'github', 'openai_status'].slice(0, scenario.proxyFailures).forEach((key) => {
        view.sites[key] = { ...view.sites[key], reachable: false, httpStatus: null, durationMs: null, errorType: 'proxy', serviceStatus: key === 'openai_status' ? null : undefined, incidentSummary: key === 'openai_status' ? null : undefined };
      });
    }
    if (scenario.stale) Object.values(view.sites).forEach((site) => { site.stale = true; });
    if (scenario.profileChanged) {
      view.profile = { uid: 'demo-profile-b', name: '演示订阅 B' };
      view.lock = { locked: false };
      view.events.unshift({ severity: 'warning', summary: '检测到订阅变化', detail: '原诊断已失效，自动切换保持关闭', time: '刚刚' });
    }
    return view;
  }

  function statusMeta(status, clashDown) {
    if (clashDown) return ['Clash 不可用', 'neutral'];
    return {
      healthy: ['入口正常', 'success'],
      internet_uncertain: ['互联网不确定', 'warning'],
      internet_down: ['互联网不可达', 'danger'],
      entry_suspected: ['入口疑似异常', 'warning'],
      entry_down: ['入口故障', 'danger'],
      proxy_error: ['代理异常', 'danger'],
      unknown: ['入口未知', 'neutral'],
    }[status];
  }

  function renderSites(view) {
    $('#domesticSites').innerHTML = ['baidu', 'taobao', 'tencent'].map((key) => {
      const site = view.sites[key];
      const tone = site.stale ? 'neutral' : site.reachable ? 'success' : 'danger';
      return `<article class="mini-site"><div class="site-identity"><img class="site-logo ${key === 'baidu' ? 'wide' : ''}" src="${site.logo}" alt="" /><div class="site-name"><i class="site-dot ${tone}"></i>${site.name}</div></div><div class="mini-site-meta"><strong>${site.reachable ? `HTTP ${site.httpStatus} · ${site.durationMs} ms` : '请求超时'}</strong><span>${site.stale ? '已过期 · ' : ''}10:26:13</span></div></article>`;
    }).join('');

    $('#proxySites').innerHTML = ['google', 'github', 'openai_status'].map((key) => {
      const site = view.sites[key];
      const tone = site.stale ? 'neutral' : site.reachable ? 'success' : 'danger';
      const label = site.stale ? '已过期' : site.reachable ? '可达' : site.errorType === 'proxy' ? '代理连接失败' : '不可达';
      const official = key === 'openai_status' ? `<div class="official-status">官方服务：<strong>${site.serviceStatus === 'operational' ? '正常运行' : site.serviceStatus ? '状态未知' : '暂不可用'}</strong>${site.incidentSummary ? ` · ${site.incidentSummary}` : ' · 无活动事故'}</div>` : '';
      return `<article class="proxy-card"><div class="proxy-header"><div class="proxy-title"><img class="site-logo" src="${site.logo}" alt="" /><div><strong>${site.name}</strong><span>${site.host}</span></div></div><span class="status-pill ${tone}">${label}</span></div><div class="proxy-metrics"><div class="metric"><span>HTTP 状态</span><strong>${site.httpStatus ?? '—'}</strong></div><div class="metric"><span>总耗时</span><strong>${site.durationMs === null ? '—' : `${site.durationMs} ms`}</strong></div></div>${official}<div class="proxy-footer"><span>${site.stale ? '数据已过期' : '最近检测'}</span><span>10:26:14</span></div></article>`;
    }).join('');
  }

  function renderMonitor(view) {
    const monitor = view.monitoring;
    const isRunning = monitor.state === 'running';
    const isDisabled = monitor.state === 'disabled';
    $('#monitorBadge').textContent = isDisabled ? '● 已暂停' : isRunning ? '● 检测中' : '● 已开启';
    $('#monitorBadge').className = `status-pill ${isDisabled ? 'neutral' : isRunning ? 'info' : 'success'}`;
    $('#monitorState').textContent = isDisabled ? '定时监测已暂停' : isRunning ? '正在执行定时检测' : '等待下一轮';
    $('#monitorPhase').textContent = isDisabled ? '不会自动发起新的健康检测' : isRunning ? monitor.phase : '每 60 秒检测一次';
    $('#monitorLastTime').textContent = monitor.lastCompletedAt;
    $('#monitorNextLabel').textContent = isRunning ? '本轮开始' : '预计下次';
    $('#monitorNextTime').textContent = isRunning ? monitor.startedAt : monitor.nextRunAt;
    $('#monitorNext').classList.toggle('muted-time', isDisabled);
    if (isDisabled) {
      $('#monitorNextLabel').textContent = '预计下次';
      $('#monitorNextTime').textContent = '—';
    }
    $('#monitoringInput').checked = !isDisabled;
  }

  function renderCandidates(view) {
    const container = $('#candidateList');
    if (!view.candidates.length) {
      const changed = view.profileChanged;
      container.innerHTML = `<div class="empty-state"><strong>${changed ? '订阅已变化，原报告失效' : '尚无可用候选'}</strong>${changed ? '请为当前订阅重新诊断' : '运行严格诊断后，将在这里显示测试结果'}</div>`;
      $('#reportFreshness').className = 'status-pill neutral';
      $('#reportFreshness').textContent = '无有效报告';
      return;
    }
    $('#reportFreshness').className = `status-pill ${view.reportExpired ? 'danger' : 'success'}`;
    $('#reportFreshness').textContent = view.reportExpired ? '已于 10:10 过期' : '有效至 10:50';
    container.innerHTML = view.candidates.map((item) => `<article class="candidate-row ${item.current ? 'current' : item.recommended ? 'recommended' : ''}"><div class="candidate-primary"><strong>${item.ip}</strong><span class="candidate-label">${item.current ? '● 当前使用' : item.recommended ? '★ 推荐候选' : item.eligible ? '合格候选' : '未通过'}</span></div><div class="candidate-metric"><span>成功率</span><strong>${item.successRate}%</strong></div><div class="candidate-metric"><span>平均 TCP</span><strong>${item.averageMs} ms</strong></div><div class="candidate-metric"><span>检测</span><strong>${item.success} / ${item.total}</strong></div><button class="button ${item.recommended ? 'primary' : 'secondary'} apply-button" data-ip="${item.ip}" ${item.current || !item.eligible || view.reportExpired ? 'disabled' : ''}>${item.current ? '当前使用' : '应用'}</button></article>`).join('');
    container.querySelectorAll('[data-ip]').forEach((button) => button.addEventListener('click', () => openDialog('apply', button.dataset.ip)));
  }

  function renderEvents(view) {
    $('#eventList').innerHTML = view.events.map((event) => `<li class="event-item"><i class="event-marker ${event.severity === 'warning' ? 'warning' : event.severity === 'error' || event.severity === 'critical' ? 'danger' : ''}"></i><div><strong>${event.summary}</strong><p>${event.detail}</p></div><time>${event.time}</time></li>`).join('');
  }

  function renderTask(task) {
    taskPanel.className = 'task-panel panel';
    const map = {
      running: ['↻', '正在应用候选 IP', '正在备份配置并准备重载…', '运行中', 'info', ''],
      succeeded: ['✓', '应用候选 IP 成功', '配置已重载，并通过独立冒烟验证。', '已完成', 'success', 'done'],
      recovered: ['!', '应用失败，已恢复', '新配置验证失败；原配置已恢复并重新加载。', '失败已恢复', 'warning', 'failed'],
      recovery_failed: ['!', '恢复失败，需人工处理', '恢复后的重载失败，自动配置修改已停止。', '需人工处理', 'danger', 'failed'],
    };
    const [icon, title, detail, status, tone, className] = map[task];
    taskPanel.classList.add(className);
    $('#taskTitle').textContent = title;
    $('#taskDetail').textContent = detail;
    $('#taskStatus').textContent = status;
    $('#taskStatus').className = `status-pill ${tone}`;
    $('.task-icon').textContent = icon;
    $('#taskId').textContent = `任务 ${defaultTaskId} · 开始于 10:26:20`;
  }

  function render() {
    clearTimeout(taskTimer);
    const view = getView(scenarios[scenarioSelect.value]);
    $('#entryTitle').textContent = view.profile.name;
    $('#entryDomain').textContent = view.lock.locked ? view.lock.domain : '未锁定';
    $('#entryIp').textContent = view.lock.locked ? view.lock.ip : '—';
    $('#failureCount').textContent = `${view.consecutiveFailures} / 3`;
    $('#autoSwitchState').textContent = '已关闭';
    const [statusLabel, statusTone] = statusMeta(view.status, view.clashDown);
    $('#entryStatus').textContent = `● ${view.lock.locked ? statusLabel : '未锁定'}`;
    $('#entryStatus').className = `status-pill ${view.lock.locked ? statusTone : 'neutral'}`;
    const internetTone = view.internetSuccess >= 2 ? 'success' : view.internetSuccess === 1 ? 'warning' : 'danger';
    $('#internetSummary').className = `summary-status ${internetTone}`;
    $('#internetSummary').textContent = `${view.internetSuccess} / 3 可达 · ${view.internetSuccess >= 2 ? '互联网正常' : view.internetSuccess === 1 ? '状态不确定' : '互联网不可达'}`;
    $('#connectionBanner').classList.toggle('hidden', !view.backendDown && view.task !== 'recovery_failed');
    $('#connectionBanner').textContent = view.backendDown ? '无法连接后台。以下内容为上次保存的历史快照，配置操作已禁用。' : view.task === 'recovery_failed' ? '需人工处理：恢复后的配置重载失败，自动修改已停止。请查看最近事件并检查 Clash。' : '';
    $('.connection').innerHTML = view.backendDown ? '<i style="background:#c43131"></i>后台不可达' : '<i></i>后台已连接';
    renderMonitor(view);
    renderSites(view);
    renderCandidates(view);
    renderEvents(view);
    taskPanel.classList.toggle('hidden', !view.task);
    if (view.task) renderTask(view.task);
    ['healthButton', 'diagnoseButton', 'moreButton'].forEach((id) => { $(`#${id}`).disabled = Boolean(view.task === 'running' || view.backendDown); });
    if (view.loading) document.querySelectorAll('.entry-details strong, .metric strong, .mini-site-meta strong').forEach((node) => node.classList.add('skeleton'));
  }

  const dialogContent = {
    apply: (ip) => ({ eyebrow: '应用候选 IP', title: '将入口切换到新 IP？', description: '后台会重新校验报告和订阅，随后备份配置、应用、重载并独立验证。', facts: [['当前订阅', '演示订阅 A'], ['入口域名', 'entry.example.com'], ['当前值', '192.0.2.42'], ['目标值', ip]], warning: '操作可能造成短暂断连；验证失败时会尝试恢复原配置。', confirm: '应用此 IP' }),
    reset: () => ({ eyebrow: '解除锁定', title: '解除当前入口锁定？', description: '入口将恢复使用原始域名，独立站点监测仍会继续。', facts: [['当前订阅', '演示订阅 A'], ['锁定入口', '192.0.2.42'], ['恢复为', 'entry.example.com']], warning: '解除后将同时关闭当前订阅的自动切换。', confirm: '解除当前锁定' }),
    rollback: () => ({ eyebrow: '回滚最近变更', title: '回滚到上一次安全配置？', description: '后台会确认订阅和文件上下文仍与最近变更匹配。', facts: [['当前订阅', '演示订阅 A'], ['最近变更', '10:05 · 应用入口 IP'], ['当前值', '192.0.2.42'], ['恢复为', 'entry.example.com']], warning: '如果配置已被外部修改，后台会拒绝覆盖。', confirm: '回滚最近变更' }),
    auto: () => ({ eyebrow: '自动切换', title: '启用自动入口切换？', description: '仅在互联网正常、入口连续失败并存在合格候选时自动处理。', facts: [['绑定订阅', '演示订阅 A'], ['当前入口', '192.0.2.42'], ['失败阈值', '连续 3 次'], ['冷却时间', '5 分钟']], warning: '自动操作同样执行备份、重载、验证和失败恢复。', confirm: '启用自动切换' }),
  };

  function openDialog(type, value) {
    activeDialog = type;
    const content = dialogContent[type](value);
    $('#dialogEyebrow').textContent = content.eyebrow;
    $('#dialogTitle').textContent = content.title;
    $('#dialogDescription').textContent = content.description;
    $('#dialogFacts').innerHTML = content.facts.map(([term, definition]) => `<div><dt>${term}</dt><dd>${definition}</dd></div>`).join('');
    $('#dialogWarning').textContent = content.warning;
    $('#dialogConfirm').textContent = content.confirm;
    $('#confirmDialog').showModal();
  }

  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), 2200);
  }

  function startTask(title, detail, outcome = 'succeeded') {
    taskPanel.className = 'task-panel panel';
    $('.task-icon').textContent = '↻';
    $('#taskTitle').textContent = title;
    $('#taskDetail').textContent = detail;
    $('#taskStatus').textContent = '运行中';
    $('#taskStatus').className = 'status-pill info';
    $('#taskId').textContent = `任务 ${defaultTaskId} · 刚刚开始`;
    ['healthButton', 'diagnoseButton', 'moreButton'].forEach((id) => { $(`#${id}`).disabled = true; });
    clearTimeout(taskTimer);
    taskTimer = setTimeout(() => {
      renderTask(outcome);
      ['healthButton', 'diagnoseButton', 'moreButton'].forEach((id) => { $(`#${id}`).disabled = false; });
      showToast(outcome === 'succeeded' ? '操作已完成' : '操作失败，原配置已恢复');
    }, 1100);
  }

  Object.entries(scenarios).forEach(([value, scenario]) => scenarioSelect.add(new Option(scenario.label, value)));
  scenarioSelect.value = 'healthy';
  scenarioSelect.addEventListener('change', render);
  $('#refreshButton').addEventListener('click', () => { showToast('已读取最新保存状态，不会发起检测'); render(); });
  $('#healthButton').addEventListener('click', () => startTask('正在执行健康检测', '正在并行探测六个固定站点…'));
  $('#diagnoseButton').addEventListener('click', () => startTask('正在严格诊断候选 IP', '正在发现候选并执行多轮端口测试…'));
  $('#moreButton').addEventListener('click', () => { $('#actionMenu').classList.toggle('hidden'); $('#moreButton').setAttribute('aria-expanded', String(!$('#actionMenu').classList.contains('hidden'))); });
  $('#actionMenu').addEventListener('click', (event) => { const type = event.target.dataset.dialog; if (type) { $('#actionMenu').classList.add('hidden'); openDialog(type); } });
  $('#dialogCancel').addEventListener('click', () => { activeDialog = null; });
  $('#dialogConfirm').addEventListener('click', (event) => { event.preventDefault(); const operation = activeDialog; $('#confirmDialog').close(); if (operation === 'auto') { $('#autoSwitchInput').checked = true; showToast('自动切换已启用'); } else { startTask(operation === 'reset' ? '正在解除入口锁定' : operation === 'rollback' ? '正在回滚最近变更' : '正在应用候选 IP', '正在校验、备份、重载并执行独立验证…'); } activeDialog = null; });

  function setDrawer(open) {
    $('#settingsDrawer').classList.toggle('open', open);
    $('#settingsDrawer').setAttribute('aria-hidden', String(!open));
    $('#drawerBackdrop').classList.toggle('hidden', !open);
  }
  $('#settingsButton').addEventListener('click', () => setDrawer(true));
  $('#monitorSettingsButton').addEventListener('click', () => setDrawer(true));
  $('#closeSettings').addEventListener('click', () => setDrawer(false));
  $('#cancelSettings').addEventListener('click', () => setDrawer(false));
  $('#drawerBackdrop').addEventListener('click', () => setDrawer(false));
  $('#autoSwitchInput').addEventListener('change', (event) => { if (event.target.checked) { event.target.checked = false; openDialog('auto'); } });
  $('#settingsForm').addEventListener('submit', (event) => { event.preventDefault(); setDrawer(false); showToast('设置已保存'); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { $('#actionMenu').classList.add('hidden'); setDrawer(false); } });
  render();
})();
