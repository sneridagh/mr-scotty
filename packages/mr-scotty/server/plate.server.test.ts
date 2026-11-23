import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import config from '@plone/registry';
import { canConvertToPlate, convertToPlate } from './plate.server';

type Args = Record<string, unknown> & {
  block?: Record<string, unknown>;
  content?: Record<string, unknown>;
  value?: Array<Record<string, unknown>>;
};

/**
 * Stand-ins for the conversion functions Aurora registers: the title block,
 * blocks that carry a Slate `value`, and the image block as a Plone block.
 */
function registerAuroraLikeUtilities() {
  config.registerUtility({
    name: 'title',
    type: 'somersaultBlockMigration',
    method: ({ block, content }: Args) =>
      block?.['@type'] === 'title'
        ? [{ type: 'title', children: [{ text: String(content?.title) }] }]
        : [],
  });
  config.registerUtility({
    name: 'value',
    type: 'somersaultBlockMigration',
    method: ({ block }: Args) =>
      Array.isArray(block?.value) ? block.value : [],
  });
  config.registerUtility({
    name: 'image',
    type: 'somersaultBlockMigration',
    method: ({ block }: Args) =>
      block?.['@type'] === 'image'
        ? [{ ...block, type: 'ploneBlock', children: [{ text: '' }] }]
        : [],
  });
  config.registerUtility({
    name: 'links',
    type: 'somersaultMigration',
    method: ({ value }: Args) =>
      (value ?? []).map((node) =>
        node.type === 'link' ? { ...node, type: 'a' } : node,
      ),
  });
}

let saved: unknown;
beforeEach(() => {
  saved = config.utilities;
  config.utilities = {};
});
afterEach(() => {
  config.utilities = saved as typeof config.utilities;
});

describe('convertToPlate', () => {
  test('turns classic blocks into one Plate document in main', () => {
    registerAuroraLikeUtilities();
    const payload = {
      title: 'Launch',
      blocks: {
        t: { '@type': 'title' },
        s: {
          '@type': 'slate',
          value: [{ type: 'link', children: [{ text: 'Read' }] }],
        },
        i: { '@type': 'image', url: 'https://new.example/Plone/hero.png' },
        g: { '@type': 'gridBlock', blocks: {} },
      },
      blocks_layout: { items: ['t', 's', 'i', 'g'] },
    };

    const { payload: converted, droppedBlocks } = convertToPlate(payload);

    expect(converted.blocks).toEqual({
      main: {
        '@type': 'plate',
        value: [
          { type: 'title', children: [{ text: 'Launch' }] },
          { type: 'a', children: [{ text: 'Read' }] },
          {
            '@type': 'image',
            url: 'https://new.example/Plone/hero.png',
            type: 'ploneBlock',
            children: [{ text: '' }],
          },
        ],
      },
    });
    expect(converted.blocks_layout).toEqual({ items: [] });
    expect(droppedBlocks).toEqual(['gridBlock']);
    // The input is left alone.
    expect(Object.keys(payload.blocks)).toEqual(['t', 's', 'i', 'g']);
  });

  test('starts a page without a title block with a title node', () => {
    registerAuroraLikeUtilities();
    const { payload } = convertToPlate({
      title: 'Launch',
      blocks: { s: { '@type': 'slate', value: [{ type: 'p' }] } },
      blocks_layout: { items: ['s'] },
    });
    expect(
      (payload.blocks as Record<string, { value: unknown[] }>).main.value,
    ).toEqual([
      { type: 'title', children: [{ text: 'Launch' }] },
      { type: 'p' },
    ]);
  });

  test('keeps a page that already is a Plate document', () => {
    registerAuroraLikeUtilities();
    const main = { '@type': 'plate', value: [{ type: 'title' }] };
    const { payload, droppedBlocks } = convertToPlate({
      blocks: { main, old: { '@type': 'slate', value: [] } },
      blocks_layout: { items: ['old'] },
    });
    expect(payload.blocks).toEqual({ main });
    expect(payload.blocks_layout).toEqual({ items: [] });
    expect(droppedBlocks).toEqual([]);
  });

  test('leaves content without blocks alone', () => {
    registerAuroraLikeUtilities();
    const { payload } = convertToPlate({ title: 'A file' });
    expect(payload).toEqual({ title: 'A file' });
  });

  test('knows whether the server has conversion functions', () => {
    expect(canConvertToPlate()).toBe(false);
    registerAuroraLikeUtilities();
    expect(canConvertToPlate()).toBe(true);
  });
});
