import type { ComputerUse, CallOptions } from './index.js';
import type { Browser, BrowserTab } from '@qwen-code/browser-use';
export interface RuntimeOutput {
  write(value: unknown, meta?: { tag?: { source: 'cua.state'; app: string }; advisory?: { items: string[]; count: number } }): void;
  emitImage(value: string | Uint8Array, meta?: { tag: { source: 'cua.state'; app: string } }): void | Promise<void>;
  readonly signal?: AbortSignal;
}
export interface ObservationOptions extends CallOptions {
  emit?: boolean;
  forceFull?: boolean;
  maxTextChars?: number;
  maxElements?: number;
  maxDepth?: number;
}
export type WaitMatch = { text: string } | { element: { role: string; name?: string } | { role?: string; name: string } };
export type WaitCondition = WaitMatch | { gone: WaitMatch } | { window: 'opened' | 'closed' } | { surface: 'menu' | 'sheet' | 'dialog' | 'alert' };
export interface ActionOptions extends CallOptions {
  waitFor?: WaitCondition;
  waitTimeoutMs?: number;
}
export interface WaitResult { met: boolean; elapsedMs: number }
export interface CombinedObservation { state: string; screenshot?: Uint8Array }
export type AppPoint = number | { x: number; y: number };
export interface RuntimeApp {
  readonly name: string;
  getAXState(options?: ObservationOptions): Promise<string>;
  getScreenshot(options?: CallOptions & { emit?: boolean }): Promise<Uint8Array>;
  getAXStateAndScreenshot(options?: ObservationOptions): Promise<CombinedObservation>;
  waitFor(condition: WaitCondition, options?: CallOptions & { timeoutMs?: number }): Promise<WaitResult>;
  click(point: AppPoint, options?: ActionOptions & { key?: string | string[]; button?: 'left' | 'right' | 'middle'; count?: number }): Promise<void>;
  doubleClick(point: AppPoint, options?: ActionOptions): Promise<void>;
  rightClick(point: AppPoint, options?: ActionOptions): Promise<void>;
  scroll(point: AppPoint, options: ActionOptions & { direction: 'up' | 'down' | 'left' | 'right'; amount?: number }): Promise<void>;
  drag(options: ActionOptions & { fromX: number; fromY: number; toX: number; toY: number }): Promise<void>;
  setValue(element: number, value: string, options?: ActionOptions): Promise<void>;
  performSecondaryAction(element: number, action: string, options?: ActionOptions): Promise<void>;
  typeText(text: string, options?: ActionOptions): Promise<void>;
  paste(text: string, options?: ActionOptions): Promise<void>;
  selectText(element: number, text: string, options?: ActionOptions): Promise<void>;
  pressKey(key: string, options?: ActionOptions & { modifiers?: string[] }): Promise<void>;
  hotkey(keys: string[], options?: ActionOptions): Promise<void>;
}
export interface RuntimeDesktop {
  getScreenshot(options?: CallOptions & { emit?: boolean }): Promise<Uint8Array>;
  click(point: { x: number; y: number }, options?: CallOptions & { key?: string | string[]; button?: 'left' | 'right' | 'middle'; count?: number }): Promise<void>;
  doubleClick(point: { x: number; y: number }, options?: CallOptions): Promise<void>;
  rightClick(point: { x: number; y: number }, options?: CallOptions): Promise<void>;
  scroll(point: { x: number; y: number }, options: CallOptions & { direction: 'up' | 'down' | 'left' | 'right'; amount?: number }): Promise<void>;
  drag(options: CallOptions & { fromX: number; fromY: number; toX: number; toY: number }): Promise<void>;
  typeText(text: string, options?: CallOptions): Promise<void>;
  pressKey(key: string, options?: CallOptions & { modifiers?: string[] }): Promise<void>;
  hotkey(keys: string[], options?: CallOptions): Promise<void>;
  keyDown(key: string, options?: CallOptions): Promise<void>;
  keyUp(key: string, options?: CallOptions): Promise<void>;
}
export interface CuaRuntime {
  readonly desktop: RuntimeDesktop;
  getBrowser(selector?: string | { id: string }): Promise<Browser>;
  getTab(reference: string | { url: string }, options?: { browser?: string | { id: string } }): Promise<BrowserTab>;
  createBrowserTab(browser?: string | { id: string }, url?: string): Promise<BrowserTab>;
  [Symbol.asyncDispose](): Promise<void>;
  rewriteDocumentation(): string;
  getState(options?: CallOptions & { emit?: boolean }): Promise<string>;
  getApp(selector: string, options?: CallOptions & { emit?: boolean }): Promise<RuntimeApp>;
}
export function createCua(output: RuntimeOutput, options?: { computer?: ComputerUse }): CuaRuntime;
