import { createCua, type RuntimeOutput } from '../runtime.js';
import { ComputerUse } from '../index.js';
async function useRuntime(output: RuntimeOutput) {
  const computer = await ComputerUse.create();
  const cua = createCua(output, { computer });
  const app = await cua.getApp('Editor', { emit: false });
  const text: string = await app.getAXState({ forceFull: true, maxTextChars: 20000, emit: false });
  const action: void = await app.click(1, { key: ['shift'] });
  await app.setValue(2, text);
  await app.typeText('你好');
  const screenshot: Uint8Array = await app.getScreenshot({ emit: false });
  const combined: { state: string; screenshot?: Uint8Array } = await app.getAXStateAndScreenshot();
  const desktopShot: Uint8Array = await cua.desktop.getScreenshot();
  const waited: { met: boolean; elapsedMs: number } = await app.waitFor({ gone: { element: { name: 'Save As' } } }, { timeoutMs: 1000 });
  await app.click(1, { waitFor: { text: 'Saved' }, waitTimeoutMs: 1000 });
  await app.hotkey(['CMD', 'S'], { waitFor: { surface: 'sheet' } });
  // @ts-expect-error At least one element matcher is required.
  await app.waitFor({ element: {} });
  // @ts-expect-error Screenshots no longer return text.
  const invalid: string = await app.getScreenshot();
  void [screenshot, combined, desktopShot, waited, invalid];
  await app.drag({ fromX: 1, fromY: 2, toX: 3, toY: 4 });
  // @ts-expect-error Native targeting belongs to the driver.
  await app.click(1, { pid: 1 });
  // @ts-expect-error App state is rendered text.
  text.elements;
  await computer.close();
  return action;
}
void useRuntime;
