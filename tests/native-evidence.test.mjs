import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptanceMarker, storedMarker } from '../src/client/native-evidence.mjs';
test('native evidence exports only explicit synthetic acceptance markers', () => {
  assert.equal(acceptanceMarker(' RW-A-WRITE-20261109 '), 'RW-A-WRITE-20261109');
  for (const value of ['private manuscript', 'RW-A-WRITE-20261109 private', '', null]) assert.equal(acceptanceMarker(value), null);
  const storage = { getItem: () => JSON.stringify({ draft: { text: 'RW-B-READ-20261109', references: [] } }) };
  assert.equal(storedMarker(storage, 'owned'), 'RW-B-READ-20261109');
  storage.getItem = () => JSON.stringify({ draft: 'private manuscript' });
  assert.equal(storedMarker(storage, 'owned'), null);
  storage.getItem = () => '{'; assert.equal(storedMarker(storage, 'owned'), null);
});
