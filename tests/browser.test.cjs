const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright-core');

const root = path.resolve(process.env.EXTENSION_DIR || path.join(__dirname, '..'));
const output = path.resolve(process.env.TEST_OUTPUT || path.join(__dirname, '..', 'test-results'));
const KEY = 'sugoku_jamana_fusen_state';
const LOCAL = '編集中の文章 A\n日本語と絵文字 📝';
const REMOTE = '別タブで書いた文章 B';
let context, worker, profile, extensionId;
let pageErrors = [];
const seed = () => ({ schemaVersion: 1, enabled: true, notes: ['保存済み A', '保存済み B'].map((text, order) => ({
  id: order ? 'b' : 'a', text, color: 'yellow', size: 'medium', opacity: .9, position: null,
  order, visible: true, createdAt: '2026-10-26T00:00:00Z', updatedAt: '2026-10-26T00:00:00Z'
})) });
const state = () => worker.evaluate(async key => (await chrome.storage.local.get(key))[key], KEY);
const textOf = editor => editor.evaluate(el => el.value ?? el.innerText);
async function until(check, label) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 30)); }
  assert.fail(label);
}
async function content(name = 'page') {
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`http://fusen.test/${name}`);
  try {
    await page.locator('.sjf-note-editor').nth(1).waitFor();
  } catch (error) {
    console.error('content initialization', { pageErrors, state: await state(), dom: await page.locator('html').innerHTML() });
    throw error;
  }
  await page.waitForFunction(() => document.getElementById('sjf-extension-host').shadowRoot.querySelector('link').sheet);
  return page;
}
async function popup() {
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.locator('.sjf-note-textarea').nth(1).waitFor();
  return page;
}
async function observe(editor) {
  await editor.evaluate(el => {
    window.originalEditor = el;
    window.blurCount = 0;
    el.addEventListener('blur', () => window.blurCount++);
  });
}
async function editingState(page) {
  return page.evaluate(() => {
    const el = window.originalEditor;
    const selection = window.getSelection();
    return {
      connected: el.isConnected,
      focused: el.getRootNode().activeElement === el,
      text: el.value ?? el.innerText,
      blurCount: window.blurCount,
      selectionStart: el.tagName === 'TEXTAREA' ? el.selectionStart : selection.anchorOffset,
      selectionEnd: el.tagName === 'TEXTAREA' ? el.selectionEnd : selection.focusOffset,
      noteId: el.closest('article').dataset.noteId
    };
  });
}
async function selectText(editor) {
  await editor.evaluate(el => {
    if (el.tagName === 'TEXTAREA') el.setSelectionRange(2, 5);
    else window.getSelection().setBaseAndExtent(el.firstChild, 2, el.firstChild, 5);
  });
}

before(async () => {
  await fs.mkdir(output, { recursive: true });
  profile = await fs.mkdtemp(path.join(os.tmpdir(), 'sjf-regression-'));
  context = await chromium.launchPersistentContext(profile, {
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chromium' }),
    headless: true, viewport: { width: 1280, height: 800 },
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', '--disable-background-networking']
  });
  context.setDefaultTimeout(5000);
  const cdp = await context.browser().newBrowserCDPSession();
  const loaded = await cdp.send('Extensions.loadUnpacked', { path: root });
  extensionId = loaded.id;
  await cdp.detach();
  worker = context.serviceWorkers().find(w => w.url() === `chrome-extension://${extensionId}/background.js`)
    || await context.waitForEvent('serviceworker', { predicate: w => w.url() === `chrome-extension://${extensionId}/background.js` });
  await context.route('http://fusen.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><h1>架空の付箋テスト</h1>' }));
  await fs.writeFile(path.join(output, 'environment.json'), JSON.stringify({ browser: context.browser().version(), extension: root, headless: true }, null, 2));
});

beforeEach(async () => {
  for (const page of context.pages()) await page.close();
  pageErrors = [];
  await worker.evaluate(async ({ key, value }) => {
    if (globalThis.originalSaveState) globalThis.SugokuJamanaFusenShared.saveState = globalThis.originalSaveState;
    await chrome.storage.local.set({ [key]: value });
  }, { key: KEY, value: seed() });
});

after(async () => {
  if (context) await context.close();
  if (profile) await fs.rm(profile, { recursive: true, force: true });
});

