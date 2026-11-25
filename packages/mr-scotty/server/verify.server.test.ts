import { describe, expect, test, vi } from 'vitest';
import type {
  TransferOperation,
  TransferPlan,
  TransferReport,
} from './transfer.server';
import { verifyTransfer } from './verify.server';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const operation: TransferOperation = {
  sourceUrl: 'https://old.example/Plone/news/launch',
  destinationUrl: 'https://new.example/Plone/news/launch',
  destinationParentUrl: 'https://new.example/Plone/news',
  id: 'launch',
  title: 'Launch',
  uid: '0123456789abcdef0123456789abcdef',
  type: 'Document',
  kind: 'content',
  status: 'create',
  payload: {
    '@type': 'Document',
    id: 'launch',
    UID: '0123456789abcdef0123456789abcdef',
    title: 'Launch',
    subtitle: 'Beam me up',
    image: { data: 'AAAA', encoding: 'base64', filename: 'a.png' },
  },
};

const plan = {
  sourceUrl: operation.sourceUrl,
  sourceRootUrl: 'https://old.example/Plone',
  destinationUrl: 'https://new.example/Plone/news',
  destinationRootUrl: 'https://new.example/Plone',
  operations: [operation],
} as unknown as TransferPlan;

const report: TransferReport = {
  created: [
    {
      sourceUrl: operation.sourceUrl,
      destinationUrl: operation.destinationUrl,
      uid: operation.uid,
      kind: 'content',
    },
  ],
  replaced: [],
  updated: [],
  reused: [],
  skipped: [],
  warnings: [],
  destinationUrl: operation.destinationUrl,
};

/** The stored item, and whether anonymous visitors may read it. */
function servers(stored: Record<string, unknown>, publicHere = true) {
  return vi.fn(async (resource: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(resource));
    const anonymous = !new Headers(init?.headers).has('Authorization');
    if (url.origin === 'https://old.example') return json({ title: 'Launch' });
    if (anonymous && !publicHere) return json({}, 401);
    return json(stored);
  });
}

const good = {
  '@id': 'https://new.example/Plone/news/launch',
  UID: '01234567-89ab-cdef-0123-456789abcdef',
  title: 'Launch',
  subtitle: 'Beam me up',
  image: { size: 3, download: '@@images/image.png' },
  review_state: 'published',
};

const auth = { type: 'bearer' as const, token: 'secret' };

describe('verifyTransfer', () => {
  test('passes an item that arrived as it left', async () => {
    const result = await verifyTransfer(
      plan,
      report,
      auth,
      servers(good) as typeof fetch,
    );
    expect(result).toEqual({ checked: 1, passed: 1, items: [] });
  });

  test('flags an item anonymous visitors cannot see any more', async () => {
    const result = await verifyTransfer(
      plan,
      report,
      auth,
      servers({ ...good, review_state: 'private' }, false) as typeof fetch,
    );
    expect(result.items[0].problems).toEqual([
      expect.objectContaining({
        code: 'not_visible',
        severity: 'problem',
        message: expect.stringContaining('it is private'),
      }),
    ]);
  });

  test('flags another UID, file size, old-site URLs and lost fields', async () => {
    const result = await verifyTransfer(
      plan,
      report,
      auth,
      servers({
        ...good,
        UID: 'ffffffffffffffffffffffffffffffff',
        image: { size: 99 },
        subtitle: null,
        preview_image_link: { '@id': 'https://old.example/Plone/images/a' },
        blocks: { main: { value: [{ url: 'https://old.example/Plone/x' }] } },
        // Another host that merely starts the same is not the source.
        remoteUrl: 'https://old.example/Plone-archive',
      }) as typeof fetch,
    );
    expect(result.passed).toBe(0);
    expect(result.items[0].problems.map((problem) => problem.code)).toEqual([
      'uid_changed',
      'file_mismatch',
      'source_urls',
      'field_not_stored',
    ]);
    expect(result.items[0].problems[2].fields).toEqual([
      'preview_image_link.@id',
      'blocks.main.value[0].url',
    ]);
    expect(result.items[0].problems[3].fields).toEqual(['subtitle']);
  });

  test('reports an item the destination does not have', async () => {
    const result = await verifyTransfer(
      plan,
      report,
      auth,
      vi.fn(async () => json({}, 404)) as typeof fetch,
    );
    expect(result.items[0].problems).toEqual([
      expect.objectContaining({ code: 'missing' }),
    ]);
  });

  test('leaves out items the run did not write', async () => {
    const fetchImpl = vi.fn();
    const result = await verifyTransfer(
      plan,
      { ...report, created: [], reused: [operation.destinationUrl] },
      auth,
      fetchImpl as typeof fetch,
    );
    expect(result).toEqual({ checked: 0, passed: 0, items: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
