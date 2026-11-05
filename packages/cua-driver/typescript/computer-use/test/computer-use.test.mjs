import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ComputerUse } from '../index.js';
const result = (structured = {}, extra = {}) => ({ text: '', structuredJson: JSON.stringify(structured), images: [], ...extra });
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }
function transport(callTool, options) { return new ComputerUse({ callTool }, options); }

test('one app action is one native call with no SDK discovery or target state', async () => {
  const calls = [];
  const computer = transport((name, args) => { calls.push([name, JSON.parse(args)]); return result({ app: '/Fixture.app', name: 'Fixture' }); });
  const { app } = await computer.getApp('Fixture');
  await app.call('click', { element: 3 });
  assert.deepEqual(calls, [['get_app', { app: 'Fixture' }], ['click', { element: 3, app: '/Fixture.app' }]]);
});

test('same canonical app serializes calls while another app can progress', async () => {
  const gate = deferred(); const calls = [];
  const computer = transport((name, raw) => {
    const args = JSON.parse(raw); calls.push([name, args.app]);
    if (name === 'get_app') return result({ app: args.app === 'Alias' ? 'A' : args.app, name: args.app });
    return args.app === 'A' && name === 'type_text' ? gate.promise : result();
  });
  const { app: a } = await computer.getApp('A');
  const { app: alias } = await computer.getApp('Alias');
  const { app: b } = await computer.getApp('B');
  assert.equal(a, alias);
  const first = a.call('type_text', { text: 'first' });
  const second = alias.call('press_key', { key: 'Enter' });
  await b.call('click', { element: 1 });
  assert(!calls.some(([name]) => name === 'press_key'));
  gate.resolve(result()); await Promise.all([first, second]);
  assert.equal(calls.at(-1)[0], 'press_key');
});

test('driver errors preserve code, reason, sent and next without rewriting or replay', async () => {
  let calls = 0;
  const error = { code: 'write_not_applied', reason: 'Value readback differs', sent: true, delivery: 'delivered_unverified', retry: 'unsafe', next: 'Observe the field.' };
  const computer = transport(() => { calls++; return result(error, { text: 'original driver explanation', isError: true }); });
  await assert.rejects(computer.appCall('set_value', { app: 'Fixture', element: 1, value: 'new' }), (actual) => {
    assert.equal(actual.message, 'original driver explanation');
    for (const key of Object.keys(error)) assert.equal(actual[key], error[key]);
    return true;
  });
  assert.equal(calls, 1);
});

test('cancellation before dispatch sends nothing', async () => {
  let calls = 0;
  const computer = transport(() => { calls++; return result(); });
  await assert.rejects(computer.appCall('click', { app: 'Fixture', element: 1 }, { signal: AbortSignal.abort() }), { code: 'call_cancelled' });
  assert.equal(calls, 0);
});

test('post-dispatch cancellation waits for the native terminal result without replay', async () => {
  const gate = deferred(); const controller = new AbortController(); let barrier; let calls = 0; let done = false;
  controller.signal.waitUntil = (promise) => { barrier = promise; return promise; };
  const computer = transport(() => { calls++; return gate.promise; });
  const pending = computer.appCall('click', { app: 'Fixture', element: 1 }, { signal: controller.signal }).then((value) => { done = true; return value; });
  controller.abort(); await new Promise(setImmediate);
  assert.equal(done, false); assert.equal(barrier, gate.promise);
  gate.resolve(result()); await pending;
  assert.equal(calls, 1);
});

test('expired mutations are never replayed; an expired read can bind one replacement session', async () => {
  let reads = 0; let mutations = 0; let replacements = 0;
  const expired = () => result({ code: 'authorization_context_expired', sent: false }, { isError: true });
  const replacement = { callTool() { reads++; return result({}, { text: 'new session state' }); } };
  const computer = new ComputerUse({ callTool(name) { if (name === 'click') mutations++; else reads++; return expired(); } }, {
    ownsSession: true, sessionFactory() { replacements++; return replacement; },
  });
  await assert.rejects(computer.appCall('click', { app: 'Fixture', element: 1 }), { code: 'authorization_context_expired' });
  assert.equal(replacements, 0); assert.equal(mutations, 1);
  const observed = await computer.getState();
  assert.equal(observed.text, 'new session state'); assert.equal(replacements, 1); assert.equal(reads, 2);
});

test('close tears down both handles after an endSession failure and is idempotent', async () => {
  const calls = [];
  const session = { callTool() { return result(); }, endSession() { calls.push('end'); throw Error('end failure'); }, async closeAsync() { calls.push('close'); }, uniffiDestroy() { calls.push('session destroy'); } };
  const owner = { shutdown() { calls.push('shutdown'); }, uniffiDestroy() { calls.push('owner destroy'); } };
  const computer = new ComputerUse(session, { owner, ownsSession: true });
  await assert.rejects(computer.close(), /end failure/);
  await computer.close();
  assert.deepEqual(calls, ['end', 'close', 'session destroy', 'shutdown', 'owner destroy']);
  await assert.rejects(computer.getState(), /closed/);
});