test('resize keeps the editor, selection and focus before and after autosave', async () => {
  const page = await content();
  const editor = page.locator('.sjf-note-editor').first();
  await editor.fill(LOCAL);
  await observe(editor);
  await selectText(editor);
  assert.equal((await state()).notes[0].text, '保存済み A');
  await page.setViewportSize({ width: 900, height: 650 });
  await page.waitForTimeout(50);
  let observed = await editingState(page);
  assert.equal(observed.connected, true, 'resize must keep the original DOM node');
  assert.equal(observed.focused, true);
  assert.equal(observed.blurCount, 0);
  assert.deepEqual([observed.selectionStart, observed.selectionEnd], [2, 5]);
  await until(async () => (await state()).notes[0].text === LOCAL, 'draft should autosave');
  observed = await editingState(page);
  assert.equal(observed.focused, true);
  assert.deepEqual([observed.selectionStart, observed.selectionEnd], [2, 5]);
  await page.screenshot({ path: path.join(output, 'resize.png') });
  await page.reload();
  await until(async () => await textOf(page.locator('.sjf-note-editor').first()) === LOCAL, 'reload must keep text');
  assert.deepEqual(pageErrors, []);
});

test('initial mount clears an obsolete overlay and repeat injection preserves the current editor', async () => {
  await context.route('http://fusen.test/stale', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><script>
    const host = document.createElement('div');
    host.id = 'sjf-extension-host';
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({mode: 'open'});
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = ${JSON.stringify(`chrome-extension://${extensionId}/styles.css`)};
    const mount = document.createElement('div');
    mount.className = 'sjf-shadow-root';
    mount.innerHTML = '<section class="sjf-overlay"><div class="obsolete">obsolete fixture</div></section>';
    shadow.append(link, mount);
  </script>` }));
  const a = await content('stale');
  const editor = a.locator('.sjf-note-editor').first();
  await editor.fill(LOCAL);
  await observe(editor);
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'http://fusen.test/stale' });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['shared.js', 'editor.js', 'content.js'] });
  });
  assert.equal(await a.locator('.obsolete').count(), 0);
  assert.equal(await a.locator('.sjf-overlay').count(), 1);
  assert.equal((await editingState(a)).connected, true);
  assert.equal((await editingState(a)).focused, true);
  assert.equal((await editingState(a)).text, LOCAL);
  await context.unroute('http://fusen.test/stale');
});

test('unrelated storage update preserves content and popup selection and new-note composer', async () => {
  const b = await content('b');
  const a = await content('a');
  const p = await popup();
  const editor = a.locator('.sjf-note-editor').first();
  const textarea = p.locator('.sjf-note-textarea').first();
  await editor.fill(LOCAL);
  await observe(editor);
  await selectText(editor);
  await textarea.fill(LOCAL);
  await observe(textarea);
  await selectText(textarea);
  await b.locator('.sjf-note-editor').nth(1).fill(REMOTE);
  await b.locator('.sjf-note-editor').nth(1).press('Meta+Enter');
  await until(async () => (await state()).notes[1].text === REMOTE, 'other note should save');
  await a.waitForTimeout(450);
  for (const page of [a, p]) {
    const result = await editingState(page);
    assert.equal(result.connected, true);
    assert.equal(result.focused, true);
    assert.equal(result.text, LOCAL);
    assert.deepEqual([result.selectionStart, result.selectionEnd], [2, 5]);
  }
  await p.locator('#newNoteText').fill('まだ追加していない文章');
  await b.locator('.sjf-note-editor').nth(1).fill('もう一度更新');
  await b.locator('.sjf-note-editor').nth(1).press('Meta+Enter');
  await until(async () => (await state()).notes[1].text === 'もう一度更新', 'second update should save');
  assert.equal(await p.locator('#newNoteText').inputValue(), 'まだ追加していない文章');
  assert.deepEqual(pageErrors, []);
});

for (const usePopup of [false, true]) {
  test(`concurrent same-note edits preserve BOTH versions and keep ${usePopup ? 'popup' : 'content'} editing its recovery note`, async () => {
    const b = await content('b');
    const a = usePopup ? await popup() : await content('a');
    const editor = a.locator(usePopup ? '.sjf-note-textarea' : '.sjf-note-editor').first();
    await editor.fill(LOCAL);
    await observe(editor);
    await selectText(editor);
    await b.locator('.sjf-note-editor').first().fill(REMOTE);
    await b.locator('.sjf-note-editor').first().press('Meta+Enter');
    await until(async () => {
      const notes = (await state()).notes;
      return notes.some(n => n.text === LOCAL) && notes.some(n => n.text === REMOTE);
    }, 'both conflicting versions must be persisted');
    await a.waitForTimeout(100);
    let notes = (await state()).notes;
    assert.equal(notes.length, 3, 'only one recovery note');
    assert.equal(notes.find(n => n.id === 'a').text, REMOTE);
    const recovered = notes.find(n => n.text === LOCAL);
    assert.equal(recovered.recoveredFrom.noteId, 'a');
    const observed = await editingState(a);
    assert.equal(observed.connected, true);
    assert.equal(observed.focused, true);
    assert.equal(observed.noteId, recovered.id);
    assert.deepEqual([observed.selectionStart, observed.selectionEnd], [2, 5]);
    if (usePopup) {
      assert.equal(await a.evaluate(() => {
        const rect = window.originalEditor.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= window.innerHeight;
      }), true, 'the active recovery editor must stay in view');
    }
    await a.screenshot({ path: path.join(output, `conflict-${usePopup ? 'popup' : 'content'}.png`) });
    // Keep typing into the SAME DOM node; it must save to the recovery note.
    await a.evaluate(text => {
      const el = window.originalEditor;
      if (el.tagName === 'TEXTAREA') el.value = text; else el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '追記' }));
    }, LOCAL + '\n追記');
    await until(async () => (await state()).notes.some(n => n.id === recovered.id && n.text === LOCAL + '\n追記'), 'continued edit must target recovery');
    notes = (await state()).notes;
    assert.equal(notes.length, 3);
    assert.equal(notes.find(n => n.id === 'a').text, REMOTE);
    await a.reload();
    const texts = await a.locator(usePopup ? '.sjf-note-textarea' : '.sjf-note-editor').evaluateAll(els => els.map(el => el.value ?? el.innerText));
    assert.ok(texts.includes(REMOTE) && texts.includes(LOCAL + '\n追記'));
    assert.deepEqual(pageErrors, []);
  });
}

test('IME composition survives resize and remote conflict; only committed text is saved', async () => {
  const b = await content('b');
  const a = await content('a');
  const editor = a.locator('.sjf-note-editor').first();
  await editor.focus();
  await observe(editor);
  await editor.evaluate(el => {
    if (el.tagName === 'TEXTAREA') el.setSelectionRange(0, el.value.length);
    else window.getSelection().selectAllChildren(el);
  });
  const cdp = await context.newCDPSession(a);
  await cdp.send('Input.imeSetComposition', { text: 'へんかん', selectionStart: 4, selectionEnd: 4 });
  await a.setViewportSize({ width: 900, height: 650 });
  await b.locator('.sjf-note-editor').first().fill(REMOTE);
  await b.locator('.sjf-note-editor').first().press('Meta+Enter');
  await until(async () => (await state()).notes[0].text === REMOTE, 'remote save must complete');
  await a.waitForTimeout(400);
  assert.equal((await editingState(a)).focused, true);
  assert.equal((await editingState(a)).text, 'へんかん');
  assert.equal((await state()).notes.length, 2, 'uncommitted composition should not be persisted');
  await cdp.send('Input.insertText', { text: '変換確定' });
  await until(async () => (await state()).notes.some(n => n.text === '変換確定'), 'committed IME text should be protected');
  assert.ok((await state()).notes.some(n => n.text === REMOTE));
  assert.equal((await editingState(a)).focused, true);
  await cdp.detach();
  assert.deepEqual(pageErrors, []);
});

test('remote deletion recovers an active draft without reviving the deleted id', async () => {
  const b = await popup();
  const a = await content();
  const editor = a.locator('.sjf-note-editor').first();
  await editor.fill(LOCAL);
  await observe(editor);
  await b.locator('.sjf-popup-note').first().getByRole('button', { name: '削除', exact: true }).click();
  await until(async () => (await state()).notes.some(n => n.text === LOCAL && n.recoveredFrom?.reason === 'deleted'), 'deleted draft should be recovered');
  assert.ok(!(await state()).notes.some(n => n.id === 'a'));
  assert.equal((await editingState(a)).focused, true);
});

test('save failure retains the draft and retries without duplicate recovery', async () => {
  const a = await content();
  const editor = a.locator('.sjf-note-editor').first();
  await worker.evaluate(() => {
    const shared = globalThis.SugokuJamanaFusenShared;
    globalThis.originalSaveState = shared.saveState;
    shared.saveState = async () => { throw new Error('TEST injected storage failure'); };
  });
  await editor.fill(LOCAL);
  await observe(editor);
  await until(async () => (await a.locator('.sjf-save-status').first().innerText()).includes('保存できませんでした'), 'failure must be visible');
  await a.setViewportSize({ width: 950, height: 700 });
  assert.equal((await editingState(a)).text, LOCAL);
  assert.equal((await editingState(a)).focused, true);
  assert.equal((await state()).notes[0].text, '保存済み A');
  await worker.evaluate(() => { globalThis.SugokuJamanaFusenShared.saveState = globalThis.originalSaveState; });
  await editor.press('Meta+Enter');
  await until(async () => (await state()).notes[0].text === LOCAL, 'retry should persist draft');
  assert.equal((await state()).notes.length, 2);
  assert.deepEqual(pageErrors, []);
});

test('empty text and trailing newlines survive save, sync and reload', async () => {
  const a = await content();
  const p = await popup();
  for (const text of ['', '1行目\n2行目 📝\n\n']) {
    await a.locator('.sjf-note-editor').first().fill(text);
    await a.locator('.sjf-note-editor').first().press('Meta+Enter');
    await until(async () => (await state()).notes[0].text === text, 'exact text should save');
    await until(async () => await p.locator('.sjf-note-textarea').first().inputValue() === text, 'popup should show exact text');
    await a.reload();
    await a.locator('.sjf-note-editor').first().waitFor();
    assert.equal(await textOf(a.locator('.sjf-note-editor').first()), text);
  }
  assert.deepEqual(pageErrors, []);
});

test('create, appearance, drag, reset, visibility, global toggle and explicit delete still work', async () => {
  const a = await content();
  const p = await popup();
  await p.locator('#newNoteText').fill('新しい付箋');
  await p.locator('#addNoteButton').click();
  await until(async () => (await state()).notes.length === 3, 'create should save');
  const card = p.locator('.sjf-popup-note').first();
  await card.locator('select').nth(0).selectOption('pink');
  await card.locator('select').nth(1).selectOption('large');
  await card.locator('input[type=range]').fill('65');
  await card.locator('input[type=range]').dispatchEvent('change');
  await until(async () => { const n = (await state()).notes[0]; return n.color === 'pink' && n.size === 'large' && n.opacity === .65; }, 'appearance changes should merge');
  const rect = await a.locator('.sjf-note').first().boundingBox();
  await a.mouse.move(rect.x + 10, rect.y + 10);
  await a.mouse.down();
  await a.mouse.move(rect.x - 100, rect.y + 80, { steps: 4 });
  await a.mouse.up();
  await until(async () => !!(await state()).notes[0].position, 'drag should save');
  await card.getByRole('button', { name: '位置戻す' }).click();
  await until(async () => (await state()).notes[0].position === null, 'reset should save');
  await card.locator('input[type=checkbox]').uncheck();
  await until(async () => await a.locator('.sjf-note').count() === 2, 'per-note visibility should apply');
  await card.locator('input[type=checkbox]').check();
  await until(async () => await a.locator('.sjf-note').count() === 3, 'note should return');
  await p.locator('#enabledToggle').uncheck();
  await until(async () => await a.locator('.sjf-note').count() === 0, 'global pause should apply');
  await p.locator('#enabledToggle').check();
  await until(async () => await a.locator('.sjf-note').count() === 3, 'global resume should apply');
  await a.locator('.sjf-note-editor').first().fill('削除を明示した文章');
  await a.locator('.sjf-note-delete').first().click();
  await until(async () => !(await state()).notes.some(n => n.id === 'a'), 'explicit delete should remove note');
  await a.waitForTimeout(450);
  assert.equal((await state()).notes.length, 2, 'explicit delete must not create a recovery note');
  assert.deepEqual(pageErrors, []);
});
