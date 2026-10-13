import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAutomaticTaskDate } from '../src/renderer/automatic-task-date.ts';

for (const value of ['2026-10-14T14:35:26+08:00', '2026-10-14T00:00:00+08:00', '2026-12-31T23:59:59+08:00', '2027-01-01T00:00:00+08:00', '2024-02-29T12:34:56Z', 'invalid date', '']) {
  test(`task date retains original locale/time/fallback: ${value || '(empty)'}`, () => {
    assert.equal(formatAutomaticTaskDate(value), new Date(value).toLocaleString('zh-CN', { hour12: false }));
  });
}