for (const phase of ['during-dispatch', 'after-dispatch']) {
  test(`action wait cancellation ${phase} bypasses the app queue but preserves the native terminal barrier`, async () => {
    const gate = deferred(); const controller = new AbortController(); const calls = [];
    let barrier; let done = false;
    controller.signal.waitUntil = (promise) => { barrier = promise; return promise; };
    const computer = transport((name, raw, opts) => {
      const args = JSON.parse(raw); calls.push({ name, args, opts });
      if (name === 'get_app') return result({ app: 'fixture', name: 'Fixture' });
      if (name === 'click') {
        if (phase === 'during-dispatch') controller.abort();
        return gate.promise;
      }
      return result();
    });
    const { app } = await computer.getApp('Fixture');
    const pending = app.call('click', { element: 1, wait_for: { condition: { text: 'Saved' } } }, { signal: controller.signal });
    const observed = pending.then((value) => { done = true; return value; }, (error) => { done = true; throw error; });
    await new Promise(setImmediate);
    if (phase === 'after-dispatch') controller.abort();
    await new Promise(setImmediate);
    assert.equal(done, false);
    assert.equal(barrier, gate.promise);
    assert.deepEqual(calls.map(({ name }) => name), ['get_app', 'click', 'cancel_wait']);
    assert.equal(calls[1].opts, undefined);
    assert.equal(calls[2].opts, undefined);
    assert.match(calls[1].args.wait_id, /^[0-9a-f-]{36}$/);
    assert.equal(calls[2].args.wait_id, calls[1].args.wait_id);
    const structured = { code: 'call_cancelled', sent: true, delivery: 'delivery_uncertain', retry: 'unsafe', advisory: 'click(1): delivery not confirmed' };
    gate.resolve(result(structured, { isError: true, text: 'wait cancelled after action' }));
    await assert.rejects(observed, (error) => error.code === 'call_cancelled' && error.sent === true && error.delivery === 'delivery_uncertain' && error.retry === 'unsafe' && error.details.advisory === structured.advisory);
    assert.equal(calls.length, 3);
  });
}

test('completed action waits remove their cancellation listener, and pre-cancelled ones send nothing', async () => {
  const calls = []; const controller = new AbortController();
  const computer = transport((name) => { calls.push(name); return result(); });
  const args = { app: 'fixture', element: 1, wait_for: { condition: { text: 'Saved' } } };
  await computer.appCall('click', args, { signal: controller.signal });
  controller.abort(); await new Promise(setImmediate);
  assert.deepEqual(calls, ['click']);
  await assert.rejects(computer.appCall('click', args, { signal: controller.signal }), (error) => error.code === 'call_cancelled' && error.delivery === 'not_delivered' && error.retry === 'safe');
  assert.deepEqual(calls, ['click']);
});

test('standalone wait receives cancellation without granting it to other native observations', async () => {
  const calls = []; const controller = new AbortController();
  const computer = transport((name, raw, opts) => { calls.push({ name, opts }); return result({ met: false, elapsed_ms: 1 }); });
  await computer.appCall('wait_for', { app: 'fixture', condition: { text: 'Saved' } }, { signal: controller.signal });
  await computer.appCall('get_ax_state', { app: 'fixture' }, { signal: controller.signal });
  assert.equal(calls[0].opts.signal, controller.signal);
  assert.equal(calls[1].opts, undefined);
});

test('standalone wait preserves a UniFFI AbortError and releases the same-app queue', async () => {
  const controller = new AbortController(); const calls = []; const dispatched = deferred();
  const abortError = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  const computer = transport((name, raw, options) => {
    calls.push(name);
    if (name === 'get_app') return result({ app: 'fixture', name: 'Fixture' });
    if (name !== 'wait_for') return result({}, { text: 'current state' });
    assert.equal(options.signal, controller.signal);
    return new Promise((_, reject) => {
      options.signal.addEventListener('abort', () => reject(abortError), { once: true });
      dispatched.resolve();
    });
  });
  const { app } = await computer.getApp('Fixture');
  const waiting = app.call('wait_for', { condition: { text: 'Saved' } }, { signal: controller.signal });
  const rejected = assert.rejects(waiting, (error) => error === abortError && error.sent === undefined && error.delivery === undefined && error.retry === undefined);
  await dispatched.promise;
  const queued = app.call('get_ax_state');
  controller.abort();
  await rejected;
  assert.equal((await queued).text, 'current state');
  assert.deepEqual(calls, ['get_app', 'wait_for', 'get_ax_state']);
});

test('a cancelled mutation transport failure retains its unsafe delivery classification', async () => {
  const controller = new AbortController(); let rejectNative; let barrier;
  const native = new Promise((_, reject) => { rejectNative = reject; });
  controller.signal.waitUntil = (promise) => { barrier = promise; return promise; };
  const computer = transport((name, raw, options) => {
    assert.equal(name, 'click');
    assert.equal(options, undefined);
    return native;
  });
  const waiting = computer.appCall('click', { app: 'fixture', element: 1 }, { signal: controller.signal });
  const rejected = assert.rejects(waiting, (error) => error.sent === true && error.delivery === 'unknown' && error.retry === 'unsafe');
  controller.abort();
  assert.equal(barrier, native);
  rejectNative(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
  await rejected;
});
