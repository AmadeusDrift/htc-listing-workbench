import test from 'node:test';
import assert from 'node:assert/strict';

test('credential labels and tones distinguish unavailable saved data from a new connection', async () => {
  const { credentialPresentation } = await import('../src/renderer/credential-status.ts').catch(() => ({ credentialPresentation: undefined }));
  assert.equal(typeof credentialPresentation, 'function', 'settings expose distinct credential labels and action guidance');
  assert.ok(credentialPresentation);
  const blank = credentialPresentation({ state: 'absent', storedConfigured: false, storedEnabled: false });
  const missing = credentialPresentation({ state: 'absent', storedConfigured: true, storedEnabled: true });
  const unreadable = credentialPresentation({ state: 'unreadable', storedConfigured: true, storedEnabled: true });
  const unavailable = credentialPresentation({ state: 'encryption-unavailable', storedConfigured: true, storedEnabled: true });
  const mismatch = credentialPresentation({ state: 'metadata-mismatch', storedConfigured: false, storedEnabled: false });
  const disabled = credentialPresentation({ state: 'configured-disabled', storedConfigured: true, storedEnabled: false });
  const ready = credentialPresentation({ state: 'ready', storedConfigured: true, storedEnabled: true });
  assert.equal(blank.label, '尚未配置'); assert.equal(blank.tone, 'neutral');
  assert.equal(missing.label, '凭据文件缺失'); assert.equal(missing.tone, 'danger');
  assert.equal(unreadable.label, '已保存但无法读取'); assert.equal(unreadable.tone, 'danger'); assert.match(unreadable.detail, /Windows.*重试/);
  assert.equal(unavailable.label, '系统加密暂不可用'); assert.equal(unavailable.tone, 'danger'); assert.match(unavailable.detail, /Windows.*重启/);
  assert.equal(mismatch.label, '配置记录不一致'); assert.equal(mismatch.tone, 'warning'); assert.match(mismatch.detail, /不会自动启用/);
  assert.equal(disabled.label, '已保存 · 未启用'); assert.equal(disabled.tone, 'neutral');
  assert.equal(ready.label, '已启用'); assert.equal(ready.tone, 'success');
});
