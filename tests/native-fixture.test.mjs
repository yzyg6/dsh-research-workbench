import test from 'node:test';
import assert from 'node:assert/strict';
import { seedNativeDraft } from '../src/client/native-fixture.mjs';
test('native fixture never reseeds in restore mode, overwrites prose or submits', () => {
  const calls = [];
  const base = { mode: 'seed', marker: 'RW-A-WRITE-20261109', draft: '', phase: 'plain', workspaceMember: true, applied: false, actions: { setDraft: (text) => calls.push(text), persistDraft: () => calls.push('persist'), submit: () => { throw Error('must never submit'); } } };
  assert.equal(seedNativeDraft({ ...base, mode: 'restore' }), 'inactive');
  assert.equal(seedNativeDraft({ ...base, draft: 'existing author input' }), 'preserved');
  assert.equal(seedNativeDraft({ ...base, workspaceMember: false }), 'inactive');
  assert.equal(seedNativeDraft({ ...base, applied: true }), 'inactive');
  assert.equal(seedNativeDraft({ ...base, draft: base.marker }), 'retained');
  assert.deepEqual(calls, []);
  assert.equal(seedNativeDraft(base), 'seeded'); assert.deepEqual(calls, [base.marker, 'persist']);
});
