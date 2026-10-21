import { describe, expect, test, vi } from 'vitest';
import {
  assertHostAllowed,
  createContentPayload,
  createTransferPlan,
  executeTransferPlan,
  readSsrfPolicyFromEnv,
  TransferError,
  type TransferInput,
} from './transfer.server';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const input: TransferInput = {
  sourceUrl: 'https://old.example/Plone/news/launch',
  destinationUrl: 'https://new.example/Plone/archive',
  sourceAuth: { type: 'anonymous' },
  destinationAuth: { type: 'bearer', token: 'destination-secret' },
};

const sourceRoot = {
  '@id': 'https://old.example/Plone',
  '@type': 'Plone Site',
  UID: 'root-source',
  id: 'Plone',
  title: 'Old site',
  is_folderish: true,
};

const destination = {
  '@id': 'https://new.example/Plone/archive',
  '@type': 'Folder',
  UID: 'archive-uid',
  id: 'archive',
  title: 'Archive',
  is_folderish: true,
  '@components': {
    navroot: { navroot: { '@id': 'https://new.example/Plone' } },
  },
};

const news = {
  '@id': 'https://old.example/Plone/news',
  '@type': 'Folder',
  UID: 'news-uid',
  id: 'news',
  title: 'News',
  is_folderish: true,
};

const launch = {
  '@id': 'https://old.example/Plone/news/launch',
  '@type': 'Document',
  UID: 'launch-uid',
  id: 'launch',
  title: 'Launch',
  description: 'Beam me up',
  blocks: { text: { '@type': 'slate', value: [] } },
  blocks_layout: { items: ['text'] },
  is_folderish: false,
  review_state: 'published',
  parent: { '@id': 'https://old.example/Plone/news' },
  '@components': {
    navroot: { navroot: sourceRoot },
  },
};

function canonicalRequestPath(url: URL) {
  return url.pathname.replace('/++api++', '') || '/';
}

function successfulFetch() {
  return vi.fn(async (resource: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(resource));
    const path = canonicalRequestPath(url);
    const method = init?.method || 'GET';

    if (method === 'POST') {
      return json(
        {
          ...(JSON.parse(String(init?.body)) as Record<string, unknown>),
          '@id': url.toString(),
        },
        201,
      );
    }
    if (url.origin === 'https://old.example' && path.endsWith('/launch')) {
      return json(launch);
    }
    if (url.origin === 'https://old.example' && path.endsWith('/news')) {
      return json(news);
    }
    if (
      url.origin === 'https://new.example' &&
      path === '/Plone/archive' &&
      url.searchParams.get('expand') === 'navroot'
    ) {
      return json(destination);
    }
    if (path.endsWith('/@search')) return json({ items: [], items_total: 0 });
    if (url.origin === 'https://new.example')
      return json({ error: { message: 'Not found' } }, 404);

    throw new Error(`Unexpected request: ${method} ${url}`);
  });
}

