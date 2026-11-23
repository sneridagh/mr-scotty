import { describe, expect, test, vi } from 'vitest';
import {
  assertHostAllowed,
  createContentPayload,
  createTransferPlan,
  executeTransferPlan,
  readMaxItemsFromEnv,
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

describe('conflict policies', () => {
  const existingPath = '/Plone/archive/news/launch';

  /** A destination where the selected item's path is already taken. */
  function conflictingFetch(
    existing: Record<string, unknown> = launch,
    { uidTaken = false }: { uidTaken?: boolean } = {},
  ) {
    const fetchImpl = successfulFetch();
    fetchImpl.mockImplementation(async (resource, init) => {
      const url = new URL(String(resource));
      const method = init?.method || 'GET';
      const path = canonicalRequestPath(url);
      if (method === 'GET' && path === existingPath) {
        return json({ ...existing, '@id': url.toString() });
      }
      if (
        uidTaken &&
        path.endsWith('/@search') &&
        url.searchParams.get('UID') === 'launch-uid'
      ) {
        return json({ items: [{ '@id': url.toString() }], items_total: 1 });
      }
      if (method === 'PATCH') return new Response(null, { status: 204 });
      return successfulFetch()(resource, init);
    });
    return fetchImpl;
  }

  test('the overwrite flag still maps to replace', async () => {
    const plan = await createTransferPlan(
      { ...input, overwrite: true },
      conflictingFetch() as typeof fetch,
    );
    expect(plan.conflictPolicy).toBe('replace');
    expect(plan.operations.at(-1)?.status).toBe('replace');
  });

  test('skip leaves the existing item alone and beams the rest', async () => {
    const fetchImpl = conflictingFetch();
    const plan = await createTransferPlan(
      { ...input, conflictPolicy: 'skip' },
      fetchImpl as typeof fetch,
    );
    expect(plan.operations.map((operation) => operation.status)).toEqual([
      'create',
      'skip',
    ]);
    expect(plan.operations.at(-1)?.payload).toBeUndefined();

    fetchImpl.mockClear();
    const report = await executeTransferPlan(
      plan,
      input.destinationAuth,
      fetchImpl as typeof fetch,
    );
    const writes = fetchImpl.mock.calls.filter(([, init]) =>
      ['POST', 'PATCH', 'DELETE'].includes(init?.method || 'GET'),
    );
    expect(writes.map(([resource]) => String(resource))).toEqual([
      'https://new.example/Plone/++api++/archive',
    ]);
    expect(report.skipped).toEqual([
      'https://new.example/Plone/archive/news/launch',
    ]);
  });

  test('update patches the existing item, keeping its type, id and UUID', async () => {
    const fetchImpl = conflictingFetch({ ...launch, UID: 'other-uid' });
    const plan = await createTransferPlan(
      { ...input, conflictPolicy: 'update' },
      fetchImpl as typeof fetch,
    );
    const selected = plan.operations.at(-1);
    expect(selected?.status).toBe('update');
    expect(selected?.payload).toMatchObject({ title: 'Launch' });
    expect(selected?.payload).not.toHaveProperty('UID');
    expect(selected?.payload).not.toHaveProperty('id');
    expect(selected?.payload).not.toHaveProperty('@type');

    fetchImpl.mockClear();
    const report = await executeTransferPlan(
      plan,
      input.destinationAuth,
      fetchImpl as typeof fetch,
    );
    const patches = fetchImpl.mock.calls.filter(
      ([, init]) => init?.method === 'PATCH',
    );
    expect(patches.map(([resource]) => String(resource))).toEqual([
      'https://new.example/Plone/++api++/archive/news/launch',
    ]);
    expect(report.updated).toHaveLength(1);
    expect(report.failed).toBeUndefined();
  });

  test('update refuses an existing item of another type', async () => {
    await expect(
      createTransferPlan(
        { ...input, conflictPolicy: 'update' },
        conflictingFetch({ ...launch, '@type': 'News Item' }) as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: 'type_mismatch', status: 409 });
  });

  test('rename creates the item under the next free id', async () => {
    const plan = await createTransferPlan(
      { ...input, conflictPolicy: 'rename' },
      conflictingFetch({ ...launch, UID: 'other-uid' }) as typeof fetch,
    );
    const selected = plan.operations.at(-1);
    expect(selected).toMatchObject({
      status: 'rename',
      destinationUrl: 'https://new.example/Plone/archive/news/launch-1',
      renamedFrom: 'https://new.example/Plone/archive/news/launch',
    });
    expect(selected?.payload).toMatchObject({
      id: 'launch-1',
      UID: 'launch-uid',
    });
    expect(plan.destinationPath).toBe('/Plone/archive/news/launch-1');
  });

  test('rename gives the copy a new UUID when the original holds it', async () => {
    const plan = await createTransferPlan(
      { ...input, conflictPolicy: 'rename' },
      conflictingFetch(launch, { uidTaken: true }) as typeof fetch,
    );
    const selected = plan.operations.at(-1);
    expect(selected?.status).toBe('rename');
    expect(selected?.payload).toMatchObject({ id: 'launch-1' });
    expect(selected?.payload).not.toHaveProperty('UID');
  });
});

describe('destination existence check', () => {
  function fetchAnswering(path: string, response: () => Response) {
    const fetchImpl = successfulFetch();
    fetchImpl.mockImplementation(async (resource, init) => {
      const url = new URL(String(resource));
      if (
        (init?.method || 'GET') === 'GET' &&
        canonicalRequestPath(url) === path
      ) {
        return response();
      }
      return successfulFetch()(resource, init);
    });
    return fetchImpl;
  }

  test('ignores content acquired from further up the tree', async () => {
    // Zope answers /archive/news with the site's /news when it is missing.
    const fetchImpl = fetchAnswering('/Plone/archive/news', () =>
      json({ ...news, '@id': 'https://new.example/Plone/news' }),
    );
    const plan = await createTransferPlan(input, fetchImpl as typeof fetch);
    expect(plan.operations.map((operation) => operation.status)).toEqual([
      'create',
      'create',
    ]);
  });

  test('treats a path that resolves to a view as missing', async () => {
    // A missing `images` resolves to the @@images view, which answers 400.
    const fetchImpl = fetchAnswering('/Plone/archive/news', () =>
      json({ message: 'Missing image scale path', type: 'BadRequest' }, 400),
    );
    const plan = await createTransferPlan(input, fetchImpl as typeof fetch);
    expect(plan.operations.map((operation) => operation.status)).toEqual([
      'create',
      'create',
    ]);
  });
});

describe('redirects', () => {
  function redirectingSource(location: string) {
    return vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { Location: location } }),
    );
  }

  test('explains a frontend that does not serve the REST API', async () => {
    // Aurora answers /++api++/news/launch with a redirect to /news/launch.
    await expect(
      createTransferPlan(
        { ...input, sourceUrl: 'https://old.example/news/launch' },
        redirectingSource('/news/launch') as typeof fetch,
      ),
    ).rejects.toMatchObject({
      code: 'restapi_not_exposed',
      message: expect.stringContaining('Use the Plone backend URL instead.'),
    });
  });

  test('still rejects any other redirect', async () => {
    await expect(
      createTransferPlan(
        input,
        redirectingSource('https://elsewhere.example/login') as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: 'redirect_rejected' });
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

describe('workflow state', () => {
  /**
   * A destination with a small workflow: `transitions[state]` lists the
   * transitions available in each state and where they lead.
   */
  function workflowFetch(
    sourceState: string,
    transitions: Record<string, Record<string, string>>,
  ) {
    const states = new Map<string, string>();
    const fetchImpl = successfulFetch();
    fetchImpl.mockImplementation(async (resource, init) => {
      const url = new URL(String(resource));
      const method = init?.method || 'GET';
      const path = canonicalRequestPath(url);
      if (url.origin === 'https://old.example' && path.endsWith('/launch')) {
        return json({ ...launch, review_state: sourceState });
      }
      const workflow = path.match(/^(.*)\/@workflow(?:\/([^/]+))?$/);
      if (workflow) {
        const [, item, transition] = workflow;
        const state = states.get(item) ?? 'private';
        if (method === 'POST') {
          const next = transitions[state]?.[transition];
          if (!next) return json({ error: { message: 'Invalid' } }, 400);
          states.set(item, next);
          return json({ review_state: next });
        }
        return json({
          state: { id: state, title: state },
          transitions: Object.keys(transitions[state] ?? {}).map((id) => ({
            '@id': `${url.origin}${item}/@workflow/${id}`,
            title: id,
          })),
        });
      }
      return successfulFetch()(resource, init);
    });
    return { fetchImpl, states };
  }

  const simplePublication = {
    private: { publish: 'published', submit: 'pending' },
    pending: { publish: 'published', reject: 'private' },
    published: { retract: 'private' },
  };

  async function beam(fetchImpl: ReturnType<typeof vi.fn>) {
    const plan = await createTransferPlan(input, fetchImpl as typeof fetch);
    return executeTransferPlan(
      plan,
      input.destinationAuth,
      fetchImpl as typeof fetch,
    );
  }

  test('moves a written item to its source state', async () => {
    const { fetchImpl, states } = workflowFetch('published', simplePublication);
    const report = await beam(fetchImpl);

    expect(states.get('/Plone/archive/news/launch')).toBe('published');
    expect(report.warnings).toEqual([]);
  });

  test('takes more than one transition when it has to', async () => {
    const { fetchImpl, states } = workflowFetch('published', {
      private: { submit: 'pending' },
      pending: { publish: 'published' },
    });
    const report = await beam(fetchImpl);

    expect(states.get('/Plone/archive/news/launch')).toBe('published');
    expect(report.warnings).toEqual([]);
  });

  test('leaves an item private when its source is private', async () => {
    const { fetchImpl } = workflowFetch('private', simplePublication);
    const report = await beam(fetchImpl);

    const transitions = fetchImpl.mock.calls.filter(
      ([resource, init]) =>
        init?.method === 'POST' && String(resource).includes('/@workflow/'),
    );
    expect(transitions).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  test('warns, without failing, when the state cannot be reached', async () => {
    const { fetchImpl, states } = workflowFetch('archived', simplePublication);
    const report = await beam(fetchImpl);

    expect(report.failed).toBeUndefined();
    expect(report.created).toHaveLength(2);
    expect(states.get('/Plone/archive/news/launch') ?? 'private').toBe(
      'private',
    );
    expect(report.warnings).toEqual([
      expect.objectContaining({
        destinationUrl: 'https://new.example/Plone/archive/news/launch',
        code: 'workflow_unreachable',
      }),
    ]);
  });
});

describe('folder transfers', () => {
  const base = 'https://old.example/Plone/news/launch';
  const child = (id: string, extra: Record<string, unknown> = {}) => ({
    '@id': `${base}/${id}`,
    '@type': 'Document',
    UID: `${id}-uid`,
    id,
    title: id.toUpperCase(),
    is_folderish: false,
    '@components': { navroot: { navroot: sourceRoot } },
    ...extra,
  });
  // `b` shows an image block pointing at its later sibling `a`.
  const children: Record<string, Record<string, unknown>> = {
    b: child('b', {
      blocks: { img: { '@type': 'image', url: `${base}/a` } },
      blocks_layout: { items: ['img'] },
    }),
    a: child('a'),
  };

  function folderFetch(order = ['b', 'a']) {
    const fetchImpl = successfulFetch();
    fetchImpl.mockImplementation(async (resource, init) => {
      const url = new URL(String(resource));
      const method = init?.method || 'GET';
      const path = canonicalRequestPath(url);
      if (method === 'PATCH') return new Response(null, { status: 204 });
      if (url.origin === 'https://old.example') {
        if (path === '/Plone/news/launch') {
          return json({
            ...launch,
            is_folderish: true,
            items: order.map((id) => ({ '@id': `${base}/${id}` })),
            items_total: order.length,
          });
        }
        const id = path.split('/').at(-1) as string;
        if (path.startsWith('/Plone/news/launch/') && children[id]) {
          return json(children[id]);
        }
      }
      return successfulFetch()(resource, init);
    });
    return fetchImpl;
  }

  test('plans everything inside the selected item', async () => {
    const plan = await createTransferPlan(
      { ...input, includeChildren: true },
      folderFetch() as typeof fetch,
    );
    expect(plan.includeChildren).toBe(true);
    expect(
      plan.operations.map((operation) =>
        operation.destinationUrl.replace(
          'https://new.example/Plone/archive',
          '',
        ),
      ),
    ).toEqual([
      '/news',
      '/news/launch',
      // The referenced `a` is written before `b`, which points at it.
      '/news/launch/a',
      '/news/launch/b',
    ]);
    expect(plan.operations.at(-1)?.payload).toMatchObject({
      blocks: {
        img: { url: 'https://new.example/Plone/archive/news/launch/a' },
      },
    });
  });

  test('leaves the children out unless asked', async () => {
    const plan = await createTransferPlan(input, folderFetch() as typeof fetch);
    expect(plan.operations).toHaveLength(2);
  });

  test('puts the written children back in their source order', async () => {
    const fetchImpl = folderFetch();
    const plan = await createTransferPlan(
      { ...input, includeChildren: true },
      fetchImpl as typeof fetch,
    );
    fetchImpl.mockClear();
    const report = await executeTransferPlan(
      plan,
      input.destinationAuth,
      fetchImpl as typeof fetch,
    );

    const moves = fetchImpl.mock.calls
      .filter(([, init]) => init?.method === 'PATCH')
      .map(([resource, init]) => [
        String(resource),
        JSON.parse(String(init?.body)).ordering.obj_id,
      ]);
    const folder = 'https://new.example/Plone/++api++/archive/news/launch';
    expect(moves).toEqual([
      [folder, 'b'],
      [folder, 'a'],
    ]);
    expect(report.created).toHaveLength(4);
  });

  test('does not reorder children that were written in order', async () => {
    const fetchImpl = folderFetch(['a', 'b']);
    const plan = await createTransferPlan(
      { ...input, includeChildren: true },
      fetchImpl as typeof fetch,
    );
    fetchImpl.mockClear();
    await executeTransferPlan(
      plan,
      input.destinationAuth,
      fetchImpl as typeof fetch,
    );
    expect(
      fetchImpl.mock.calls.filter(([, init]) => init?.method === 'PATCH'),
    ).toEqual([]);
  });

  test('gives a renamed copy new UUIDs where the first copy holds them', async () => {
    // The folder was beamed before: its path and every UUID are taken.
    const fetchImpl = folderFetch();
    const answer = fetchImpl.getMockImplementation()!;
    fetchImpl.mockImplementation(async (resource, init) => {
      const url = new URL(String(resource));
      const path = canonicalRequestPath(url);
      if (url.origin === 'https://new.example') {
        if (
          (init?.method || 'GET') === 'GET' &&
          path === '/Plone/archive/news'
        ) {
          return json({ ...news, '@id': url.toString() });
        }
        if (
          (init?.method || 'GET') === 'GET' &&
          path === '/Plone/archive/news/launch'
        ) {
          return json({ ...launch, '@id': url.toString() });
        }
        if (path.endsWith('/@search')) {
          return json({ items: [{ '@id': 'taken' }], items_total: 1 });
        }
      }
      return answer(resource, init);
    });

    const plan = await createTransferPlan(
      { ...input, includeChildren: true, conflictPolicy: 'rename' },
      fetchImpl as typeof fetch,
    );
    const byPath = Object.fromEntries(
      plan.operations.map((operation) => [
        operation.destinationUrl.replace(
          'https://new.example/Plone/archive',
          '',
        ),
        operation,
      ]),
    );
    expect(byPath['/news'].status).toBe('reuse');
    expect(byPath['/news/launch-1'].status).toBe('rename');
    expect(byPath['/news/launch-1'].payload).not.toHaveProperty('UID');
    expect(byPath['/news/launch-1/a'].status).toBe('create');
    expect(byPath['/news/launch-1/a'].payload).not.toHaveProperty('UID');
    expect(byPath['/news/launch-1/b'].payload).not.toHaveProperty('UID');
    expect(byPath['/news/launch-1/b'].payload).toMatchObject({
      blocks: {
        img: { url: 'https://new.example/Plone/archive/news/launch-1/a' },
      },
    });
  });

  test('refuses a folder with more items than allowed', async () => {
    await expect(
      createTransferPlan(
        { ...input, includeChildren: true, maxItems: 3 },
        folderFetch() as typeof fetch,
      ),
    ).rejects.toMatchObject({ code: 'too_many_items', status: 413 });
  });

  test('reads the item limit from the environment', () => {
    expect(readMaxItemsFromEnv({})).toBe(500);
    expect(readMaxItemsFromEnv({ MR_SCOTTY_MAX_ITEMS: '50' })).toBe(50);
    expect(readMaxItemsFromEnv({ MR_SCOTTY_MAX_ITEMS: 'lots' })).toBe(500);
  });
});

describe('progress and cancellation', () => {
  test('reports progress before each item and when it ends', async () => {
    const fetchImpl = successfulFetch();
    const plan = await createTransferPlan(input, fetchImpl as typeof fetch);
    const progress: Array<[number, number, string | undefined]> = [];

    await executeTransferPlan(
      plan,
      input.destinationAuth,
      fetchImpl as typeof fetch,
      {
        onProgress: ({ done, total, current }) =>
          progress.push([done, total, current?.destinationUrl]),
      },
    );

    expect(progress).toEqual([
      [0, 2, 'https://new.example/Plone/archive/news'],
      [1, 2, 'https://new.example/Plone/archive/news/launch'],
      [2, 2, undefined],
    ]);
  });

  test('stops between items when cancelled', async () => {
    const fetchImpl = successfulFetch();
    const plan = await createTransferPlan(input, fetchImpl as typeof fetch);
    const controller = new AbortController();

    const report = await executeTransferPlan(
      plan,
      input.destinationAuth,
      fetchImpl as typeof fetch,
      {
        signal: controller.signal,
        // Cancel while the first item is being written.
        onProgress: ({ done }) => {
          if (done === 0) controller.abort();
        },
      },
    );

    expect(report.cancelled).toBe(true);
    expect(report.created.map((item) => item.destinationUrl)).toEqual([
      'https://new.example/Plone/archive/news',
    ]);
  });
});

describe('replace safety', () => {
  const launchPath = '/Plone/archive/news/launch';
  const downloadUrl =
    'https://new.example/Plone/archive/news/launch/@@download/image';
  const oldBytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  // The item being replaced: a published image with its file.
  const existingImage = {
    ...launch,
    '@id': 'https://new.example/Plone/archive/news/launch',
    '@type': 'Image',
    title: 'Old image',
    review_state: 'published',
    image: {
      download: downloadUrl,
      filename: 'old.png',
      'content-type': 'image/png',
    },
  };

  async function replacePlan() {
    const planFetch = successfulFetch();
    planFetch.mockImplementation(async (resource, init) => {
      const url = new URL(String(resource));
      if (
        (init?.method || 'GET') === 'GET' &&
        canonicalRequestPath(url) === launchPath
      ) {
        return json({ ...existingImage, '@id': url.toString() });
      }
      return successfulFetch()(resource, init);
    });
    return createTransferPlan(
      { ...input, conflictPolicy: 'replace' },
      planFetch as typeof fetch,
    );
  }

  /** The destination during the run; `download` answers the file request. */
  function runFetch(download: () => Response) {
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    const execFetch = vi.fn(
      async (resource: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(resource));
        const method = init?.method || 'GET';
        const path = canonicalRequestPath(url);
        if (url.toString() === downloadUrl) return download();
        if (method === 'GET' && path === launchPath) {
          return json({ ...existingImage, '@id': url.toString() });
        }
        if (method === 'GET' && path === `${launchPath}/@workflow`) {
          return json({
            state: { id: 'private' },
            transitions: [{ '@id': `${url}/publish` }],
          });
        }
        if (method === 'DELETE') return new Response(null, { status: 204 });
        if (method === 'POST') {
          const body = init?.body
            ? (JSON.parse(String(init.body)) as Record<string, unknown>)
            : {};
          posts.push({ path, body });
          // The incoming item fails to be created; the restore succeeds.
          if (body.title === 'Launch') {
            return json({ error: { message: 'recreate failed' } }, 500);
          }
          return json({ ...body, '@id': url.toString() }, 201);
        }
        return successfulFetch()(resource, init);
      },
    );
    return { execFetch, posts };
  }

  test('restores a replaced image with its file and its workflow state', async () => {
    const plan = await replacePlan();
    const { execFetch, posts } = runFetch(
      () =>
        new Response(oldBytes, { headers: { 'Content-Type': 'image/png' } }),
    );

    const report = await executeTransferPlan(
      plan,
      input.destinationAuth,
      execFetch as typeof fetch,
    );

    expect(report.failed).toMatchObject({ restored: true });
    const restore = posts.find(({ body }) => body.title === 'Old image');
    expect(restore?.body.image).toEqual({
      data: btoa(String.fromCharCode(...oldBytes)),
      encoding: 'base64',
      filename: 'old.png',
      'content-type': 'image/png',
    });
    expect(restore?.body.UID).toBe('launch-uid');
    // Put back in the state it had: published.
    expect(posts.map(({ path }) => path)).toContain(
      `${launchPath}/@workflow/publish`,
    );
  });

  test('leaves the item in place when it cannot be backed up', async () => {
    const plan = await replacePlan();
    const { execFetch } = runFetch(() => new Response('gone', { status: 500 }));

    const report = await executeTransferPlan(
      plan,
      input.destinationAuth,
      execFetch as typeof fetch,
    );

    expect(report.failed).toMatchObject({
      destinationUrl: 'https://new.example/Plone/archive/news/launch',
      code: 'backup_failed',
    });
    expect(report.failed?.restored).toBeUndefined();
    expect(
      execFetch.mock.calls.filter(([, init]) => init?.method === 'DELETE'),
    ).toEqual([]);
  });
});

function base64Url(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A Plone-like JWT that expires `seconds` from now. */
function tokenExpiringIn(seconds: number, sub = 'admin'): string {
  const exp = Math.floor(Date.now() / 1000) + seconds;
  return [
    base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    base64Url(JSON.stringify({ sub, exp })),
    'signature',
  ].join('.');
}

/** `successfulFetch`, plus `@login-renew`, recording each write's token. */
function renewingFetch(renew: () => Response) {
  const inner = successfulFetch();
  const writes: string[] = [];
  const renewals: string[] = [];
  const fetchImpl = vi.fn(
    async (resource: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(resource));
      const authorization = new Headers(init?.headers).get('Authorization');
      if (url.pathname.endsWith('/@login-renew')) {
        renewals.push(authorization ?? '');
        return renew();
      }
      if (init?.method === 'POST') writes.push(authorization ?? '');
      return inner(resource, init);
    },
  );
  return { fetchImpl: fetchImpl as typeof fetch, writes, renewals };
}

describe('tokens', () => {
  test('renews a destination token that is about to expire', async () => {
    const oldToken = tokenExpiringIn(5 * 60);
    const newToken = tokenExpiringIn(12 * 60 * 60);
    const auth = { type: 'bearer' as const, token: oldToken };
    const { fetchImpl, writes, renewals } = renewingFetch(() =>
      json({ token: newToken }),
    );
    const plan = await createTransferPlan(
      { ...input, destinationAuth: auth },
      fetchImpl,
    );

    const report = await executeTransferPlan(plan, auth, fetchImpl);

    expect(report.failed).toBeUndefined();
    expect(report.warnings.map((warning) => warning.code)).not.toContain(
      'token_renewal_failed',
    );
    expect(renewals).toEqual([`Bearer ${oldToken}`]);
    expect(writes).toEqual([`Bearer ${newToken}`, `Bearer ${newToken}`]);
    expect(auth.token).toBe(newToken);
  });

  test('leaves a token with hours left alone', async () => {
    const token = tokenExpiringIn(6 * 60 * 60);
    const auth = { type: 'bearer' as const, token };
    const { fetchImpl, renewals } = renewingFetch(() => json({}, 500));
    const plan = await createTransferPlan(
      { ...input, destinationAuth: auth },
      fetchImpl,
    );

    await executeTransferPlan(plan, auth, fetchImpl);

    expect(renewals).toEqual([]);
    expect(auth.token).toBe(token);
  });

  test('carries on with a warning when renewal fails', async () => {
    const token = tokenExpiringIn(5 * 60);
    const auth = { type: 'bearer' as const, token };
    const { fetchImpl, writes, renewals } = renewingFetch(() =>
      json({ error: { message: 'Nope' } }, 500),
    );
    const plan = await createTransferPlan(
      { ...input, destinationAuth: auth },
      fetchImpl,
    );

    const report = await executeTransferPlan(plan, auth, fetchImpl);

    expect(report.failed).toBeUndefined();
    expect(report.created).toHaveLength(2);
    expect(renewals).toHaveLength(1);
    expect(writes).toEqual([`Bearer ${token}`, `Bearer ${token}`]);
    expect(
      report.warnings.filter(
        (warning) => warning.code === 'token_renewal_failed',
      ),
    ).toHaveLength(1);
  });

  test('refuses an expired token before any request', async () => {
    const fetchImpl = vi.fn();
    const error = await createTransferPlan(
      {
        ...input,
        sourceAuth: { type: 'bearer', token: tokenExpiringIn(-60) },
      },
      fetchImpl as unknown as typeof fetch,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TransferError);
    expect(error).toMatchObject({ code: 'token_expired', status: 401 });
    expect((error as Error).message).toContain('source token expired');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each([
    [{ type: 'bearer' as const, token: 'revoked' }, 'paste a new token'],
    [
      { type: 'basic' as const, username: 'ana', password: 'x' },
      'have no Plone password',
    ],
    [{ type: 'anonymous' as const }, 'needs a login'],
  ])('explains a 401 for %o', async (destinationAuth, hint) => {
    const fetchImpl = vi.fn(async (resource: RequestInfo | URL) => {
      const url = new URL(String(resource));
      if (url.origin === 'https://new.example') {
        return json({ type: 'Unauthorized' }, 401);
      }
      return successfulFetch()(resource);
    });

    const error = await createTransferPlan(
      { ...input, destinationAuth },
      fetchImpl as typeof fetch,
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'unauthorized', status: 401 });
    expect((error as Error).message).toContain('https://new.example');
    expect((error as Error).message).toContain(hint);
  });
});

describe('destination site', () => {
  function siteFetch(frontendDomain: unknown, registryStatus = 200) {
    const inner = successfulFetch();
    return vi.fn(async (resource: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(resource));
      if (url.pathname.endsWith('/@site')) {
        return json({ '@id': 'https://new.example/Plone/@site' });
      }
      if (url.pathname.endsWith('/@registry/volto.frontend_domain')) {
        return json(frontendDomain, registryStatus);
      }
      return inner(resource, init);
    }) as typeof fetch;
  }

  test('names the destination site and its frontend', async () => {
    const plan = await createTransferPlan(
      input,
      siteFetch('https://www.new.example/'),
    );
    expect(plan.destinationSite).toEqual({
      siteUrl: 'https://new.example/Plone',
      frontendUrl: 'https://www.new.example',
    });
  });

  test('ignores the default localhost frontend of a public backend', async () => {
    const plan = await createTransferPlan(
      input,
      siteFetch('http://localhost:3000'),
    );
    expect(plan.destinationSite).toEqual({
      siteUrl: 'https://new.example/Plone',
    });
  });

  test('leaves the frontend out when it cannot be read', async () => {
    const plan = await createTransferPlan(
      input,
      siteFetch({ type: 'Unauthorized' }, 401),
    );
    expect(plan.destinationSite).toEqual({
      siteUrl: 'https://new.example/Plone',
    });
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
