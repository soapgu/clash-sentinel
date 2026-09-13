import type Database from 'better-sqlite3';
import {
  siteResultSchema,
  siteTargetSchema,
  type SiteResult,
  type SiteTarget,
} from '@clash-sentinel/shared';
import { fromEpoch, toEpoch } from './value-codec.js';

type Row = Record<string, unknown>;

/** 每个站点保留的历史结果数量。 */
export const SITE_HISTORY_LIMIT = 1_000;

/** 读写站点快照及其历史。 */
export class SiteRepository {
  constructor(private readonly database: Database.Database) {}

  /**
   * 读取指定站点的当前快照。
   *
   * @param target 固定站点标识。
   * @returns 最近结果，尚无记录时返回 null。
   */
  getSiteSnapshot(target: SiteTarget): SiteResult | null {
    const validTarget = siteTargetSchema.parse(target);
    const row = this.database
      .prepare('SELECT * FROM site_snapshots WHERE target = ?')
      .get(validTarget) as Row | undefined;
    return row ? this.mapSite(row) : null;
  }

  /**
   * 只更新指定站点的当前快照，不追加历史。
   *
   * @param result 站点探测结果。
   * @returns 持久化后的站点快照。
   */
  upsertSiteSnapshot(result: SiteResult): SiteResult {
    const value = siteResultSchema.parse(result);
    this.writeSiteSnapshot(value);
    return this.getSiteSnapshot(value.target)!;
  }

  /**
   * 在同一事务中更新站点快照、追加历史并执行数量清理。
   *
   * @param result 站点探测结果。
   * @returns 新增历史记录 ID。
   */
  appendSiteResult(result: SiteResult): number {
    const value = siteResultSchema.parse(result);
    return this.database.transaction(() => {
      this.writeSiteSnapshot(value);
      const info = this.database
        .prepare(
          `
          INSERT INTO site_history (
            target, reachable, http_status, duration_ms, error_type, checked_at,
            service_status, incident_summary
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(...this.siteParameters(value));
      this.pruneSite(value.target);
      return Number(info.lastInsertRowid);
    })();
  }

  /**
   * 按时间倒序读取指定站点历史。
   *
   * @param target 固定站点标识。
   * @param limit 返回数量，最大 200。
   * @param offset 跳过的历史数量。
   * @returns 站点历史结果列表。
   */
  listSiteHistory(target: SiteTarget, limit = 100, offset = 0): SiteResult[] {
    const validTarget = siteTargetSchema.parse(target);
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
    const safeOffset = Math.max(Math.trunc(offset), 0);
    return (
      this.database
        .prepare(
          'SELECT * FROM site_history WHERE target = ? ORDER BY checked_at DESC, id DESC LIMIT ? OFFSET ?',
        )
        .all(validTarget, safeLimit, safeOffset) as Row[]
    ).map((row) => this.mapSite(row));
  }

  /** 对全部站点历史执行显式数量清理。 */
  pruneHistory() {
    this.database.transaction(() => {
      for (const target of siteTargetSchema.options) this.pruneSite(target);
    })();
  }

  /** 将站点结果写入单例快照表。 */
  private writeSiteSnapshot(value: SiteResult) {
    this.database
      .prepare(
        `
        INSERT INTO site_snapshots (
          target, reachable, http_status, duration_ms, error_type, checked_at,
          service_status, incident_summary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(target) DO UPDATE SET
          reachable = excluded.reachable, http_status = excluded.http_status,
          duration_ms = excluded.duration_ms, error_type = excluded.error_type,
          checked_at = excluded.checked_at, service_status = excluded.service_status,
          incident_summary = excluded.incident_summary
      `,
      )
      .run(...this.siteParameters(value));
  }

  /** 将站点领域对象转换为 SQL 参数数组。 */
  private siteParameters(value: SiteResult) {
    return [
      value.target,
      Number(value.reachable),
      value.httpStatus,
      value.durationMs,
      value.errorType,
      toEpoch(value.checkedAt),
      value.serviceStatus,
      value.incidentSummary,
    ] as const;
  }

  /** 将站点查询行转换为共享领域对象。 */
  private mapSite(row: Row): SiteResult {
    return siteResultSchema.parse({
      target: row.target,
      reachable: Boolean(row.reachable),
      httpStatus: row.http_status,
      durationMs: row.duration_ms,
      errorType: row.error_type,
      checkedAt: fromEpoch(Number(row.checked_at)),
      serviceStatus: row.service_status,
      incidentSummary: row.incident_summary,
    });
  }

  /** 删除指定站点最近 1000 条之外的旧历史。 */
  private pruneSite(target: SiteTarget) {
    this.database
      .prepare(
        `
        DELETE FROM site_history WHERE target = ? AND id NOT IN (
          SELECT id FROM site_history WHERE target = ?
          ORDER BY checked_at DESC, id DESC LIMIT ?
        )
      `,
      )
      .run(target, target, SITE_HISTORY_LIMIT);
  }
}