describe('createTransferPlan', () => {
  test('preserves the source-relative path and plans parents before content', async () => {
    const fetchImpl = successfulFetch();
    const plan = await createTransferPlan(input, fetchImpl as typeof fetch);

    expect(plan.sourceRelativePath).toBe('/news/launch');
    expect(plan.destinationPath).toBe('/Plone/archive/news/launch');
    expect(plan.operations).toMatchObject([
      {
        id: 'news',
        uid: 'news-uid',
        kind: 'placeholder',
        status: 'create',
        destinationUrl: 'https://new.example/Plone/archive/news',
        payload: {
          '@type': 'Document',
          id: 'news',
          UID: 'news-uid',
        },
      },
      {
        id: 'launch',
        uid: 'launch-uid',
        kind: 'content',
        status: 'create',
        destinationUrl: 'https://new.example/Plone/archive/news/launch',
        payload: {
          '@type': 'Document',
          id: 'launch',
          UID: 'launch-uid',
          description: 'Beam me up',
        },
      },
    ]);

    const searchRequests = fetchImpl.mock.calls.filter(([resource]) =>
      String(resource).includes('/@search'),
    );
    expect(searchRequests).toHaveLength(2);
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      'https://old.example/++api++/Plone/news/launch?expand=navroot',
    );
    expect(
      searchRequests.every(
        ([, request]) =>
          new Headers(request?.headers).get('Authorization') ===
          'Bearer destination-secret',
      ),
    ).toBe(true);
    expect(
      fetchImpl.mock.calls.every(
        ([resource]) =>
          new URL(String(resource)).pathname
            .split('/')
            .filter((segment) => segment === '++api++').length === 1,
      ),
    ).toBe(true);
  });

  test('accepts an existing API traversal segment without duplicating it', async () => {
    const fetchImpl = successfulFetch();
    const plan = await createTransferPlan(
      {
        ...input,
        sourceUrl: 'https://old.example/Plone/++api++/news/launch',
        destinationUrl: 'https://new.example/Plone/++api++/archive',
      },
      fetchImpl as typeof fetch,
    );

    expect(plan.sourceUrl).toBe('https://old.example/Plone/news/launch');
    expect(plan.destinationUrl).toBe('https://new.example/Plone/archive');
    expect(
      fetchImpl.mock.calls.every(
        ([resource]) =>
          new URL(String(resource)).pathname
            .split('/')
            .filter((segment) => segment === '++api++').length === 1,
      ),
    ).toBe(true);
  });

  test('supports Plone sites mounted below the server root', async () => {
    const backendFetch = successfulFetch();
    const fetchImpl = vi.fn(
      async (resource: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(resource));
        if (url.pathname.startsWith('/++api++/Plone')) {
          return json({ error: { message: 'Not found' } }, 404);
        }
        return backendFetch(resource, init);
      },
    );

    const plan = await createTransferPlan(input, fetchImpl as typeof fetch);

    expect(String(fetchImpl.mock.calls[1][0])).toBe(
      'https://old.example/Plone/++api++/news/launch?expand=navroot',
    );
    expect(plan.destinationRootUrl).toBe('https://new.example/Plone');
  });

  test('fails preflight when the final destination path exists', async () => {
    const fetchImpl = successfulFetch();
    fetchImpl.mockImplementation(async (resource, init) => {
      const url = new URL(String(resource));
      if (canonicalRequestPath(url) === '/Plone/archive/news/launch') {
        return json({ ...launch, '@id': url.toString() });
      }
      return successfulFetch()(resource, init);
    });

    await expect(
      createTransferPlan(input, fetchImpl as typeof fetch),
    ).rejects.toMatchObject({
      code: 'path_conflict',
      status: 409,
    });
  });

  test('plans an existing final path for replacement when overwrite is enabled', async () => {
    const fetchImpl = successfulFetch();
    fetchImpl.mockImplementation(async (resource, init) => {
      const url = new URL(String(resource));
      const method = init?.method || 'GET';
      if (
        method === 'GET' &&
        canonicalRequestPath(url) === '/Plone/archive/news/launch'
      ) {
        return json({ ...launch, '@id': url.toString() });
      }
      return successfulFetch()(resource, init);
    });

    const plan = await createTransferPlan(
      { ...input, overwrite: true },
      fetchImpl as typeof fetch,
    );

    expect(plan.overwrite).toBe(true);
    expect(plan.operations.at(-1)).toMatchObject({
      status: 'replace',
      destinationUrl: 'https://new.example/Plone/archive/news/launch',
    });
  });

  test('fails preflight when a UUID already exists elsewhere', async () => {
    const fetchImpl = successfulFetch();
    fetchImpl.mockImplementation(async (resource, init) => {
      const url = new URL(String(resource));
      if (
        canonicalRequestPath(url).endsWith('/@search') &&
        url.searchParams.get('UID') === 'launch-uid'
      ) {
        return json({
          items: [{ '@id': 'https://new.example/Plone/other-launch' }],
          items_total: 1,
        });
      }
      return successfulFetch()(resource, init);
    });

    await expect(
      createTransferPlan(input, fetchImpl as typeof fetch),
    ).rejects.toMatchObject({
      code: 'uid_conflict',
      status: 409,
    });
  });
});

