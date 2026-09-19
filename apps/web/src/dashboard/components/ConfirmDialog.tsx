import { useEffect, useRef } from 'react';
import type {
  HealthSnapshot,
  Settings,
  StoredDiagnosis,
} from '@clash-sentinel/shared';
import type { Confirmation } from '../model.js';

export function ConfirmDialog({
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
        将为订阅“{diagnosis?.profile.name ?? snapshot?.profile?.name ?? '未知'}
        ”的入口域名 {diagnosis?.domain ?? '未识别'}，把当前 IP{' '}
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
