/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  convertOutcomeToMcpResult,
  MAX_MODEL_IMAGES,
  MAX_MODEL_TEXT_TOKENS,
} from './output-adapter.js';
import {
  estimateTextTokenUnits,
  TOKEN_ESTIMATE_UNITS_PER_TOKEN,
} from './tokenizer.js';
import type { NodeReplExecOutcome } from './kernel-manager.js';

// 1x1 PNG.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function outcome(
  partial: Partial<NodeReplExecOutcome> & Pick<NodeReplExecOutcome, 'status'>,
): NodeReplExecOutcome {
  return {
    events: [],
    rawTextTruncated: false,
    imagesDropped: 0,
    stats: {
      durationMs: 1,
      generation: 1,
      pid: 123,
      droppedStaleFrames: 0,
      kernelReplaced: false,
      rawTextBytes: 0,
      imageCount: 0,
    },
    ...partial,
  } as NodeReplExecOutcome;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

describe('convertOutcomeToMcpResult', () => {
  it('keeps recovery details ahead of a large stack and inside the output budget', () => {
    const result = convertOutcomeToMcpResult(
      outcome({
        status: 'error',
        error: {
          name: 'ComputerUseError',
          message: 'Verification failed'.repeat(10000),
          code: 'verification_failed',
          details:
            "{ action: { performed: true }, verification: { reason: 'value_mismatch' } }",
          stack: 'stack '.repeat(10000),
        },
        events: [{ type: 'text', kind: 'write', text: 'noise '.repeat(10000) }],
      }),
    );
    const text = textOf(result);
    expect(result.isError).toBe(true);
    expect(text).toContain('Code: verification_failed');
    expect(text).toContain('performed: true');
    expect(text).toContain('value_mismatch');
    expect(estimateTextTokenUnits(text)).toBeLessThanOrEqual(
      MAX_MODEL_TEXT_TOKENS * TOKEN_ESTIMATE_UNITS_PER_TOKEN,
    );
  });

  it('keeps an under-budget advisory in its original position without exposing metadata', () => {
    const advisory = { items: ['Fixture: click uncertain'], count: 1 };
    const result = convertOutcomeToMcpResult(
      outcome({
        status: 'ok',
        advisory,
        events: [
          { type: 'text', kind: 'write', text: 'BEFORE\n' },
          {
            type: 'text',
            kind: 'write',
            text: 'Sent but not confirmed: Fixture: click uncertain.\n',
            advisory,
          },
          { type: 'text', kind: 'write', text: 'AX' },
        ],
      }),
    );
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'BEFORE\nSent but not confirmed: Fixture: click uncertain.\nAX',
      },
    ]);
  });

  it('reserves one merged advisory even when errors and image metadata exhaust the text budget', () => {
    const advisory = {
      items: Array.from(
        { length: 5 },
        (_, i) => `App ${i}: ` + '界'.repeat(500),
      ),
      count: 40,
    };
    const result = convertOutcomeToMcpResult(
      outcome({
        status: 'error',
        advisory,
        rawTextTruncated: true,
        error: {
          name: 'Error',
          message: 'failure '.repeat(10000),
          stack: 'stack '.repeat(10000),
        },
        events: Array.from({ length: MAX_MODEL_IMAGES }, () => ({
          type: 'image' as const,
          mimeType: 'image/png',
          data: PNG_BASE64,
          metadata: '界'.repeat(20000),
        })),
      }),
    );
    const text = textOf(result);
    expect(text.match(/Sent but not confirmed:/g)).toHaveLength(1);
    for (let i = 0; i < 5; i++) expect(text).toContain(`App ${i}:`);
    expect(text).toContain('and 35 more');
    expect(text).toContain('Observe before retrying');
    expect(estimateTextTokenUnits(text)).toBeLessThanOrEqual(
      MAX_MODEL_TEXT_TOKENS * TOKEN_ESTIMATE_UNITS_PER_TOKEN,
    );
  });

  it('protects delivery facts when image rejection diagnostics push output over budget', () => {
    const advisory = { items: ['Fixture: click uncertain'], count: 1 };
    const result = convertOutcomeToMcpResult(
      outcome({
        status: 'ok',
        advisory,
        events: [
          {
            type: 'text',
            kind: 'write',
            text: 'Sent but not confirmed: Fixture: click uncertain.',
            advisory,
          },
          { type: 'text', kind: 'write', text: 'x'.repeat(39000) },
          ...Array.from({ length: 64 }, () => ({
            type: 'image' as const,
            data: 'bad',
            mimeType: 'image/png',
          })),
        ],
      }),
    );
    expect(textOf(result)).toContain('Fixture: click uncertain');
    expect(textOf(result)).toContain('Observe before retrying');
    expect(estimateTextTokenUnits(textOf(result))).toBeLessThanOrEqual(
      MAX_MODEL_TEXT_TOKENS * TOKEN_ESTIMATE_UNITS_PER_TOKEN,
    );
  });

  it('maps write text to a text content block, no isError on ok', () => {
    const result = convertOutcomeToMcpResult(
      outcome({
        status: 'ok',
        events: [{ type: 'text', kind: 'write', text: 'hello' }],
      }),
    );
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('hello');
  });

  it('maps an image event to an image content block', () => {
    const result = convertOutcomeToMcpResult(
      outcome({
        status: 'ok',
        events: [{ type: 'image', data: PNG_BASE64, mimeType: 'image/png' }],
      }),
    );
    const image = result.content.find((b) => b.type === 'image') as
      | { type: 'image'; data: string; mimeType: string }
      | undefined;
    expect(image).toBeDefined();
    expect(image?.mimeType).toBe('image/png');
    expect(image?.data).toBe(PNG_BASE64);
  });

  it('places image metadata immediately before the image', () => {
    const result = convertOutcomeToMcpResult(
      outcome({
        status: 'ok',
        events: [
          {
            type: 'image',
            data: PNG_BASE64,
            mimeType: 'image/png',
            metadata: '{"width":1,"height":1,"coordinateSpace":"css-pixels"}',
          },
        ],
      }),
    );

    expect(result.content).toEqual([
      {
        type: 'text',
        text: '[image metadata] {"width":1,"height":1,"coordinateSpace":"css-pixels"}\n',
      },
      { type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
    ]);
  });

  it.each(['before', 'after'])(
    'budgets image metadata together with oversized prose %s the image',
    (position) => {
      const metadata = JSON.stringify({ label: '界'.repeat(20000) });
      const text = {
        type: 'text' as const,
        kind: 'write' as const,
        text: 'x'.repeat(500_000),
      };
      const image = {
        type: 'image' as const,
        data: PNG_BASE64,
        mimeType: 'image/png',
        metadata,
        tag: { source: 'cua.state' as const, app: 'fixture' },
      };
      const dropped: string[] = [];
      const result = convertOutcomeToMcpResult(
        outcome({
          status: 'ok',
          events: position === 'before' ? [text, image] : [image, text],
        }),
        (tags) => dropped.push(...tags.map((tag) => tag.app)),
      );
      const imageIndex = result.content.findIndex((b) => b.type === 'image');
      expect(imageIndex).toBeGreaterThanOrEqual(0);
      if (position === 'before') {
        expect(result.content[imageIndex - 1]).toMatchObject({
          type: 'text',
          text: expect.stringContaining('界'),
        });
      } else {
        expect(imageIndex).toBe(0);
      }
      expect(textOf(result)).toContain('earlier output omitted');
      expect(dropped).toEqual(['fixture']);
      expect(estimateTextTokenUnits(textOf(result))).toBeLessThanOrEqual(
        MAX_MODEL_TEXT_TOKENS * TOKEN_ESTIMATE_UNITS_PER_TOKEN,
      );
    },
  );

  it('retains images and newest metadata within the shared text budget', () => {
    const dropped: string[] = [];
    const result = convertOutcomeToMcpResult(
      outcome({
        status: 'ok',
        events: [
          { type: 'text', kind: 'write', text: 'old prose '.repeat(10000) },
          ...Array.from({ length: MAX_MODEL_IMAGES }, (_, index) => ({
            type: 'image' as const,
            data: PNG_BASE64,
            mimeType: 'image/png',
            metadata:
              `metadata ${index} ` + '界'.repeat(20000) + ` END ${index}`,
            tag: { source: 'cua.state' as const, app: String(index) },
          })),
          { type: 'text', kind: 'write', text: 'LATEST' },
        ],
      }),
      (tags) => dropped.push(...tags.map((tag) => tag.app)),
    );
    expect(
      result.content.filter((block) => block.type === 'image'),
    ).toHaveLength(MAX_MODEL_IMAGES);
    expect(textOf(result)).toContain(`END ${MAX_MODEL_IMAGES - 1}`);
    expect(textOf(result)).toContain('LATEST');
    expect(textOf(result)).not.toContain('old prose');
    expect(dropped).toHaveLength(MAX_MODEL_IMAGES);
    expect(estimateTextTokenUnits(textOf(result))).toBeLessThanOrEqual(
      MAX_MODEL_TEXT_TOKENS * TOKEN_ESTIMATE_UNITS_PER_TOKEN,
    );
  });

  it('keeps metadata paired only with images inside the output count limit', () => {
    const result = convertOutcomeToMcpResult(
      outcome({
        status: 'ok',
        events: Array.from({ length: MAX_MODEL_IMAGES + 1 }, (_, index) => ({
          type: 'image' as const,
          data: PNG_BASE64,
          mimeType: 'image/png',
          metadata: JSON.stringify({ index }),
        })),
      }),
    );
    for (let index = 0; index < MAX_MODEL_IMAGES; index++) {
      expect(result.content[index * 2]).toEqual({
        type: 'text',
        text: `[image metadata] ${JSON.stringify({ index: index + 1 })}\n`,
      });
      expect(result.content[index * 2 + 1]).toEqual({
        type: 'image',
        data: PNG_BASE64,
        mimeType: 'image/png',
      });
    }
    expect(textOf(result)).not.toContain(JSON.stringify({ index: 0 }));
    expect(textOf(result)).toContain('1 earlier image(s) omitted');
  });

  it('rejects an image whose bytes do not match the declared MIME', () => {
    const result = convertOutcomeToMcpResult(
      outcome({
        status: 'ok',
        events: [
          {
            type: 'image',
            data: PNG_BASE64,
            mimeType: 'image/jpeg',
            metadata: '{"rejected":true}',
          },
        ],
      }),
    );
    expect(result.content.some((b) => b.type === 'image')).toBe(false);
    expect(textOf(result)).toContain('image rejected');
    expect(textOf(result)).not.toContain('rejected":true');
  });

  it('folds non-ok status into isError with a leading status note', () => {
    const result = convertOutcomeToMcpResult(
      outcome({
        status: 'error',
        error: { name: 'TypeError', message: 'boom' },
      }),
    );
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('[node_repl error]');
    expect(text).toContain('boom');
  });

  it('marks timeout as isError and preserves the status label', () => {
    const result = convertOutcomeToMcpResult(
      outcome({
        status: 'timeout',
        error: { name: 'Error', message: 'exceeded' },
      }),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('[node_repl timeout]');
  });

  it('truncates very large text and appends a truncation notice', () => {
    const huge = 'x'.repeat(500_000); // ~2.5M token-units >> 200k budget
    const result = convertOutcomeToMcpResult(
      outcome({
        status: 'ok',
        events: [{ type: 'text', kind: 'write', text: huge }],
      }),
    );
    const text = textOf(result);
    expect(text.length).toBeLessThan(huge.length);
    expect(text).toContain('earlier output omitted');
  });

  it('surfaces a dropped-images notice', () => {
    const result = convertOutcomeToMcpResult(
      outcome({ status: 'ok', imagesDropped: 3 }),
    );
    expect(textOf(result)).toContain('3 image(s) dropped');
  });

  it('always returns at least one content block with real guidance', () => {
    const result = convertOutcomeToMcpResult(outcome({ status: 'ok' }));
    expect(result.content.length).toBeGreaterThanOrEqual(1);
    // Must not be an empty text block — several model APIs reject those, and it
    // gives the model no signal that the cell succeeded silently.
    const text = textOf(result);
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text).toMatch(/no output/i);
  });

  it('caps the number of emitted images and reports the omissions', () => {
    const events = Array.from({ length: 20 }, () => ({
      type: 'image' as const,
      data: PNG_BASE64,
      mimeType: 'image/png',
    }));
    const result = convertOutcomeToMcpResult(outcome({ status: 'ok', events }));
    const images = result.content.filter((b) => b.type === 'image');
    expect(images.length).toBe(8); // MAX_MODEL_IMAGES
    expect(textOf(result)).toMatch(/12 earlier image\(s\) omitted/);
  });

  it('rejects a single image above the per-image byte cap', () => {
    // A valid PNG header followed by >4 MiB of payload.
    const header = Buffer.from(PNG_BASE64, 'base64');
    const big = Buffer.concat([header, Buffer.alloc(5 * 1024 * 1024)]);
    const result = convertOutcomeToMcpResult(
      outcome({
        status: 'ok',
        events: [
          {
            type: 'image',
            data: big.toString('base64'),
            mimeType: 'image/png',
            metadata: '{"tooLarge":true}',
          },
        ],
      }),
    );
    expect(result.content.some((b) => b.type === 'image')).toBe(false);
    expect(textOf(result)).toMatch(/exceeds/);
    expect(textOf(result)).not.toContain('tooLarge');
  });

  it('keeps prose within the token budget when every notice fires', () => {
    const huge = 'x'.repeat(400_000);
    const events = [
      { type: 'text' as const, kind: 'write' as const, text: huge },
      ...Array.from({ length: 20 }, () => ({
        type: 'image' as const,
        data: PNG_BASE64,
        mimeType: 'image/png',
      })),
    ];
    const result = convertOutcomeToMcpResult(
      outcome({
        status: 'error',
        events,
        rawTextTruncated: true,
        imagesDropped: 2,
        error: { name: 'Error', message: 'boom' },
      }),
    );
    const units = estimateTextTokenUnits(textOf(result));
    expect(units).toBeLessThanOrEqual(
      MAX_MODEL_TEXT_TOKENS * TOKEN_ESTIMATE_UNITS_PER_TOKEN,
    );
    // All three notices present.
    expect(textOf(result)).toMatch(/earlier output omitted/);
    expect(textOf(result)).toMatch(/2 image\(s\) dropped/);
    expect(textOf(result)).toMatch(/omitted/);
  });

  it('does not split a surrogate pair when capping an error message', () => {
    const result = convertOutcomeToMcpResult(
      outcome({
        status: 'error',
        error: { name: 'Error', message: '😀'.repeat(20_000) },
      }),
    );
    const text = textOf(result);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
        i++;
      } else {
        // No lone low surrogate either.
        expect(code >= 0xdc00 && code <= 0xdfff).toBe(false);
      }
    }
  });
  it('retains latest text, the tail of the partially retained event, and original image order', () => {
    const oldTag = { source: 'cua.state' as const, app: 'old' };
    const partialTag = { source: 'cua.state' as const, app: 'partial' };
    const dropped: string[] = [];
    const result = convertOutcomeToMcpResult(
      outcome({
        status: 'ok',
        events: [
          { type: 'text', kind: 'write', text: 'OLD_STATE', tag: oldTag },
          {
            type: 'text',
            kind: 'write',
            text: 'EARLY_MARKER' + '😀'.repeat(100_000) + 'LATEST_TAIL',
            tag: partialTag,
          },
          { type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
          { type: 'text', kind: 'write', text: 'FINAL_STATE' },
        ],
      }),
      (tags) => dropped.push(...tags.map((tag) => tag.app)),
    );
    const text = textOf(result);
    expect(text.includes('OLD_STATE')).toBe(false);
    expect(text.includes('EARLY_MARKER')).toBe(false);
    expect(text.includes('LATEST_TAIL')).toBe(true);
    expect(text.includes('FINAL_STATE')).toBe(true);
    expect((result.content[0] as { text: string }).text.startsWith('…😀')).toBe(
      true,
    );
    expect(result.content[1].type).toBe('image');
    expect(dropped.sort()).toEqual(['old', 'partial']);
    expect(JSON.stringify(result).includes('cua.state')).toBe(false);
    expect(estimateTextTokenUnits(text)).toBeLessThanOrEqual(
      MAX_MODEL_TEXT_TOKENS * TOKEN_ESTIMATE_UNITS_PER_TOKEN,
    );
  });

  it('keeps under-budget mixed output byte-for-byte and reports no omitted tags', () => {
    const tag = { source: 'cua.state' as const, app: 'fixture' };
    let dropped: unknown;
    const result = convertOutcomeToMcpResult(
      outcome({
        status: 'ok',
        events: [
          { type: 'text', kind: 'write', text: 'state\n', tag },
          { type: 'image', data: PNG_BASE64, mimeType: 'image/png', tag },
          { type: 'text', kind: 'console', level: 'warn', text: 'done' },
        ],
      }),
      (tags) => {
        dropped = tags;
      },
    );
    expect(result.content).toEqual([
      { type: 'text', text: 'state\n' },
      { type: 'image', data: PNG_BASE64, mimeType: 'image/png' },
      { type: 'text', text: '[warn] done\n' },
    ]);
    expect(dropped).toEqual([]);
  });

  it('reports tags for rejected images and retains newest images under the byte budget', () => {
    const image = Buffer.concat([
      Buffer.from(PNG_BASE64, 'base64'),
      Buffer.alloc(3 * 1024 * 1024),
    ]).toString('base64');
    let dropped: string[] = [];
    const result = convertOutcomeToMcpResult(
      outcome({
        status: 'ok',
        events: [
          ...[0, 1, 2].map((index) => ({
            type: 'image' as const,
            data: image,
            mimeType: 'image/png',
            metadata: String(index),
            tag: { source: 'cua.state' as const, app: String(index) },
          })),
          {
            type: 'image',
            data: PNG_BASE64,
            mimeType: 'image/jpeg',
            tag: { source: 'cua.state', app: 'invalid' },
          },
        ],
      }),
      (tags) => {
        dropped = tags.map((tag) => tag.app);
      },
    );
    expect(
      result.content.filter((block) => block.type === 'image'),
    ).toHaveLength(2);
    expect(textOf(result).includes('[image metadata] 0')).toBe(false);
    expect(textOf(result).includes('[image metadata] 2')).toBe(true);
    expect(dropped.sort()).toEqual(['0', 'invalid']);
  });
});
