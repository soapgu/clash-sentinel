import type { DashboardStreamState } from '../model.js';

export function FeedbackBanners({
  initialLoading,
  offline,
  streamState,
  partialError,
  actionError,
}: {
  initialLoading: boolean;
  offline: boolean;
  streamState: DashboardStreamState;
  partialError: string | null;
  actionError: string | null;
}) {
  return (
    <>
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
      {partialError && !offline ? (
        <div className="banner warning" role="alert">
          <strong>部分数据读取失败</strong>
          <span>{partialError}</span>
        </div>
      ) : null}
      {actionError ? (
        <div className="banner warning" role="alert">
          <strong>操作未受理</strong>
          <span>{actionError}</span>
        </div>
      ) : null}
    </>
  );
}
