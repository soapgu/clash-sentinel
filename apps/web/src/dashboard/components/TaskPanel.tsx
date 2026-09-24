import type { StoredTask } from '@clash-sentinel/shared';
import {
  formatApiError,
  formatTime,
  taskNames,
  taskStatusLabels,
} from '../formatters.js';

export function TaskPanel({
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
  const authFailed =
    task?.type === 'health_check' &&
    task.result &&
    typeof task.result === 'object' &&
    'statusDetail' in task.result &&
    task.result.statusDetail === 'controller_auth_failed';
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
      {authFailed ? (
        <p role="alert" className="form-error">
          控制接口认证失败，请检查 Sentinel 密钥与 Clash Verge Rev 是否一致。
        </p>
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
