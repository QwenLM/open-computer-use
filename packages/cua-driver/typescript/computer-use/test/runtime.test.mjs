import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ComputerUse } from '../index.js';
import { createCua } from '../runtime.js';
import { documentation } from '../documentation.js';
function fixture() {
  const calls = []; const written = []; const images = [];
  const computer = new ComputerUse({ callTool(name, raw) {
    const args = JSON.parse(raw); calls.push([name, args]);
    return { text: name.startsWith('get_') ? 'driver-rendered state [1]' : 'Sent but not confirmed.',
      structuredJson: JSON.stringify({ app: 'org.fixture', name: 'Fixture' }),
      images: name.includes('screenshot') ? [{ mimeType: 'image/png', dataBase64: 'AQ==' }] : [],
    };
  } });
  return { cua: createCua({ write: (x) => written.push(x), emitImage: (x) => images.push(x) }, { computer }), calls, written, images };
}
test('getApp emits its one native full AX result; observations forward driver text unchanged', async () => {
  const f = fixture(); const app = await f.cua.getApp('Fixture');
  assert.deepEqual(f.calls, [['get_app', { app: 'Fixture', deliver: true }]]);
  assert.deepEqual(f.written, ['driver-rendered state [1]']); assert.equal(f.images.length, 0);
  assert.equal(await app.getAXState({ forceFull: true, maxTextChars: 20000, emit: false }), 'driver-rendered state [1]');
  assert.deepEqual(f.calls.at(-1), ['get_ax_state', { app: 'org.fixture', force_full: true, max_text_chars: 20000, deliver: false }]);
  assert.equal(f.written.length, 1);
});
test('screenshot-only is a distinct native operation and actual MIME is preserved', async () => {
  const f = fixture(); const app = await f.cua.getApp('Fixture');
  await app.getScreenshot();
  assert.equal(f.calls.at(-1)[0], 'get_screenshot');
  assert.deepEqual(f.images, ['data:image/png;base64,AQ==']);
  await app.getAXStateAndScreenshot({ emit: false }); assert.equal(f.images.length, 1);
});
test('actions return void, preserve advisories and send once with click modifiers', async () => {
  const f = fixture(); const app = await f.cua.getApp('Fixture');
  assert.equal(await app.click(1, { key: ['shift'] }), undefined);
  assert.deepEqual(f.calls.at(-1), ['click', { app: 'org.fixture', element: 1, key: ['shift'] }]);
  assert.match(f.written.at(-1), /Sent but not confirmed: Fixture:.*Observe before retrying/);
  assert.equal(f.calls.length, 2);
});
test('documentation is platform-specific and includes generated tool descriptions', () => {
  assert.match(documentation('linux'), /only X11/);
  assert.match(documentation('darwin'), /macOS/);
  assert.match(documentation('darwin'), /getAXStateAndScreenshot/);
  assert.match(documentation('darwin'), /cua\.desktop\.keyDown/);
  assert.doesNotMatch(documentation('darwin'), /app\.desktop\./);
});

test('desktop calls use explicit scope, serialize, return void and dispose the owning session', async () => {
  const f = fixture();
  await f.cua.desktop.getScreenshot();
  assert.deepEqual(f.calls[0], ['get_screenshot', { scope: 'desktop' }]);
  assert.equal(await f.cua.desktop.click({ x: 15, y: 32 }, { key: 'ctrl' }), undefined);
  assert.deepEqual(f.calls[1], ['click', { key: 'ctrl', x: 15, y: 32, scope: 'desktop' }]);
  await f.cua.desktop.keyDown('shift');
  await f.cua.desktop.keyUp('shift');
  assert.deepEqual(f.calls.slice(-2), [['key_down', { key: 'shift', scope: 'desktop' }], ['key_up', { key: 'shift', scope: 'desktop' }]]);
  await f.cua[Symbol.asyncDispose]();
  await assert.rejects(f.cua.desktop.keyDown('shift'), /closed/);
});

test('browser facade returns repository handles unchanged, requires unique URLs, and cleans up', async () => {
  const written = []; const navigated = []; let closed = 0;
  const tab = { id: 'tab-1', playwright: { domSnapshot: async () => 'DOM' }, goto: async (url) => navigated.push(url) };
  const browser = { browserId: 'chrome-1', documentation: async () => 'BROWSER DOC', tabs: {
    list: async () => [{ id: 'tab-1', url: 'https://example.com' }, { id: 'tab-2', url: 'https://example.com' }],
    get: async (id) => { assert.equal(id, 'tab-1'); return tab; }, new: async () => tab,
  } };
  const browserModule = { setupBrowserRuntime: async () => ({ browsers: {
    list: async () => [{ id: 'chrome-1', name: 'Chrome' }], get: async () => browser,
  } }), closeBrowserRuntime: async () => { closed++; } };
  const cua = createCua({ write: (value) => written.push(value) }, { browserModule });
  assert.equal(await cua.getBrowser('Chrome'), browser);
  assert.equal(await cua.getBrowser({ id: 'chrome-1' }), browser);
  assert.equal(written.filter((text) => text === 'BROWSER DOC').length, 1);
  await assert.rejects(cua.getTab({ url: 'https://example.com' }), /found 2/);
  assert.equal(await cua.getTab('tab-1', { browser: 'Chrome' }), tab);
  assert.equal(written.at(-1), 'DOM');
  assert.equal(await cua.createBrowserTab('Chrome', 'https://example.org'), tab);
  assert.deepEqual(navigated, ['https://example.org']);
  await cua[Symbol.asyncDispose](); assert.equal(closed, 1);
  await assert.rejects(cua.getBrowser('Chrome'), /closed/);
});

