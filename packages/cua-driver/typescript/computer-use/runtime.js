import { Buffer } from 'node:buffer';
import { ComputerUse, ComputerUseError } from './index.js';
import { documentation } from './documentation.js';
import { createBrowserFacade } from './browser.js';

const CELL = Symbol.for('qwen.nodeRepl.cell');
const CELL_END = Symbol.for('qwen.nodeRepl.cellEnd');
const IMAGE_FILTER = Symbol.for('qwen.nodeRepl.imageFilter');

function imageBytes(image) {
  if (typeof image === 'string' && image.startsWith('data:')) {
    const match = /^data:[^;,]+;base64,(.*)$/s.exec(image);
    return match ? Buffer.from(match[1], 'base64') : undefined;
  }
  const value = image?.bytes ?? image;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return undefined;
}

function fingerprint(bytes) {
  let hash = 2166136261;
  const add = (start, end) => {
    for (let i = start; i < end; i++) hash = Math.imul(hash ^ bytes[i], 16777619);
  };
  add(0, Math.min(4096, bytes.length));
  add(Math.max(4096, bytes.length - 4096), bytes.length);
  return `${bytes.length}:${hash >>> 0}`;
}

export function createCua(runtime, { computer, browserModule } = {}) {
  const browser = createBrowserFacade(runtime, browserModule && (() => Promise.resolve(browserModule)));
  let closed = false;
  let connection = computer ? Promise.resolve(computer) : undefined;
  const handles = new WeakMap();
  const aliases = new Map();
  const forceFull = new Set();
  const shownImages = new Set();
  let cellId;
  let pending = [];
  let pendingCount = 0;
  const hasCellEnd = typeof runtime[CELL_END] === 'function';
  function beginCell() {
    const cell = runtime[CELL];
    if (!cell || cell.id === cellId) return;
    cellId = cell.id;
    pending = [];
    pendingCount = 0;
    shownImages.clear();
    for (const tag of cell.droppedTags ?? []) {
      if (tag.source === 'cua.state') forceFull.add(tag.app);
    }
  }
  function flush(observing = false) {
    beginCell();
    if (!pendingCount) return;
    const metadata = { items: pending, count: pendingCount };
    const items = pending.join('; ');
    const rest = pendingCount > pending.length ? `; and ${pendingCount - pending.length} more` : '';
    pending = [];
    pendingCount = 0;
    runtime.write(`Sent but not confirmed: ${items}${rest}. ${observing ? 'The state below shows their result.' : 'Observe before retrying.'}`, { advisory: metadata });
  }
  function boundedText(value, limit) {
    const text = String(value);
    if (text.length <= limit) return text;
    let end = limit - 1;
    if (text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--;
    return text.slice(0, end) + '…';
  }
  function addAdvisory(name, text) {
    pendingCount = Math.min(Number.MAX_SAFE_INTEGER, pendingCount + 1);
    if (pending.length < 5) pending.push(`${boundedText(name, 128)}: ${boundedText(text, 380)}`);
  }
  if (hasCellEnd) runtime[CELL_END](() => { flush(); shownImages.clear(); });
  const filterImage = (image, meta) => {
    beginCell();
    if (!runtime[CELL] && !hasCellEnd) return true;
    const bytes = imageBytes(image);
    if (!bytes) return true;
    const key = fingerprint(bytes);
    if (shownImages.has(key)) {
      runtime.write('(image already shown)');
      return false;
    }
    if (meta?.tag?.source === 'cua.state') shownImages.add(key);
    return true;
  };
  // The real kernel freezes nodeRepl; its internal filter preserves that boundary.
  if (typeof runtime[IMAGE_FILTER] === 'function') runtime[IMAGE_FILTER](filterImage);
  else if (typeof runtime.emitImage === 'function') {
    const emitImage = runtime.emitImage.bind(runtime);
    try {
      runtime.emitImage = (image, meta) => filterImage(image, meta) ? emitImage(image, meta) : undefined;
    } catch { /* Older frozen hosts keep their existing image behavior. */ }
  }
  const options = (value = {}) => {
    const cellSignal = runtime.signal;
    let signal = value.signal ?? cellSignal;
    if (value.signal && cellSignal && value.signal !== cellSignal) {
      signal = AbortSignal.any([cellSignal, value.signal]);
      if (typeof cellSignal.waitUntil === 'function') {
        Object.defineProperty(signal, 'waitUntil', { value: cellSignal.waitUntil.bind(cellSignal) });
      }
    }
    return { signal };
  };
  const parameters = (input = {}) => {
    const args = Object.fromEntries(Object.entries(input)
      .filter(([key]) => !['signal', 'emit', 'waitFor', 'waitTimeoutMs'].includes(key))
      .map(([key, value]) => [key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`), value]));
    if (input.waitFor !== undefined) {
      args.wait_for = { condition: input.waitFor, ...(input.waitTimeoutMs === undefined ? {} : { timeout_ms: input.waitTimeoutMs }) };
    }
    return args;
  };
  const point = (value) => typeof value === 'number' ? { element: value } : value;
  function guarded(operation, appName, native = true) {
    beginCell();
    const completion = (async () => {
      try { return await operation(); }
      catch (error) {
        if (appName && error.details?.advisory) addAdvisory(appName, error.details.advisory);
        flush(); throw error;
      }
    })();
    // Finish delivery bookkeeping before a cancelled cell reports its result.
    const signal = runtime.signal;
    return native && typeof signal?.waitUntil === 'function' ? signal.waitUntil(completion) : completion;
  }
  async function connected() {
    if (closed) throw new Error('Computer Use session is closed.');
    if (!connection) {
      connection = ComputerUse.create(options()).catch((error) => {
        connection = undefined;
        throw error;
      });
    }
    return connection;
  }
  async function display(result, emit = true, app) {
    if (!emit) return;
    flush(true);
    const meta = app ? { tag: { source: 'cua.state', app } } : undefined;
    if (result.text) runtime.write(result.text, meta);
    for (const image of result.images) {
      await runtime.emitImage(`data:${image.mimeType};base64,${image.dataBase64}`, meta);
    }
  }
  function observationValue(name, result) {
    if (name === 'get_ax_state') return result.text;
    const image = result.images[0];
    const screenshot = image ? new Uint8Array(Buffer.from(image.dataBase64, 'base64')) : undefined;
    if (name === 'get_ax_state_and_screenshot') return { state: result.text, ...(screenshot ? { screenshot } : {}) };
    if (!screenshot) throw new ComputerUseError('Screenshot unavailable.', { code: 'screenshot_unavailable' });
    return screenshot;
  }
  function advisory(result, name) {
    const text = result.structured?.advisory ?? (result.structured?.wait ? '' : result.text);
    if (text) addAdvisory(name, text);
    // Older hosts cannot signal cell completion, so never leave facts buffered.
    if (!hasCellEnd) flush();
  }
  function handle(app, id) {
    if (handles.has(app)) return handles.get(app);
    const observe = (name, input = {}) => guarded(async () => {
      const emit = input.emit !== false;
      const args = { ...parameters(input), deliver: emit };
      if (emit && name !== 'get_screenshot' && forceFull.has(id)) args.force_full = true;
      const result = await app.call(name, args, { ...options(input), readOnly: true });
      const value = observationValue(name, result);
      await display(result, emit, id);
      if (emit && name !== 'get_screenshot') forceFull.delete(id);
      return value;
    });
    const act = (name, args, input = {}) => guarded(async () => {
      advisory(await app.call(name, { ...parameters(input), ...args }, options(input)), app.name);
    }, app.name);
    const wrapped = Object.freeze({
      name: app.name,
      getAXState: (input) => observe('get_ax_state', input),
      getScreenshot: (input) => observe('get_screenshot', input),
      getAXStateAndScreenshot: (input) => observe('get_ax_state_and_screenshot', input),
      waitFor: (condition, input = {}) => guarded(async () => {
        const result = await app.call('wait_for', { condition, ...parameters(input) }, { ...options(input), readOnly: true });
        return { met: result.structured.met, elapsedMs: result.structured.elapsed_ms };
      }),
      click: (target, input) => act('click', point(target), input),
      doubleClick: (target, input) => act('double_click', point(target), input),
      rightClick: (target, input) => act('right_click', point(target), input),
      scroll: (target, input) => act('scroll', point(target), input),
      drag: (input) => act('drag', {}, input),
      performSecondaryAction: (element, action, input) => act('perform_secondary_action', { element, action }, input),
      setValue: (element, value, input) => act('set_value', { element, value }, input),
      typeText: (text, input) => act('type_text', { text }, input),
      paste: (text, input) => act('paste', { text }, input),
      selectText: (element, text, input) => act('select_text', { element, text }, input),
      pressKey: (key, input) => act('press_key', { key }, input),
      hotkey: (keys, input) => act('hotkey', { keys }, input),
    });
    handles.set(app, wrapped);
    return wrapped;
  }
  let desktopTail = Promise.resolve();
  function desktopCall(name, args, input = {}) {
    const next = desktopTail.catch(() => {}).then(() => guarded(async () => {
      const result = await (await connected()).appCall(name, { ...parameters(input), ...args, scope: 'desktop' }, options(input));
      if (name !== 'get_screenshot') { advisory(result, 'Desktop'); return; }
      const screenshot = observationValue(name, result);
      await display(result, input.emit !== false, 'desktop');
      return screenshot;
    }, 'Desktop'));
    desktopTail = next;
    return next;
  }
  const desktop = Object.freeze({
    getScreenshot: (input) => desktopCall('get_screenshot', {}, input),
    click: (target, input) => desktopCall('click', target, input),
    doubleClick: (target, input) => desktopCall('double_click', target, input),
    rightClick: (target, input) => desktopCall('right_click', target, input),
    scroll: (target, input) => desktopCall('scroll', target, input),
    drag: (input) => desktopCall('drag', {}, input),
    typeText: (text, input) => desktopCall('type_text', { text }, input),
    pressKey: (key, input) => desktopCall('press_key', { key }, input),
    hotkey: (keys, input) => desktopCall('hotkey', { keys }, input),
    keyDown: (key, input) => desktopCall('key_down', { key }, input),
    keyUp: (key, input) => desktopCall('key_up', { key }, input),
  });
  return Object.freeze({
    desktop,
    getBrowser: (...args) => guarded(() => browser.getBrowser(...args), undefined, false),
    getTab: (...args) => guarded(() => browser.getTab(...args), undefined, false),
    createBrowserTab: (...args) => guarded(() => browser.createBrowserTab(...args), undefined, false),
    async [Symbol.asyncDispose]() {
      if (closed) return;
      closed = true;
      try {
        await desktopTail.catch(() => {});
        if (connection) await (await connection.catch(() => undefined))?.close();
      } finally {
        flush();
        await browser.close();
      }
    },
    rewriteDocumentation() {
      beginCell();
      const text = documentation();
      runtime.write(text);
      return text;
    },
    getState: ({ emit = true, ...input } = {}) => guarded(async () => {
      const result = await (await connected()).getState(options(input));
      await display(result, emit);
      return result.text;
    }),
    getApp: (selector, input = {}) => guarded(async () => {
      const emit = input.emit !== false;
      const id = aliases.get(selector);
      const needsFull = emit && (id ? forceFull.has(id) : forceFull.size > 0);
      const { app, initial } = await (await connected()).getApp(selector, { ...options(input), deliver: emit, ...(needsFull ? { forceFull: true } : {}) });
      const canonical = initial.structured.app;
      aliases.set(selector, canonical);
      await display(initial, emit, canonical);
      if (emit) forceFull.delete(canonical);
      return handle(app, canonical);
    }),
  });
}
