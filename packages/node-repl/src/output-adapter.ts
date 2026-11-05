/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { NodeReplOutputTag } from './protocol.js';
import { createDebugLogger } from './debug-log.js';
import {
  estimateTextTokenUnits,
  TOKEN_ESTIMATE_UNITS_PER_TOKEN,
} from './tokenizer.js';
import type {
  NodeReplExecOutcome,
  NodeReplImageEvent,
  NodeReplTextEvent,
} from './kernel-manager.js';

export const MAX_MODEL_TEXT_TOKENS = 10_000;
export const MAX_ERROR_CHARS = 16 * 1024;
/** Per-image decoded-byte ceiling. */
export const MAX_MODEL_IMAGE_BYTES = 4 * 1024 * 1024;
/** Aggregate ceilings so one result cannot be tens of MB of JSON on stdout. */
export const MAX_MODEL_IMAGES = 8;
export const MAX_MODEL_IMAGE_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_MODEL_TEXT_UNITS =
  MAX_MODEL_TEXT_TOKENS * TOKEN_ESTIMATE_UNITS_PER_TOKEN;

const debugLogger = createDebugLogger('NODE_REPL');

const ALLOWED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** MCP content block union we produce (text + image). */
type TextBlock = { type: 'text'; text: string };
type ImageBlock = { type: 'image'; data: string; mimeType: string };
type OutputBlock = TextBlock | ImageBlock;

function sniffMime(bytes: Buffer): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function validateImage(
  image: NodeReplImageEvent,
): { ok: true; byteLength: number } | { ok: false; reason: string } {
  if (!ALLOWED_IMAGE_MIMES.has(image.mimeType)) {
    return { ok: false, reason: `unsupported image MIME ${image.mimeType}` };
  }
  if (
    image.data.length === 0 ||
    image.data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)
  ) {
    return { ok: false, reason: 'invalid base64 image payload' };
  }
  const bytes = Buffer.from(image.data, 'base64');
  if (bytes.length === 0) return { ok: false, reason: 'empty image payload' };
  if (bytes.length > MAX_MODEL_IMAGE_BYTES) {
    return {
      ok: false,
      reason: `image exceeds ${MAX_MODEL_IMAGE_BYTES} bytes`,
    };
  }
  const sniffed = sniffMime(bytes);
  if (sniffed !== image.mimeType) {
    return {
      ok: false,
      reason: `image bytes are ${sniffed ?? 'unknown'} but declared ${image.mimeType}`,
    };
  }
  return { ok: true, byteLength: bytes.length };
}

function renderText(event: NodeReplTextEvent): string {
  if (event.kind === 'console') {
    const level = event.level ?? 'log';
    const text =
      level === 'log' || level === 'info'
        ? event.text
        : `[${level}] ${event.text}`;
    return text.endsWith('\n') ? text : `${text}\n`;
  }
  if (event.kind === 'stdout' || event.kind === 'stderr') {
    const text = `[${event.kind}] ${event.text}`;
    return text.endsWith('\n') ? text : `${text}\n`;
  }
  return event.text;
}

function capChars(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = limit;
  // Never split a surrogate pair.
  const code = text.charCodeAt(end - 1);
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
}

function takeTextWithinTokenUnits(
  text: string,
  maxUnits: number,
  fromEnd = false,
): { text: string; units: number; complete: boolean } {
  if (maxUnits <= 0 || text.length === 0) {
    return { text: '', units: 0, complete: text.length === 0 };
  }
  const totalUnits = estimateTextTokenUnits(text);
  if (totalUnits <= maxUnits) {
    return { text, units: totalUnits, complete: true };
  }

  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (
      estimateTextTokenUnits(
        fromEnd ? text.slice(text.length - middle) : text.slice(0, middle),
      ) <= maxUnits
    ) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  let end = fromEnd ? text.length - low : low;
  if (
    low > 0 &&
    low < text.length &&
    text.charCodeAt(end - 1) >= 0xd800 &&
    text.charCodeAt(end - 1) <= 0xdbff &&
    text.charCodeAt(end) >= 0xdc00 &&
    text.charCodeAt(end) <= 0xdfff
  ) {
    end += fromEnd ? 1 : -1;
  }
  const prefix = fromEnd ? text.slice(end) : text.slice(0, end);
  return {
    text: prefix,
    units: estimateTextTokenUnits(prefix),
    complete: false,
  };
}

function capTextToTokenUnits(
  text: string,
  maxUnits: number,
): { text: string; truncated: boolean } {
  const taken = takeTextWithinTokenUnits(text, maxUnits);
  if (taken.complete) return { text: taken.text, truncated: false };
  const ellipsis = '…';
  const ellipsisUnits = estimateTextTokenUnits(ellipsis);
  if (maxUnits < ellipsisUnits) return { text: taken.text, truncated: true };
  const withRoom = takeTextWithinTokenUnits(text, maxUnits - ellipsisUnits);
  return { text: `${withRoom.text}${ellipsis}`, truncated: true };
}