test('disposing during a lazy browser import prevents a late browser connection', async () => {
  let resolveModule; let connected = 0;
  const pending = new Promise((resolve) => { resolveModule = resolve; });
  const cua = createCua({ write() {} }, { browserModule: pending });
  const selection = cua.getBrowser('Chrome');
  await cua[Symbol.asyncDispose]();
  resolveModule({ setupBrowserRuntime() { connected++; throw new Error('must not connect'); } });
  await assert.rejects(selection, /closed/);
  assert.equal(connected, 0);
});

function cellFixture() {
  const calls = [], written = [], images = [], hooks = [];
  const controller = new AbortController();
  const signal = controller.signal;
  let cell = { id: 'one', droppedTags: [] };
  let fail = false;
  const runtime = {
    signal,
    write(value, meta) { written.push({ value, meta }); },
    emitImage(value, meta) { images.push({ value, meta }); },
    [Symbol.for('qwen.nodeRepl.cellEnd')](fn) { hooks.push(fn); },
    get [Symbol.for('qwen.nodeRepl.cell')]() { return cell; },
  };
  const computer = new ComputerUse({ callTool(name, raw, opts) {
    const args = JSON.parse(raw); calls.push({ name, args, opts });
    if (name === 'get_screenshot') assert.equal(args.force_full, undefined, 'native screenshots do not accept force_full');
    if (fail) return { isError: true, text: 'refused', structuredJson: JSON.stringify({ code: 'refused', sent: false, delivery: 'not_delivered', retry: 'safe' }) };
    if (name === 'wait_for') return { text: 'met after 25 ms', structuredJson: JSON.stringify({ met: true, elapsed_ms: 25 }) };
    const app = args.app === 'Other' ? 'other' : 'fixture';
    return {
      text: name.startsWith('get_') ? 'FULL AX' : args.wait_for ? 'wait result' : 'click(1): delivery not confirmed',
      images: name.includes('screenshot') ? [{ mimeType: 'image/png', dataBase64: 'AQID' }] : [],
      structuredJson: JSON.stringify({ app, name: app, ...(args.wait_for ? { wait: { met: true }, advisory: 'click(1): delivery not confirmed (wait condition met)' } : {}) }),
    };
  } });
  return { cua: createCua(runtime, { computer }), runtime, calls, written, images, signal, controller,
    fail() { fail = true; },
    end() { for (const hook of hooks) hook(); },
    next(droppedTags = []) { cell = { id: cell.id + 'x', droppedTags }; },
    clear() { written.length = 0; images.length = 0; },
  };
}

test('hidden binding and observations send deliver:false and return exact bytes or combined state', async () => {
  const f = cellFixture();
  const app = await f.cua.getApp('Fixture', { emit: false });
  assert.equal(f.calls[0].args.deliver, false);
  assert.equal(f.written.length, 0);
  assert.deepEqual(await app.getScreenshot({ emit: false }), new Uint8Array([1, 2, 3]));
  assert.deepEqual(await app.getAXStateAndScreenshot({ emit: false }), { state: 'FULL AX', screenshot: new Uint8Array([1, 2, 3]) });
  assert.deepEqual(await f.cua.desktop.getScreenshot({ emit: false }), new Uint8Array([1, 2, 3]));
  assert.equal(f.written.length + f.images.length, 0);
  await app.getAXState();
  assert.equal(f.calls.at(-1).args.deliver, true);
  assert.deepEqual(f.written[0].meta, { tag: { source: 'cua.state', app: 'fixture' } });
});

test('forty advisories across apps merge once, survive hidden observation, and flush before display', async () => {
  const f = cellFixture(); const app = await f.cua.getApp('Fixture');
  const other = await f.cua.getApp('Other'); f.clear();
  await other.click(1);
  for (let i = 1; i < 40; i++) await app.click(1);
  await app.getAXState({ emit: false });
  assert.equal(f.written.length, 0);
  await app.getAXState();
  assert.equal(f.written.length, 2);
  assert.match(f.written[0].value, /other: click\(1\).*fixture: click\(1\).*and 35 more.*The state below/);
  assert.equal(f.written[1].value, 'FULL AX');
  f.end(); assert.equal(f.written.length, 2);
});

