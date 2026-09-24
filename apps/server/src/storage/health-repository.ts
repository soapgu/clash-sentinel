import type Database from 'better-sqlite3';
import {
  healthSnapshotSchema,
  type HealthSnapshot,
} from '@clash-sentinel/shared';
import { fromEpoch, toEpoch } from './value-codec.js';

type Row = Record<string, unknown>;

/** 读写当前综合健康快照。 */
export class HealthRepository {
  constructor(private readonly database: Database.Database) {}

  /**
   * 读取当前健康快照。
   *
   * @returns 已保存的快照，尚无检测结果时返回 null。
   */
  getHealthSnapshot(): HealthSnapshot | null {
    const row = this.database
      .prepare('SELECT * FROM health_snapshot WHERE singleton_id = 1')
      .get() as Row | undefined;
    if (!row) return null;
    return healthSnapshotSchema.parse({
      status: row.status,
      statusDetail: row.status_detail ?? null,
      profile: row.profile_uid
        ? { uid: row.profile_uid, name: row.profile_name ?? '' }
        : null,
      lock: row.locked
        ? { locked: true, domain: row.entry_domain, ip: row.current_ip }
        : { locked: false },
      internetSuccess: row.internet_success,
      internetTotal: row.internet_total,
      consecutiveFailures: row.consecutive_failures,
      recommendedIp: row.recommended_ip,
      autoSwitchCooldownUntil:
        row.auto_switch_cooldown_until === null
          ? null
          : fromEpoch(Number(row.auto_switch_cooldown_until)),
      updatedAt: fromEpoch(Number(row.updated_at)),
    });
  }

  /**
   * 插入或替换当前健康快照。
   *
   * @param snapshot 完整健康快照。
   * @returns 持久化后重新读取的快照。
   */
  upsertHealthSnapshot(snapshot: HealthSnapshot): HealthSnapshot {
    const value = healthSnapshotSchema.parse(snapshot);
    this.database
      .prepare(
        `
        INSERT INTO health_snapshot (
          singleton_id, status, profile_uid, profile_name, locked, entry_domain, current_ip,
          internet_success, internet_total, consecutive_failures, recommended_ip,
          auto_switch_cooldown_until, updated_at, status_detail
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton_id) DO UPDATE SET
          status = excluded.status, profile_uid = excluded.profile_uid,
          profile_name = excluded.profile_name, locked = excluded.locked,
          entry_domain = excluded.entry_domain, current_ip = excluded.current_ip,
          internet_success = excluded.internet_success, internet_total = excluded.internet_total,
          consecutive_failures = excluded.consecutive_failures,
          recommended_ip = excluded.recommended_ip,
          auto_switch_cooldown_until = excluded.auto_switch_cooldown_until,
          updated_at = excluded.updated_at, status_detail = excluded.status_detail
      `,
      )
      .run(
        value.status,
        value.profile?.uid ?? null,
        value.profile?.name ?? null,
        Number(value.lock.locked),
        value.lock.locked ? value.lock.domain : null,
        value.lock.locked ? value.lock.ip : null,
        value.internetSuccess,
        value.internetTotal,
        value.consecutiveFailures,
        value.recommendedIp,
        value.autoSwitchCooldownUntil
          ? toEpoch(value.autoSwitchCooldownUntil)
          : null,
        toEpoch(value.updatedAt),
        value.statusDetail ?? null,
      );
    return this.getHealthSnapshot()!;
  }
}