describe('executeTransferPlan', () => {
  test('creates structural parents before the selected content', async () => {
    const fetchImpl = successfulFetch();
    const plan = await createTransferPlan(input, fetchImpl as typeof fetch);
    fetchImpl.mockClear();

    const report = await executeTransferPlan(
      plan,
      input.destinationAuth,
      fetchImpl as typeof fetch,
    );

    const posts = fetchImpl.mock.calls.filter(
      ([, init]) => init?.method === 'POST',
    );
    expect(posts.map(([resource]) => String(resource))).toEqual([
      'https://new.example/Plone/++api++/archive',
      'https://new.example/Plone/++api++/archive/news',
    ]);
    expect(report.created).toHaveLength(2);
    expect(report.destinationUrl).toBe(
      'https://new.example/Plone/archive/news/launch',
    );
  });

  test('deletes and recreates replaced content at the same path', async () => {
    const fetchImpl = successfulFetch();
    fetchImpl.mockImplementation(async (resource, init) => {
      const url = new URL(String(resource));
      const method = init?.method || 'GET';
      if (
        method === 'GET' &&
        canonicalRequestPath(url) === '/Plone/archive/news/launch'
      ) {
        return json({ ...launch, '@id': url.toString() });
      }
      if (method === 'DELETE') return new Response(null, { status: 204 });
      return successfulFetch()(resource, init);
    });

    const plan = await createTransferPlan(
      { ...input, overwrite: true },
      fetchImpl as typeof fetch,
    );
    fetchImpl.mockClear();

    const report = await executeTransferPlan(
      plan,
      input.destinationAuth,
      fetchImpl as typeof fetch,
    );

    const deletes = fetchImpl.mock.calls.filter(
      ([, request]) => request?.method === 'DELETE',
    );
    expect(deletes.map(([resource]) => String(resource))).toEqual([
      'https://new.example/Plone/archive/news/launch',
    ]);
    expect(report.replaced).toHaveLength(1);
    expect(report.created).toHaveLength(1);
  });

  test('returns a partial report instead of throwing when an operation fails', async () => {
    const fetchImpl = successfulFetch();
    const plan = await createTransferPlan(input, fetchImpl as typeof fetch);

    const execFetch = vi.fn(
      async (resource: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(resource));
        const method = init?.method || 'GET';
        // Creating `launch` (POST into its parent `archive/news`) fails.
        if (
          method === 'POST' &&
          canonicalRequestPath(url).endsWith('/archive/news')
        ) {
          return json({ error: { message: 'boom' } }, 500);
        }
        return successfulFetch()(resource, init);
      },
    );

    const report = await executeTransferPlan(
      plan,
      input.destinationAuth,
      execFetch as typeof fetch,
    );

    // The structural parent was created before the failure; nothing after it.
    expect(report.created).toHaveLength(1);
    expect(report.created[0].destinationUrl).toBe(
      'https://new.example/Plone/archive/news',
    );
    expect(report.failed).toMatchObject({
      destinationUrl: 'https://new.example/Plone/archive/news/launch',
      code: 'restapi_500',
    });
  });

  test('restores the original content when a replace recreate fails', async () => {
    const existingLaunch = {
      ...launch,
      '@id': 'https://new.example/Plone/archive/news/launch',
      title: 'Old destination launch',
    };
    const planFetch = successfulFetch();
    planFetch.mockImplementation(async (resource, init) => {
      const url = new URL(String(resource));
      if (
        (init?.method || 'GET') === 'GET' &&
        canonicalRequestPath(url) === '/Plone/archive/news/launch'
      ) {
        return json({ ...existingLaunch, '@id': url.toString() });
      }
      return successfulFetch()(resource, init);
    });
    const plan = await createTransferPlan(
      { ...input, overwrite: true },
      planFetch as typeof fetch,
    );

    const posts: Array<Record<string, unknown>> = [];
    const execFetch = vi.fn(
      async (resource: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(resource));
        const method = init?.method || 'GET';
        const path = canonicalRequestPath(url);
        if (method === 'GET' && path === '/Plone/archive/news/launch') {
          return json({ ...existingLaunch, '@id': url.toString() });
        }
        if (method === 'DELETE') return new Response(null, { status: 204 });
        if (method === 'POST' && path.endsWith('/archive/news')) {
          const body = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          posts.push(body);
          // The incoming `launch` (title "Launch") fails; the restore succeeds.
          if (body.title === 'Launch') {
            return json({ error: { message: 'recreate failed' } }, 500);
          }
          return json({ ...body, '@id': url.toString() }, 201);
        }
        return successfulFetch()(resource, init);
      },
    );

    const report = await executeTransferPlan(
      plan,
      input.destinationAuth,
      execFetch as typeof fetch,
    );

    expect(report.failed).toMatchObject({
      destinationUrl: 'https://new.example/Plone/archive/news/launch',
      restored: true,
    });
    // The rollback re-created the captured original, preserving its UID.
    expect(
      posts.some(
        (body) =>
          body.title === 'Old destination launch' && body.UID === 'launch-uid',
      ),
    ).toBe(true);
  });
});

