import manifest from './interface.json' with { type: 'json' };

const platformGuidance = {
  darwin: 'macOS: use application names, bundle IDs or absolute application paths.',
  win32: 'Windows: use an exact application name or executable path. Input delivery is managed by the driver.',
  linux: 'Linux: only X11 applications are supported. The server must inherit DISPLAY, XAUTHORITY and desktop accessibility bus variables.',
};

export function documentation(platform = process.platform) {
  return [
    'Computer Use JavaScript runtime',
    'Global cua is already loaded. Reuse handles and bindings across calls; use assignment, var or block scope to avoid redeclaring const/let.',
    'Use await for every operation. Calls finish with a terminal result; timeout_ms defaults to 120000 (max 600000). Set it for long waits. A timeout cancels the cell; actions dispatched before it may have taken effect, so observe before retrying. js_reset discards the session.',
    'After context compaction, call cua.rewriteDocumentation() before continuing.',
    platformGuidance[platform] ?? 'This platform has no native Computer Use backend.',
    'Start with var app = await cua.getApp("Application"); the first call for a window displays its full AX state without a screenshot. Later getApp calls display only changes since you last saw it. Reuse the handle. cua.getState() displays application and window inventory.',
    'app.getAXState() returns and displays AX text: a diff against the state you last saw, or the full tree on first use, after a window change, or with forceFull:true.',
    'app.getScreenshot() returns image bytes and displays the image; app.getAXStateAndScreenshot() returns { state, screenshot } and displays both. If the screenshot is unavailable, state is still returned with a note.',
    'Use the short numeric element IDs from the latest observation of this window. Coordinates {x,y} are pixels of this window\'s latest screenshot. Take a new screenshot after a window resize, window switch, or display-scale change.',
    'Argument examples: await app.click(22) uses a numeric ID; await app.pressKey("Escape") presses one key; await app.hotkey(["CTRL", "RETURN"]) takes an array of keys. timeout_ms belongs to the js tool request, not app method options.',
    'Actions: await app.click(idOrPoint), doubleClick(idOrPoint), rightClick(idOrPoint), scroll(idOrPoint,{direction,amount}), drag({fromX,fromY,toX,toY}), setValue(id,value), typeText(text), pressKey(key), hotkey(keys). Actions return nothing when they succeed. If delivery could not be confirmed, one line lists those actions before the next displayed observation, or at the end of the call. Errors carry code, delivery and retry; retry only when retry is "safe". Do not parse message text.',
    '**Observe without displaying.** When your program needs UI state to decide something (find an ID or text, branch, check a result), pass { emit: false }: you get the complete current state (text, or image bytes) and nothing is displayed. Display only what the next decision needs: write a short summary with nodeRepl.write(...), or finish with one displayed getAXState(), which shows every change since you last looked.',
    '**Wait for changes instead of sleeping.** await app.waitFor({ text }) / ({ element: { role, name } }) / ({ gone: … }) / ({ window: "opened" }) / ({ surface: "dialog" }) returns { met, elapsedMs } without displaying anything. Attach it to an action — await app.click(12, { waitFor: { text: "Saved" } }) — so the baseline is taken before the click. Do not use setTimeout to wait for the UI.',
    'For an explicit desktop task, await cua.desktop.getScreenshot() returns image bytes and displays the image; then use cua.desktop.click({x,y}), doubleClick, rightClick, scroll({x,y},{direction,amount}) or drag({fromX,fromY,toX,toY}). Coordinates are pixels in the latest primary-display image. Desktop input operates the visible foreground desktop and can move the real pointer.',
    'Desktop keyboard: typeText(text), pressKey(key), hotkey(keys). To hold a key use try { await cua.desktop.keyDown("shift"); await cua.desktop.click({x,y}); } finally { await cua.desktop.keyUp("shift"); }. Held keys belong to this session; use keyDown/keyUp for chords while holding keys. Release them before text, normal chords, explicit click modifiers or app input. Session end/reset releases owned keys.',
    'Browser: var browser = await cua.getBrowser("Chrome") selects an exact browser ID or name and displays its documentation and tabs. var tab = await cua.getTab(tabId,{browser:"Chrome"}) or cua.getTab({url},{browser:"Chrome"}) selects one tab and displays its DOM snapshot. cua.createBrowserTab("Chrome",url) opens a tab and displays its state. Browser tabs keep their browser-use observation behavior; app emit/delivery and waitFor options do not apply to them. These return the repository browser-use SDK handles unchanged: use browser.tabs/user and tab.playwright/cua/dom_cua. Read the selected browser documentation before acting. Browser selection requires the existing Qwen browser extension connection.',
    ...manifest.tools.map((tool) => `${['getState', 'getApp'].includes(tool.method) || tool.method.startsWith('desktop.') ? 'cua' : 'app'}.${tool.method}: ${tool.description}`),
    'Do not wrap displayed observations in nodeRepl.write or emitImage: they display themselves. For other output use nodeRepl.write(value) and await nodeRepl.emitImage(bytesOrDataUrl). Plain expressions produce no output.',
    'Imports use await import(); Node modules run with the server permissions. nodeRepl.cwd, homeDir, tmpDir and signal are available. A timeout stops JS continuation; actions already dispatched are never automatically replayed.',
    'Batch deterministic actions and the final getAXState() into one call. If a displayed getAXState() reports no change, do not repeat it without an intervening action. Once the requested result is visible, stop and respond.',
    'Example: var app = await cua.getApp("TextEdit"); await app.hotkey(["CMD", "S"], { waitFor: { surface: "sheet" } });',
    'var sheet = await app.getAXState({ emit: false }); // Find the Save As field without displaying.',
    'var field = Number(sheet.match(/\\[(\\d+)\\] text field "Save As"/)?.[1]); await app.setValue(field, "report.txt");',
    'await app.pressKey("Return", { waitFor: { gone: { text: "Save As" } } }); await app.getAXState();',
  ].join('\n');
}
