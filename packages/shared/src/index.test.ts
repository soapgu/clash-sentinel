import { expect, test } from 'vitest';
import {
  apiErrorCodeSchema,
  healthSnapshotSchema,
  ipv4Schema,
  settingsSchema,
  storedDiagnosisSchema,
  storedTaskSchema,
} from './index.js';

test('根入口继续转发公共、领域和 API Schema', () => {
  for (const schema of [
    ipv4Schema,
    healthSnapshotSchema,
    settingsSchema,
    storedDiagnosisSchema,
    storedTaskSchema,
    apiErrorCodeSchema,
  ]) {
    expect(schema).toBeDefined();
  }
});