/** Append text to the trailing text block, coalescing consecutive text. */
function pushText(blocks: OutputBlock[], text: string): void {
  if (text.length === 0) return;
  const previous = blocks.at(-1);
  if (previous && previous.type === 'text') {
    previous.text += text;
  } else {
    blocks.push({ type: 'text', text });
  }
}

/**
 * Converts a kernel execution outcome into an MCP CallToolResult:
 * text + image content blocks, with a ~10k-token text budget including image
 * metadata, and base64/MIME image validation. Status is folded
 * into `isError` plus a leading status text block
 * (MCP has no first-class error-type or display/model split).
 */
export function convertOutcomeToMcpResult(
  outcome: NodeReplExecOutcome,
  reportDroppedTags?: (tags: NodeReplOutputTag[]) => void,
): CallToolResult {
  const blocks: OutputBlock[] = [];
  const truncationNotice = `[node_repl: earlier output omitted near ${MAX_MODEL_TEXT_TOKENS} estimated tokens]\n`;
  const droppedImagesNotice =
    outcome.imagesDropped > 0
      ? `[${outcome.imagesDropped} image(s) dropped by the raw sanity limit]\n`
      : '';

  let errorText: string | undefined;
  let statusNotice = '';
  if (outcome.status !== 'ok') {
    const error = outcome.error ?? {
      name: 'Error',
      message: `node_repl execution ${outcome.status}`,
    };
    errorText = `${capChars(error.name, 1024)}: ${capChars(error.message, MAX_ERROR_CHARS)}`;
    if (error.code || error.details) {
      errorText = capChars(errorText, 4096);
      if (error.code) errorText += `\nCode: ${capChars(error.code, 256)}`;
      if (error.details)
        errorText += `\nDetails: ${capChars(error.details, 4096)}`;
    }
    if (outcome.status === 'error' && error.stack) {
      errorText += `\n${capChars(error.stack, 2048)}`;
    }
    // Preserve the 5-way status that MCP's boolean isError would otherwise lose.
    statusNotice = `[node_repl ${outcome.status}] ${errorText}\n`;
  }

  const advisory = outcome.advisory;
  const advisoryItems =
    advisory?.items.map(
      (item) =>
        capTextToTokenUnits(item, 300 * TOKEN_ESTIMATE_UNITS_PER_TOKEN).text,
    ) ?? [];
  const advisoryRest =
    advisory && advisory.count > advisoryItems.length
      ? `; and ${advisory.count - advisoryItems.length} more`
      : '';
  const advisoryNotice = advisory
    ? `Sent but not confirmed: ${advisoryItems.join('; ')}${advisoryRest}. Observe before retrying.\n`
    : '';
  const advisoryNoticeUnits = estimateTextTokenUnits(advisoryNotice);
  const noticeSeparators = '\n\n\n\n';
  // Reserve for a worst-case "images omitted" notice too, so emitting it cannot
  // push the result past the token budget (notices bypass the event text budget).
  const imagesOmittedNoticeReserve =
    '[999 earlier image(s) omitted: model image budget exceeded]\n';
  const fixedNoticeUnits = estimateTextTokenUnits(
    truncationNotice +
      droppedImagesNotice +
      imagesOmittedNoticeReserve +
      noticeSeparators,
  );
  const cappedStatusNotice = capTextToTokenUnits(
    statusNotice,
    Math.max(0, MAX_MODEL_TEXT_UNITS - fixedNoticeUnits - advisoryNoticeUnits),
  );
  const reservedTextUnits =
    fixedNoticeUnits + estimateTextTokenUnits(cappedStatusNotice.text);
  let remainingTextUnits = Math.max(
    0,
    MAX_MODEL_TEXT_UNITS - reservedTextUnits,
  );
  let textWasTruncated = cappedStatusNotice.truncated;
  let validImages = 0;
  let originalAdvisoryCount = 0;
  let originalTextUnits = 0;
  const imageVerdicts = new Map<
    NodeReplImageEvent,
    ReturnType<typeof validateImage>
  >();
  if (advisory) {
    for (const event of outcome.events) {
      if (event.type === 'text') {
        originalAdvisoryCount += event.advisory?.count ?? 0;
        if (originalTextUnits <= remainingTextUnits)
          originalTextUnits += estimateTextTokenUnits(renderText(event));
      } else {
        const verdict = validateImage(event);
        imageVerdicts.set(event, verdict);
        if (originalTextUnits <= remainingTextUnits) {
          originalTextUnits += estimateTextTokenUnits(
            !verdict.ok
              ? `[image rejected: ${verdict.reason}]`
              : event.metadata === undefined
                ? ''
                : `[image metadata] ${event.metadata}\n`,
          );
        }
      }
    }
  }
  const summarizeAdvisory =
    advisory &&
    (originalAdvisoryCount !== advisory.count ||
      outcome.rawTextTruncated ||
      originalTextUnits > remainingTextUnits);
  if (summarizeAdvisory) remainingTextUnits -= advisoryNoticeUnits;

  const droppedTags = new Map<string, NodeReplOutputTag>();
  const dropTag = (tag?: NodeReplOutputTag) => {
    if (tag) droppedTags.set(tag.app, tag);
  };
  const selectText = (text: string, tag?: NodeReplOutputTag): OutputBlock[] => {
    if (text.length === 0) return [];
    const taken = takeTextWithinTokenUnits(text, remainingTextUnits, true);
    if (taken.complete) {
      remainingTextUnits -= taken.units;
      return [{ type: 'text', text }];
    }
    textWasTruncated = true;
    dropTag(tag);
    const ellipsisUnits = estimateTextTokenUnits('…');
    const tail =
      remainingTextUnits >= ellipsisUnits
        ? '…' +
          takeTextWithinTokenUnits(
            text,
            remainingTextUnits - ellipsisUnits,
            true,
          ).text
        : '';
    remainingTextUnits = 0;
    return tail ? [{ type: 'text', text: tail }] : [];
  };

  const pushNotice = (notice: string) => {
    if (notice.length === 0) return;
    const previous = blocks.at(-1);
    if (previous && previous.type === 'text' && !previous.text.endsWith('\n')) {
      pushText(blocks, '\n');
    }
    pushText(blocks, notice);
  };

  // The status notice leads the output so the model sees the failure first.
  pushNotice(cappedStatusNotice.text);
  if (summarizeAdvisory) pushNotice(advisoryNotice);

  let imageBytesEmitted = 0;
  let imagesOverBudget = 0;

  const selected: OutputBlock[][] = new Array(outcome.events.length);
  for (let index = outcome.events.length - 1; index >= 0; index--) {
    const event = outcome.events[index];
    if (event.type === 'text') {
      if (summarizeAdvisory && event.advisory) {
        selected[index] = [];
        continue;
      }
      selected[index] = selectText(renderText(event), event.tag);
      continue;
    }
    const verdict = imageVerdicts.get(event) ?? validateImage(event);
    if (!verdict.ok) {
      selected[index] = selectText(`[image rejected: ${verdict.reason}]`);
      dropTag(event.tag);
      continue;
    }
    if (
      validImages >= MAX_MODEL_IMAGES ||
      imageBytesEmitted + verdict.byteLength > MAX_MODEL_IMAGE_TOTAL_BYTES
    ) {
      imagesOverBudget++;
      dropTag(event.tag);
      selected[index] = [];
      continue;
    }
    validImages++;
    imageBytesEmitted += verdict.byteLength;
    selected[index] = [
      ...(event.metadata === undefined
        ? []
        : selectText(`[image metadata] ${event.metadata}\n`, event.tag)),
      { type: 'image', data: event.data, mimeType: event.mimeType },
    ];
  }
  for (const selection of selected) {
    // Image metadata remains a separate block immediately before its image.
    if (selection.at(-1)?.type === 'image') blocks.push(...selection);
    else
      for (const block of selection)
        if (block.type === 'text') pushText(blocks, block.text);
  }
  reportDroppedTags?.([...droppedTags.values()]);

  if (textWasTruncated || outcome.rawTextTruncated) {
    debugLogger.debug(
      `[node-repl] model text truncated (generation=${outcome.stats.generation}, pid=${outcome.stats.pid ?? 'none'}, modelBudgetTokens=${MAX_MODEL_TEXT_TOKENS}, rawTextTruncated=${outcome.rawTextTruncated})`,
    );
    pushNotice(truncationNotice);
  }
  pushNotice(droppedImagesNotice);
  if (imagesOverBudget > 0) {
    pushNotice(
      `[${imagesOverBudget} earlier image(s) omitted: model image budget exceeded]\n`,
    );
  }

  const content: OutputBlock[] =
    blocks.length > 0
      ? blocks
      : [
          {
            type: 'text',
            text: '[node_repl ok — no output; use nodeRepl.write(value) to return a value]',
          },
        ];
  const result: CallToolResult = {
    content: content as CallToolResult['content'],
  };
  if (outcome.status !== 'ok') {
    result.isError = true;
  }
  return result;
}