test('advisories flush before any CUA error and at cell end without leaking into the next cell', async () => {
  const f = cellFixture(); const app = await f.cua.getApp('Fixture'); f.clear();
  await app.click(1); f.end();
  assert.match(f.written[0].value, /Observe before retrying/);
  f.next(); f.clear(); f.end(); assert.equal(f.written.length, 0);
  await app.click(1); f.fail();
  await assert.rejects(f.cua.getState(), (error) => error.delivery === 'not_delivered' && error.retry === 'safe' && error.sent === false);
  assert.equal(f.written.length, 1);
  assert.match(f.written[0].value, /fixture: click/);
});

test('deduplicates displayed screenshots only within their cell, while returning bytes', async () => {
  const f = cellFixture(); const app = await f.cua.getApp('Fixture'); f.clear();
  const bytes = await app.getScreenshot();
  await f.runtime.emitImage(bytes);
  assert.equal(f.images.length, 1);
  assert.equal(f.written.at(-1).value, '(image already shown)');
  f.end(); f.next();
  await app.getScreenshot(); assert.equal(f.images.length, 2);
  f.end(); f.next(); f.clear();
  const hidden = await app.getScreenshot({ emit: false });
  await f.runtime.emitImage(hidden); assert.equal(f.images.length, 1);
});

test('truncation feedback forces the next displayed AX observation even after a hidden read or screenshot', async () => {
  const f = cellFixture(); const app = await f.cua.getApp('Fixture');
  f.end(); f.next([{ source: 'cua.state', app: 'fixture' }]);
  await app.getAXState({ emit: false });
  assert.equal(f.calls.at(-1).args.force_full, undefined);
  await app.getScreenshot();
  assert.equal(f.calls.at(-1).args.force_full, undefined);
  await app.getAXState(); assert.equal(f.calls.at(-1).args.force_full, true);
  await app.getAXState(); assert.equal(f.calls.at(-1).args.force_full, undefined);
  f.end(); f.next([{ source: 'cua.state', app: 'fixture' }]);
  await f.cua.getApp('Fixture', { emit: false });
  await f.cua.getApp('Fixture'); assert.equal(f.calls.at(-1).args.force_full, true);
});

test('waitFor remains quiet and action wait options preserve the advisory facts', async () => {
  const f = cellFixture(); const app = await f.cua.getApp('Fixture'); f.clear();
  assert.deepEqual(await app.waitFor({ text: 'Saved' }, { timeoutMs: 300 }), { met: true, elapsedMs: 25 });
  assert.deepEqual(f.calls.at(-1).args, { app: 'fixture', condition: { text: 'Saved' }, timeout_ms: 300 });
  assert.equal(f.calls.at(-1).opts.signal, f.signal);
  assert.equal(f.written.length, 0);
  await app.click(1, { waitFor: { surface: 'dialog' }, waitTimeoutMs: 800 });
  assert.deepEqual(f.calls.at(-1).args.wait_for, { condition: { surface: 'dialog' }, timeout_ms: 800 });
  assert.equal(f.calls.at(-1).opts, undefined);
  f.end();
  assert.match(f.written[0].value, /wait condition met/);
  assert.doesNotMatch(f.written[0].value, /wait result/);
});

test('an action error keeps its structured delivery fields and flushes that action advisory', async () => {
  const written = [];
  const structured = { code: 'call_cancelled', sent: true, delivery: 'delivered_unverified', retry: 'unsafe', advisory: 'click(1): delivery not confirmed' };
  const computer = new ComputerUse({ callTool(name) {
    return name === 'get_app'
      ? { text: 'AX', structuredJson: JSON.stringify({ app: 'fixture', name: 'Fixture' }) }
      : { isError: true, text: 'Original cancellation', structuredJson: JSON.stringify(structured) };
  } });
  const cua = createCua({ write(value) { written.push(value); }, [Symbol.for('qwen.nodeRepl.cellEnd')]() {} }, { computer });
  const app = await cua.getApp('Fixture');
  await assert.rejects(app.click(1), (error) => error.message === 'Original cancellation' && error.code === structured.code && error.delivery === structured.delivery && error.retry === structured.retry);
  assert.equal(written.length, 2);
  assert.match(written[1], /Fixture: click\(1\): delivery not confirmed.*Observe before retrying/);
});

test('explicit operation signals remain bound to cell cancellation and its cleanup barrier', async () => {
  const f = cellFixture(); const app = await f.cua.getApp('Fixture');
  const explicit = new AbortController();
  const barriers = [];
  f.signal.waitUntil = (promise) => { barriers.push(promise); return promise; };
  await app.waitFor({ text: 'Saved' }, { signal: explicit.signal });
  const effective = f.calls.at(-1).opts.signal;
  assert.notEqual(effective, explicit.signal);
  assert.equal(effective.aborted, false);
  f.controller.abort();
  assert.equal(effective.aborted, true);
  assert(barriers.length >= 2); // Native terminal and facade delivery bookkeeping.
});