describe('SSRF policy', () => {
  function thrown(fn: () => void): TransferError {
    try {
      fn();
    } catch (error) {
      return error as TransferError;
    }
    throw new Error('expected the call to throw');
  }

  test('reads the allowlist and private-network flag from the environment', () => {
    expect(readSsrfPolicyFromEnv({})).toEqual({
      allowedHosts: undefined,
      blockPrivateNetwork: false,
    });
    expect(
      readSsrfPolicyFromEnv({
        MR_SCOTTY_ALLOWED_HOSTS: 'a.example, B.example ',
        MR_SCOTTY_BLOCK_PRIVATE_NETWORK: 'true',
      }),
    ).toEqual({
      allowedHosts: ['a.example', 'b.example'],
      blockPrivateNetwork: true,
    });
  });

  test('an allowlist refuses hosts that are not on it', () => {
    const policy = { allowedHosts: ['good.example'] };
    expect(() =>
      assertHostAllowed(
        new URL('https://good.example/x'),
        'Source URL',
        policy,
      ),
    ).not.toThrow();
    expect(
      thrown(() =>
        assertHostAllowed(
          new URL('https://evil.example/x'),
          'Source URL',
          policy,
        ),
      ),
    ).toMatchObject({ code: 'host_not_allowed', status: 403 });
  });

  test('blockPrivateNetwork refuses loopback, private and link-local hosts', () => {
    const policy = { blockPrivateNetwork: true };
    for (const host of [
      '127.0.0.1',
      '10.0.0.5',
      '192.168.1.1',
      '172.16.0.1',
      '169.254.169.254',
      'localhost',
      'db.internal',
      '[::1]',
    ]) {
      expect(
        thrown(() =>
          assertHostAllowed(
            new URL(`http://${host}/x`),
            'Destination URL',
            policy,
          ),
        ),
      ).toMatchObject({ code: 'private_network_blocked', status: 403 });
    }
    expect(() =>
      assertHostAllowed(
        new URL('https://public.example/x'),
        'Destination URL',
        policy,
      ),
    ).not.toThrow();
  });

  test('createTransferPlan refuses a disallowed host before any request', async () => {
    const fetchImpl = vi.fn();
    await expect(
      createTransferPlan(input, fetchImpl as unknown as typeof fetch, {
        allowedHosts: ['only.example'],
      }),
    ).rejects.toMatchObject({ code: 'host_not_allowed' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('createContentPayload', () => {
  test('keeps writable custom fields and strips response-only fields', () => {
    expect(
      createContentPayload(
        {
          ...launch,
          custom_field: 'custom value',
          image: { download: '/image/@@download/image' },
        },
        new URL(input.sourceUrl),
      ),
    ).toMatchObject({
      '@type': 'Document',
      UID: 'launch-uid',
      id: 'launch',
      custom_field: 'custom value',
      blocks: launch.blocks,
    });
    expect(
      createContentPayload(launch, new URL(input.sourceUrl)),
    ).not.toHaveProperty('review_state');
    expect(
      createContentPayload(launch, new URL(input.sourceUrl)),
    ).not.toHaveProperty('@components');
  });
});

describe('image resources', () => {
  test('downloads image fields and posts them as base64 upload data', async () => {
    const imageLaunch = {
      ...launch,
      image: {
        download:
          'https://old.example/Plone/news/launch/@@images/image/original.jpg',
        'content-type': 'image/jpeg',
        filename: 'launch.jpg',
      },
    };
    const backendFetch = successfulFetch();
    const fetchImpl = vi.fn(
      async (resource: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(resource));
        if (url.pathname.includes('/@@images/')) {
          return new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { 'Content-Type': 'image/jpeg' },
          });
        }
        if (
          url.origin === 'https://old.example' &&
          canonicalRequestPath(url).endsWith('/launch')
        ) {
          return json(imageLaunch);
        }
        return backendFetch(resource, init);
      },
    );

    const plan = await createTransferPlan(input, fetchImpl as typeof fetch);
    const leaf = plan.operations.find((operation) =>
      operation.sourceUrl.endsWith('/launch'),
    );

    expect(leaf?.payload?.image).toEqual({
      data: 'AQID',
      encoding: 'base64',
      filename: 'launch.jpg',
      'content-type': 'image/jpeg',
    });
  });

  test('beams image-block references before the content that uses them', async () => {
    const referencedImage = {
      '@id': 'https://old.example/Plone/news/hero',
      '@type': 'Image',
      UID: 'hero-uid',
      id: 'hero',
      title: 'Hero',
      is_folderish: false,
      image: {
        download:
          'https://old.example/Plone/news/hero/@@images/image/original.jpg',
        'content-type': 'image/jpeg',
        filename: 'hero.jpg',
      },
      '@components': { navroot: { navroot: sourceRoot } },
    };
    const imageBlockLaunch = {
      ...launch,
      blocks: {
        image: {
          '@type': 'image',
          url: 'https://old.example/Plone/news/hero',
        },
      },
    };
    const backendFetch = successfulFetch();
    const fetchImpl = vi.fn(
      async (resource: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(resource));
        const path = canonicalRequestPath(url);
        if (url.pathname.includes('/@@images/')) {
          return new Response(new Uint8Array([4, 5, 6]), {
            status: 200,
            headers: { 'Content-Type': 'image/jpeg' },
          });
        }
        if (url.origin === 'https://old.example' && path.endsWith('/launch'))
          return json(imageBlockLaunch);
        if (url.origin === 'https://old.example' && path.endsWith('/hero'))
          return json(referencedImage);
        return backendFetch(resource, init);
      },
    );

    const plan = await createTransferPlan(input, fetchImpl as typeof fetch);
    const imageOperation = plan.operations.find((operation) =>
      operation.sourceUrl.endsWith('/hero'),
    );
    const pageOperation = plan.operations.find((operation) =>
      operation.sourceUrl.endsWith('/launch'),
    );

    expect(plan.operations.indexOf(imageOperation!)).toBeLessThan(
      plan.operations.indexOf(pageOperation!),
    );
    expect(pageOperation?.payload?.blocks).toEqual({
      image: {
        '@type': 'image',
        url: 'https://new.example/Plone/archive/news/hero',
      },
    });
    expect(imageOperation?.payload?.image).toMatchObject({
      data: 'BAUG',
      filename: 'hero.jpg',
    });
  });
});
