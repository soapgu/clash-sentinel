import type { SiteSnapshotView, SiteTarget } from '@clash-sentinel/shared';
import { SiteCard } from './SiteCard.js';

export function SiteSection({
  kind,
  targets,
  siteMap,
  offline,
  reachable,
}: {
  kind: 'direct' | 'proxy';
  targets: readonly SiteTarget[];
  siteMap: Partial<Record<SiteTarget, SiteSnapshotView | null>> | undefined;
  offline: boolean;
  reachable?: number;
}) {
  const direct = kind === 'direct';
  return (
    <section aria-labelledby={direct ? 'internet-title' : 'proxy-title'}>
      <div className="section-title-row">
        <div>
          <span className="eyebrow">
            {direct ? '直连基线' : '经 Clash 代理'}
          </span>
          <h2 id={direct ? 'internet-title' : 'proxy-title'}>
            {direct ? '国内互联网' : '站点访问质量'}
          </h2>
        </div>
        {direct ? (
          <span
            className={`summary-status ${offline || !siteMap ? 'neutral' : (reachable ?? 0) >= 2 ? 'success' : 'danger'}`}
          >
            {siteMap ? `${reachable ?? 0} / 3 可达` : '尚无检测数据'}
          </span>
        ) : (
          <span className="section-note">HTTP 总耗时，用于横向比较</span>
        )}
      </div>
      <div className={direct ? 'domestic-grid' : 'proxy-grid'}>
        {targets.map((target) => (
          <SiteCard
            key={target}
            target={target}
            result={siteMap?.[target]}
            offline={offline}
          />
        ))}
      </div>
    </section>
  );
}
