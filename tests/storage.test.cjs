const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');

function harness(notes = [{ id: 'a', text: 'base' }]) {
  let stored = { schemaVersion: 1, enabled: true, notes };
  let listener;
  let fail = false;
  const noop = { addListener() {} };
  const context = vm.createContext({
    console: { error() {}, warn() {} }, crypto: { randomUUID },
    chrome: {
      storage: { local: {
        async get(key) { await new Promise(r => setTimeout(r, 2)); return { [key]: structuredClone(stored) }; },
        async set(value) { if (fail) { fail = false; throw new Error('simulated write failure'); } stored = structuredClone(Object.values(value)[0]); }
      } },
      runtime: { onMessage: { addListener(fn) { listener = fn; } }, onInstalled: noop, onStartup: noop },
      tabs: { onUpdated: noop }, scripting: {}
    },
    importScripts(name) { vm.runInContext(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'), context); }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8'), context);
  const send = action => new Promise(resolve => listener({ type: 'mutate-notes', action }, {}, resolve));
  return { send, state: () => stored, failNextWrite: () => { fail = true; } };
}
const edit = (text, editId, overrides = {}) => ({ kind: 'text', noteId: 'a', baseText: 'base', text, editId, ...overrides });

test('simultaneous text saves preserve both versions and retry does not duplicate recovery', async () => {
  const h = harness();
  const [a, b] = await Promise.all([h.send(edit('version A', 'edit-a')), h.send(edit('version B', 'edit-b'))]);
  assert.ok(a.ok && b.ok);
  assert.equal(h.state().notes.length, 2);
  assert.equal(h.state().notes.find(n => n.id === 'a').text, 'version A');
  assert.equal(b.note.text, 'version B');
  assert.equal(b.note.recoveredFrom.noteId, 'a');
  assert.notEqual(b.note.id, 'a');
  const retry = await h.send(edit('version B', 'edit-b'));
  assert.equal(retry.note.id, b.note.id);
  assert.equal(h.state().notes.length, 2);
  await h.send(edit('version B continued', 'edit-c', { noteId: b.note.id, baseText: 'version B' }));
  assert.equal(h.state().notes.length, 2);
  assert.equal(h.state().notes.find(n => n.id === b.note.id).text, 'version B continued');
});

test('concurrent text, appearance, add and visibility changes all survive', async () => {
  const h = harness([{ id: 'a', text: 'base' }, { id: 'b', text: 'untouched', position: { x: 80, y: 90 } }]);
  const results = await Promise.all([
    h.send(edit('updated', 'edit-a')),
    h.send({ kind: 'patch', noteId: 'a', patch: { color: 'pink', opacity: .7, size: 'large', text: 'must not bypass conflict checks' } }),
    h.send({ kind: 'add', note: { id: 'c', text: 'new' } }),
    h.send({ kind: 'enabled', enabled: false })
  ]);
  assert.ok(results.every(r => r.ok));
  assert.equal(h.state().notes.find(n => n.id === 'a').text, 'updated');
  assert.equal(h.state().notes.find(n => n.id === 'a').color, 'pink');
  assert.equal(h.state().notes.find(n => n.id === 'a').opacity, .7);
  assert.deepEqual(h.state().notes.find(n => n.id === 'b').position, { x: 80, y: 90 });
  assert.equal(h.state().notes.find(n => n.id === 'c').text, 'new');
  assert.equal(h.state().enabled, false);
});

test('deleted remote note is not resurrected; late draft is recovered under a new id', async () => {
  const h = harness();
  await h.send({ kind: 'delete', noteId: 'a' });
  const saved = await h.send(edit('late draft', 'edit-a', { fallback: { color: 'blue', size: 'large' } }));
  assert.equal(saved.ok, true);
  assert.notEqual(saved.note.id, 'a');
  assert.equal(saved.note.recoveredFrom.reason, 'deleted');
  assert.equal(saved.note.color, 'blue');
  assert.equal(h.state().notes.length, 1);
});

test('failed persistence keeps previous data and does not poison the mutation queue', async () => {
  const h = harness();
  h.failNextWrite();
  assert.equal((await h.send(edit('draft', 'edit-a'))).ok, false);
  assert.equal(h.state().notes[0].text, 'base');
  assert.equal((await h.send(edit('draft', 'edit-a'))).ok, true);
  assert.equal(h.state().notes[0].text, 'draft');
  await h.send({ kind: 'delete', noteId: 'a' });
  assert.equal(h.state().notes.length, 0);
});

test('identical concurrent text is deduplicated and legacy notes are normalized', async () => {
  const h = harness([{ id: 'a', text: 'base', position: { x: 24, y: 51 }, visible: false }]);
  await Promise.all([h.send(edit('same', 'edit-a')), h.send(edit('same', 'edit-b'))]);
  assert.equal(h.state().notes.length, 1);
  assert.equal(h.state().notes[0].visible, false);
  assert.deepEqual(h.state().notes[0].position, { x: 24, y: 51 });
  assert.equal(h.state().schemaVersion, 1);
});
