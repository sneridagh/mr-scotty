import config from '@plone/registry';
import { requireAuthCookie } from '@plone/react-router';

/**
 * Mr. Scotty can read from and write to arbitrary servers, so it is gated on
 * the Manager role rather than mere authentication. The Manager-only
 * `@controlpanels` endpoint is used as the role probe against this site's
 * configured backend.
 */
export async function requireManager(request: Request): Promise<string> {
  const token = await requireAuthCookie(request);
  const apiPath = String(config.settings.apiPath).replace(/\/+$/, '');
  const response = await fetch(`${apiPath}/@controlpanels`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
    redirect: 'manual',
  });
  if (!response.ok) {
    throw new Response('Mr. Scotty requires the Manager role.', {
      status: 403,
      statusText: 'Forbidden',
    });
  }
  return token;
}
