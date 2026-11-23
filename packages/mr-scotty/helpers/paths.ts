/**
 * Short, readable forms of content URLs for the control panel: a path below
 * the site, such as `/news/launch`, and a label for the site it is on.
 */

function trimSlashes(path: string): string {
  return path.replace(/\/+$/, '');
}

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/**
 * The path of `url` below the site at `rootUrl`, such as `/news/launch`.
 * Without a root, or for a URL outside it, the URL's own path.
 */
export function sitePath(url: string, rootUrl?: string): string {
  const parsed = parse(url);
  if (!parsed) return url;
  const path = trimSlashes(parsed.pathname) || '/';
  const root = rootUrl ? parse(rootUrl) : undefined;
  if (!root || root.origin !== parsed.origin) return path;
  const rootPath = trimSlashes(root.pathname);
  if (!rootPath) return path;
  if (path === rootPath) return '/';
  return path.startsWith(`${rootPath}/`) ? path.slice(rootPath.length) : path;
}

/** `/news/launch` → `{ parent: '/news/', leaf: 'launch' }`. */
export function splitPath(path: string): { parent: string; leaf: string } {
  const index = path.lastIndexOf('/');
  if (index < 0 || path === '/') return { parent: '', leaf: path };
  return { parent: path.slice(0, index + 1), leaf: path.slice(index + 1) };
}

/** Whether `url` is the site at `siteUrl` or inside it. */
export function isWithin(url: string, siteUrl: string): boolean {
  const parsed = parse(url);
  const site = parse(siteUrl);
  if (!parsed || !site || parsed.origin !== site.origin) return false;
  const path = trimSlashes(parsed.pathname);
  const sitePathname = trimSlashes(site.pathname);
  return path === sitePathname || path.startsWith(`${sitePathname}/`);
}

/**
 * "this site" for the Aurora site's own backend, otherwise the host, such as
 * `old.example.org`.
 */
export function siteLabel(url: string, thisSiteUrl?: string): string {
  if (thisSiteUrl && isWithin(url, thisSiteUrl)) return 'this site';
  return parse(url)?.host ?? url;
}
