import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@plone/registry', () => ({
  default: { settings: { apiPath: 'https://new.example/Plone' } },
}));

vi.mock('@plone/react-router', () => ({
  requireAuthCookie: vi.fn().mockResolvedValue('session-token'),
  getAuthFromRequest: vi.fn().mockResolvedValue('session-token'),
}));

import { action } from './MrScotty';

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
    vi.stubGlobal('fetch', vi.fn());
  });

  test('does not forward the Aurora session to another destination host', async () => {
    const request = actionRequest('https://untrusted.example/Plone');
    const response = await action({ request } as never);

    expect((response as { init?: ResponseInit }).init?.status).toBe(400);
    expect((response as { data: Record<string, unknown> }).data).toMatchObject({
      ok: false,
      error: { code: 'session_destination_mismatch' },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('allows the Aurora session for a container below its configured backend', async () => {
    const request = actionRequest('https://new.example/Plone/archive');
    await action({ request } as never);

    expect(fetch).toHaveBeenCalled();
  });
});
