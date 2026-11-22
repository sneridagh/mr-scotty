import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@plone/registry', () => ({
  default: { settings: { apiPath: 'https://new.example/Plone' } },
}));

vi.mock('@plone/react-router', () => ({
  requireAuthCookie: vi.fn().mockResolvedValue('session-token'),
}));

import { action } from './MrScotty';

type FetchMock = ReturnType<typeof vi.fn> & { mock: { calls: unknown[][] } };

/** Pass the Manager probe; make any transfer request fail fast. */
function stubManagerFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (resource: RequestInfo | URL) => {
      if (String(resource).includes('@controlpanels')) {
        return new Response('[]', { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: 'stub' } }), {
        status: 404,
      });
    }),
  );
}

function actionRequest(destinationUrl: string) {
  const formData = new FormData();
  formData.set('sourceUrl', 'https://old.example/Plone/news/launch');
  formData.set('sourceAuthMode', 'anonymous');
  formData.set('destinationUrl', destinationUrl);
  formData.set('destinationAuthMode', 'session');
  formData.set('intent', 'preflight');

  return new Request('https://aurora.example/mr-scotty', {
    method: 'POST',
    body: formData,
  });
}

describe('Mr. Scotty route action', () => {
  beforeEach(() => {
    stubManagerFetch();
  });

  test('does not forward the Aurora session to another destination host', async () => {
    const request = actionRequest('https://untrusted.example/Plone');
    const response = await action({ request } as never);

    expect((response as { init?: ResponseInit }).init?.status).toBe(400);
    expect((response as { data: Record<string, unknown> }).data).toMatchObject({
      ok: false,
      error: { code: 'session_destination_mismatch' },
    });
    // Only the Manager probe ran; the transfer never reached the network.
    const calls = (fetch as FetchMock).mock.calls;
    expect(
      calls.every(([resource]) => String(resource).includes('@controlpanels')),
    ).toBe(true);
  });

  test('allows the Aurora session for a container below its configured backend', async () => {
    const request = actionRequest('https://new.example/Plone/archive');
    await action({ request } as never);

    const calls = (fetch as FetchMock).mock.calls;
    expect(
      calls.some(([resource]) => !String(resource).includes('@controlpanels')),
    ).toBe(true);
  });

  test('rejects a user without the Manager role', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Forbidden', { status: 403 })),
    );
    const request = actionRequest('https://new.example/Plone/archive');

    await expect(action({ request } as never)).rejects.toMatchObject({
      status: 403,
    });
  });
});
