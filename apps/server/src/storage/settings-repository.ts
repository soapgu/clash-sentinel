import type Database from 'better-sqlite3';
import {
  settingsDefaults,
  settingsSchema,
  type Settings,
} from '@clash-sentinel/shared';
import { fromEpoch, toEpoch } from './value-codec.js';

type Row = Record<string, unknown>;

/** 读写单例用户策略。 */
export class SettingsRepository {
  constructor(private readonly database: Database.Database) {
    this.ensureDefaultSettings();
  }

  /**
   * 读取当前用户策略。
   *
   * @returns 始终存在且通过共享 Schema 校验的策略。
   */
  getSettings(): Settings {
    const row = this.database
      .prepare('SELECT * FROM settings WHERE singleton_id = 1')
      .get() as Row;
    return settingsSchema.parse({
      checkIntervalMs: row.check_interval_ms,
      requestTimeoutMs: row.request_timeout_ms,
      entryFailureThreshold: row.entry_failure_threshold,
      autoSwitchCooldownMs: row.auto_switch_cooldown_ms,
      monitoringEnabled: Boolean(row.monitoring_enabled),
      autoSwitchEnabled: Boolean(row.auto_switch_enabled),
      autoSwitchProfileUid: row.auto_switch_profile_uid,
      updatedAt: fromEpoch(Number(row.updated_at)),
    });
  }

  /**
   * 合并并保存部分策略更新。
   *
   * @param patch 需要修改的策略字段。
   * @returns 更新后的完整策略。
   */
  updateSettings(patch: Partial<Omit<Settings, 'updatedAt'>>): Settings {
    const value = settingsSchema.parse({
      ...this.getSettings(),
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    this.database
      .prepare(
        `
        UPDATE settings SET
          check_interval_ms = ?, request_timeout_ms = ?, entry_failure_threshold = ?,
          auto_switch_cooldown_ms = ?, monitoring_enabled = ?, auto_switch_enabled = ?,
          auto_switch_profile_uid = ?, updated_at = ?
        WHERE singleton_id = 1
      `,
      )
      .run(
        value.checkIntervalMs,
        value.requestTimeoutMs,
        value.entryFailureThreshold,
        value.autoSwitchCooldownMs,
        Number(value.monitoringEnabled),
        Number(value.autoSwitchEnabled),
        value.autoSwitchProfileUid,
        toEpoch(value.updatedAt),
      );
    return this.getSettings();
  }

  /** 在首次迁移后插入缺失的单例默认策略。 */
  private ensureDefaultSettings() {
    this.database
      .prepare(
        `
        INSERT OR IGNORE INTO settings (
          singleton_id, check_interval_ms, request_timeout_ms, entry_failure_threshold,
          auto_switch_cooldown_ms, monitoring_enabled, auto_switch_enabled,
          auto_switch_profile_uid, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        settingsDefaults.checkIntervalMs,
        settingsDefaults.requestTimeoutMs,
        settingsDefaults.entryFailureThreshold,
        settingsDefaults.autoSwitchCooldownMs,
        Number(settingsDefaults.monitoringEnabled),
        Number(settingsDefaults.autoSwitchEnabled),
        settingsDefaults.autoSwitchProfileUid,
        Date.now(),
      );
  }
}
