import { isTokenExpired, readTokenClaims } from '../helpers/token';

export type EndpointAuth =
  | { type: 'anonymous' }
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string };

/**
 * How content whose destination path is already taken is handled:
 * - `fail` aborts before any write (the default);
 * - `skip` leaves the existing item untouched and beams the rest;
 * - `update` patches the existing item's fields in place, keeping its UUID,
 *   history and position;
 * - `rename` creates the incoming item under a free id (`<id>-1`, …) next to
 *   the existing one;
 * - `replace` deletes the existing item and recreates it.
 *
 * Structural parents are always reused. A referenced image that is already
 * at its path with the same UUID is reused under `fail`, `skip` and `rename`.
 */
export type ConflictPolicy = 'fail' | 'skip' | 'update' | 'rename' | 'replace';

export interface TransferInput {
  sourceUrl: string;
  destinationUrl: string;
  sourceAuth: EndpointAuth;
  destinationAuth: EndpointAuth;
  conflictPolicy?: ConflictPolicy;
  /** @deprecated alias for `conflictPolicy: 'replace'`. */
  overwrite?: boolean;
  /**
   * Also beam everything inside the selected item, folder by folder, keeping
   * the source order.
   */
  includeChildren?: boolean;
  /**
   * What to do with content types the destination does not have: beam them
   * as another type, or `null` to skip them and everything inside them.
   */
  typeMap?: Record<string, string | null>;
  /**
   * The most items a plan may write or check. Defaults to
   * `MR_SCOTTY_MAX_ITEMS`, or 500.
   */
  maxItems?: number;
}

type ContentRecord = Record<string, unknown> & {
  '@id'?: string;
  '@type'?: string;
  UID?: string;
  id?: string;
  title?: string;
  is_folderish?: boolean;
};

type PathSegment = string | number;

type ImageReference = {
  sourceUrl: URL;
  path: PathSegment[];
  kind: 'url' | 'relation';
};

type SourceNode = {
  sourceUrl: URL;
  content: ContentRecord;
  segments: string[];
  kind: TransferOperation['kind'];
  strictConflict: boolean;
  /** For items inside the selected one: their place among their siblings. */
  position?: number;
};

export interface TransferOperation {
  sourceUrl: string;
  destinationUrl: string;
  destinationParentUrl: string;
  id: string;
  title: string;
  uid: string;
  type: string;
  kind: 'placeholder' | 'content';
  status: 'create' | 'reuse' | 'replace' | 'skip' | 'update' | 'rename';
  /**
   * For items inside the selected one: their place among their source
   * siblings, which the destination folder is put back in.
   */
  position?: number;
  /** For `rename`: the taken URL the item was moved away from. */
  renamedFrom?: string;
  /** The source type, when the item is beamed as another `type`. */
  sourceType?: string;
  /**
   * Set when the destination has no such type and nothing was chosen for
   * it yet. A plan with such items cannot be beamed.
   */
  missingType?: boolean;
  /**
   * Why a `skip` is skipped, when it is not because it exists: its type was
   * skipped, or it is inside an item that was.
   */
  skipReason?: 'type' | 'parent';
  /**
   * The source's workflow state, which a written item is moved to with
   * workflow transitions once it exists.
   */
  reviewState?: string;
  payload?: Record<string, unknown>;
}

/** A destination content type. */
export interface DestinationType {
  id: string;
  title: string;
}

/**
 * A source type the destination does not have, or one the person mapped,
 * and what happens to its items.
 */
export interface TypeIssue {
  sourceType: string;
  /** How many items in the plan have it. */
  count: number;
  /**
   * The destination type its items are beamed as; `null` skips them; unset
   * until someone chooses.
   */
  mappedTo?: string | null;
  /** Source fields the chosen type has no field for: Plone drops them. */
  droppedFields?: string[];
}

export interface DestinationSite {
  /** The Plone site root, such as `https://cms.example.org/Plone`. */
  siteUrl: string;
  /** The public frontend, such as `https://www.example.org`. */
  frontendUrl?: string;
}

export interface TransferPlan {
  sourceUrl: string;
  sourceRootUrl: string;
  destinationUrl: string;
  destinationRootUrl: string;
  /**
   * Where people see the destination site: its frontend, when the backend
   * names one, and the Plone site its paths are relative to. Used for links;
   * nothing is written there.
   */
  destinationSite?: DestinationSite;
  /**
   * Types the destination lacks, or that were mapped. Empty or missing when
   * every type exists there.
   */
  typeIssues?: TypeIssue[];
  /** The destination's types, to map missing ones to. */
  destinationTypes?: DestinationType[];
  sourceRelativePath: string;
  destinationPath: string;
  conflictPolicy: ConflictPolicy;
  includeChildren: boolean;
  /** @deprecated use `conflictPolicy`; kept as `conflictPolicy === 'replace'`. */
  overwrite: boolean;
  operations: TransferOperation[];
}

export interface TransferReport {
  created: Array<{
    sourceUrl: string;
    destinationUrl: string;
    uid: string;
    kind: TransferOperation['kind'];
  }>;
  replaced: Array<{
    sourceUrl: string;
    destinationUrl: string;
    uid: string;
    kind: TransferOperation['kind'];
  }>;
  updated: Array<{
    sourceUrl: string;
    destinationUrl: string;
    uid: string;
    kind: TransferOperation['kind'];
  }>;
  reused: string[];
  skipped: string[];
  /**
   * Items that were written but could not be moved to their source workflow
   * state. They stay in the state they reached; the transfer carries on.
   */
  warnings: Array<{
    destinationUrl: string;
    code: string;
    message: string;
  }>;
  /**
   * Set when an operation failed mid-run. Everything in `created`, `replaced`
   * and `updated` happened before it; renamed items are in `created`; nothing after it was attempted. `restored` reports
   * whether a half-done replace put its original content back.
   */
  /** Set when the transfer was cancelled before it finished. */
  cancelled?: boolean;
  failed?: {
    sourceUrl: string;
    destinationUrl: string;
    code: string;
    message: string;
    restored?: boolean;
  };
  destinationUrl: string;
}

export class TransferError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'TransferError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Deployment-level SSRF controls. Both are opt-in so local development and the
 * acceptance suite (which beam between loopback backends) keep working with no
 * configuration; production sets them to lock outbound requests down.
 */
export interface SsrfPolicy {
  /** When set, source and destination hosts must match one of these exactly. */
  allowedHosts?: string[];
  /** When true, loopback/private/link-local hosts are refused. */
  blockPrivateNetwork?: boolean;
}

function currentEnv(): Record<string, string | undefined> {
  const globalProcess = (
    globalThis as {
      process?: { env?: Record<string, string | undefined> };
    }
  ).process;
  return globalProcess?.env ?? {};
}

export function readSsrfPolicyFromEnv(
  env: Record<string, string | undefined> = currentEnv(),
): SsrfPolicy {
  const allowedHosts = (env.MR_SCOTTY_ALLOWED_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  return {
    allowedHosts: allowedHosts.length > 0 ? allowedHosts : undefined,
    blockPrivateNetwork: /^(1|true|yes|on)$/i.test(
      env.MR_SCOTTY_BLOCK_PRIVATE_NETWORK || '',
    ),
  };
}

function ipv4Octets(hostname: string): number[] | undefined {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return undefined;
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet <= 255) ? octets : undefined;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true;
  }

  const octets = ipv4Octets(host);
  if (octets) {
    const [a, b] = octets;
    return (
      a === 0 ||
      a === 127 || // loopback
      a === 10 || // private
      (a === 172 && b >= 16 && b <= 31) || // private
      (a === 192 && b === 168) || // private
      (a === 169 && b === 254) // link-local (incl. cloud metadata 169.254.169.254)
    );
  }

  if (host.includes(':')) {
    // IPv6 literal: loopback, unspecified, unique-local (fc00::/7), link-local.
    return (
      host === '::1' ||
      host === '::' ||
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      host.startsWith('fe8') ||
      host.startsWith('fe9') ||
      host.startsWith('fea') ||
      host.startsWith('feb')
    );
  }

  return false;
}

export function assertHostAllowed(
  url: URL,
  label: string,
  policy: SsrfPolicy,
): void {
  const host = url.hostname.toLowerCase();
  if (policy.allowedHosts && !policy.allowedHosts.includes(host)) {
    throw new TransferError(
      'host_not_allowed',
      `${label} host ${host} is not in the configured allowed hosts.`,
      403,
    );
  }
  if (policy.blockPrivateNetwork && isPrivateHost(host)) {
    throw new TransferError(
      'private_network_blocked',
      `${label} host ${host} resolves to a private or loopback network and is refused.`,
      403,
    );
  }
}

type Fetch = typeof fetch;

const API_TRAVERSAL_SEGMENT = '++api++';

const RESPONSE_ONLY_FIELDS = new Set([
  '@components',
  '@id',
  '@static_behaviors',
  'breadcrumbs',
  'created',
  'getId',
  'image_scales',
  'is_folderish',
  'items',
  'items_total',
  'layout',
  'lock',
  'modified',
  'next_item',
  'parent',
  'previous_item',
  'relatedItems',
  'review_state',
  'type_title',
  'version',
  'working_copy',
]);

const DEFERRED_BINARY_FIELDS = new Set(['file', 'image', 'preview_image']);
const PLACEHOLDER_TYPE = 'Document';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isBinaryDescriptor(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && typeof value.download === 'string';
}

function isBinaryFieldName(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    DEFERRED_BINARY_FIELDS.has(normalized) ||
    normalized.includes('image') ||
    normalized.endsWith('_file')
  );
}

function canonicalizePathname(pathname: string): string {
  const segments = pathname
    .split('/')
    .filter((segment) => segment && segment !== API_TRAVERSAL_SEGMENT);
  return segments.length > 0 ? `/${segments.join('/')}` : '/';
}

function normalizeUrl(value: string, label: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new TransferError('invalid_url', `${label} must be a valid URL.`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TransferError('invalid_url', `${label} must use HTTP or HTTPS.`);
  }

  if (url.username || url.password) {
    throw new TransferError(
      'credentials_in_url',
      `${label} must not contain credentials. Use the authentication fields instead.`,
    );
  }

  url.hash = '';
  url.search = '';
  url.pathname = canonicalizePathname(url.pathname);
  return url;
}

function basicAuthorization(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function authorization(auth: EndpointAuth): string | undefined {
  if (auth.type === 'bearer') return `Bearer ${auth.token}`;
  if (auth.type === 'basic') {
    return basicAuthorization(auth.username, auth.password);
  }
  return undefined;
}

function formatTime(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** Explains a 401 in terms of what the person can do about it. */
function unauthorizedError(
  url: URL,
  method: string,
  auth: EndpointAuth,
): TransferError {
  const site = url.origin;
  let message: string;
  if (auth.type === 'bearer') {
    const expiresAt = readTokenClaims(auth.token)?.expiresAt;
    message =
      expiresAt && expiresAt.getTime() <= Date.now()
        ? `${site} refused the token: it expired at ${formatTime(expiresAt)}. Log in to the site again and paste a new token.`
        : `${site} refused the token for ${method} ${url}. It may have expired, been revoked, or belong to another site. Log in to the site again and paste a new token.`;
  } else if (auth.type === 'basic') {
    message = `${site} refused the username and password for ${method} ${url}. People who log in through Google, GitHub or another provider have no Plone password: use a bearer token instead.`;
  } else {
    message = `${site} needs a login for ${method} ${url}. Choose a bearer token or a username and password.`;
  }
  return new TransferError('unauthorized', message, 401);
}

/**
 * Refuses a bearer token that has already expired before any request is
 * made, so the person learns it at once rather than from a failed request.
 */
export function assertTokenUsable(auth: EndpointAuth, label: string) {
  if (auth.type !== 'bearer') return;
  const expiresAt = readTokenClaims(auth.token)?.expiresAt;
  if (expiresAt && isTokenExpired(auth.token)) {
    throw new TransferError(
      'token_expired',
      `The ${label} token expired at ${formatTime(expiresAt)}. Log in to the site again and paste a new token.`,
      401,
    );
  }
}

/**
 * How long before it expires a bearer token is renewed during a transfer.
 * Plone tokens last 12 hours by default.
 */
const TOKEN_RENEW_MARGIN_MS = 10 * 60 * 1000;

/**
 * Renews a bearer token through plone.restapi's `@login-renew` when it
 * expires within the margin. The new token replaces `auth.token` in place, so
 * every later request of the run uses it. Tokens that are not JWTs, or carry
 * no expiry, are left alone.
 */
async function renewTokenIfDue(
  auth: EndpointAuth,
  rootUrl: URL,
  fetchImpl: Fetch,
): Promise<'renewed' | 'not_due'> {
  if (auth.type !== 'bearer') return 'not_due';
  const expiresAt = readTokenClaims(auth.token)?.expiresAt;
  if (!expiresAt) return 'not_due';
  const left = expiresAt.getTime() - Date.now();
  // An expired token cannot be renewed; the next request explains the 401.
  if (left <= 0 || left > TOKEN_RENEW_MARGIN_MS) return 'not_due';

  const renewed = await requestJson(
    apiUrlAtRoot(rootUrl, rootUrl, '@login-renew'),
    auth,
    fetchImpl,
    { method: 'POST' },
  );
  if (typeof renewed.token !== 'string' || !renewed.token) {
    throw new TransferError(
      'token_renewal_failed',
      `${rootUrl.origin} answered @login-renew without a token.`,
      502,
    );
  }
  auth.token = renewed.token;
  return 'renewed';
}

/**
 * Whether a redirect sends an `++api++` request to the same path without it,
 * which is how a frontend that does not proxy the REST API answers.
 */
function redirectsAwayFromApi(url: URL, location: string | null): boolean {
  if (!location || !url.pathname.split('/').includes(API_TRAVERSAL_SEGMENT)) {
    return false;
  }
  const target = new URL(location, url);
  return (
    target.origin === url.origin &&
    !target.pathname.split('/').includes(API_TRAVERSAL_SEGMENT) &&
    canonicalizePathname(target.pathname) === canonicalizePathname(url.pathname)
  );
}

async function requestJson(
  url: URL,
  auth: EndpointAuth,
  fetchImpl: Fetch,
  init: RequestInit = {},
): Promise<ContentRecord> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  const authHeader = authorization(auth);
  if (authHeader) headers.set('Authorization', authHeader);
  if (init.body) headers.set('Content-Type', 'application/json');

  const response = await fetchImpl(url, {
    ...init,
    headers,
    redirect: 'manual',
  });

  if (response.status >= 300 && response.status < 400) {
    if (redirectsAwayFromApi(url, response.headers.get('Location'))) {
      throw new TransferError(
        'restapi_not_exposed',
        `${url.origin} does not serve the Plone REST API: it redirected ${url} to the same page without ++api++. This is usually a frontend such as Aurora. Use the Plone backend URL instead.`,
        502,
      );
    }
    throw new TransferError(
      'redirect_rejected',
      `The REST API redirected ${url}. Redirects are not followed for server-side transfer requests.`,
      502,
    );
  }

  if (response.status === 401) {
    throw unauthorizedError(url, init.method || 'GET', auth);
  }

  if (!response.ok) {
    let detail = '';
    try {
      const body = (await response.json()) as Record<string, unknown>;
      const error = body.error as Record<string, unknown> | undefined;
      detail = String(error?.message || body.message || '');
    } catch {
      detail = await response.text().catch(() => '');
    }
    throw new TransferError(
      `restapi_${response.status}`,
      `${init.method || 'GET'} ${url} returned ${response.status}${detail ? `: ${detail}` : ''}.`,
      response.status,
    );
  }

  if (response.status === 204) return {};
  return (await response.json()) as ContentRecord;
}

async function contentExists(
  url: URL,
  rootUrl: URL,
  auth: EndpointAuth,
  fetchImpl: Fetch,
): Promise<ContentRecord | undefined> {
  let content: ContentRecord;
  try {
    content = await requestJson(apiUrlAtRoot(url, rootUrl), auth, fetchImpl);
  } catch (error) {
    // A missing id can still traverse to something that is not content: a
    // view such as `@@images` answers 400 ("Missing image scale path").
    if (
      error instanceof TransferError &&
      (error.status === 404 || error.status === 400)
    )
      return undefined;
    throw error;
  }
  // Zope acquisition answers a missing path with content found further up,
  // such as `/archive/news` with the site's `/news`. Only content that lives
  // at the requested path counts.
  if (typeof content['@id'] === 'string') {
    const found = canonicalizePathname(
      decodeURIComponent(new URL(content['@id'], url).pathname),
    );
    if (found !== canonicalizePathname(decodeURIComponent(url.pathname))) {
      return undefined;
    }
  }
  return content;
}

function rebaseApiUrl(value: string, endpoint: URL): URL {
  const referenced = new URL(value, endpoint);
  const result = new URL(endpoint);
  result.pathname = canonicalizePathname(referenced.pathname);
  result.search = '';
  result.hash = '';
  return result;
}

function appendPath(base: URL, ...segments: string[]): URL {
  const result = new URL(base);
  if (segments.length === 0) {
    result.pathname = result.pathname.replace(/\/+$/, '') || '/';
    result.search = '';
    result.hash = '';
    return result;
  }
  const prefix = result.pathname.replace(/\/+$/, '');
  result.pathname = `${prefix}/${segments.join('/')}`.replace(/\/{2,}/g, '/');
  result.search = '';
  result.hash = '';
  return result;
}

function apiUrl(contentUrl: URL, ...segments: string[]): URL {
  const result = new URL(contentUrl);
  const contentPath = canonicalizePathname(result.pathname);
  result.pathname = `/${API_TRAVERSAL_SEGMENT}${contentPath}`;
  result.search = '';
  result.hash = '';
  return appendPath(result, ...segments);
}

function apiUrlAtRoot(
  contentUrl: URL,
  rootUrl: URL,
  ...segments: string[]
): URL {
  const result = new URL(contentUrl);
  const rootPath = rootUrl.pathname.replace(/\/+$/, '') || '/';
  const contentPath = canonicalizePathname(result.pathname);

  if (rootPath === '/') return apiUrl(contentUrl, ...segments);

  if (contentPath !== rootPath && !contentPath.startsWith(`${rootPath}/`)) {
    throw new TransferError(
      'content_outside_root',
      `Content ${contentUrl} is not below the REST API navigation root ${rootUrl}.`,
    );
  }

  const relativePath = contentPath.slice(rootPath.length).replace(/^\//, '');
  result.pathname = `${rootPath}/${API_TRAVERSAL_SEGMENT}${
    relativePath ? `/${relativePath}` : ''
  }`;
  result.search = '';
  result.hash = '';
  return appendPath(result, ...segments);
}

function apiUrlCandidates(contentUrl: URL): URL[] {
  const candidates = [apiUrl(contentUrl)];
  const segments = canonicalizePathname(contentUrl.pathname)
    .split('/')
    .filter(Boolean);

  // A Plone site can also be mounted below a server path (for example
  // /Plone). In that case ++api++ follows the site root instead of the
  // server root. Try that form only as a 404 fallback so root-mounted sites
  // retain the canonical /++api++/content URL.
  if (segments.length > 0) {
    const mounted = new URL(contentUrl);
    mounted.pathname = `/${segments[0]}/${API_TRAVERSAL_SEGMENT}/${segments
      .slice(1)
      .join('/')}`.replace(/\/+$/, '');
    mounted.search = '';
    mounted.hash = '';
    candidates.push(mounted);
  }

  return candidates;
}

function relativeSegments(root: URL, content: URL): string[] {
  const rootPath = root.pathname.replace(/\/+$/, '');
  const contentPath = content.pathname.replace(/\/+$/, '');
  const prefix = `${rootPath}/`;

  if (!contentPath.startsWith(prefix)) {
    throw new TransferError(
      'source_outside_root',
      `Source ${content} is not below the REST API navigation root ${root}.`,
    );
  }

  return contentPath.slice(prefix.length).split('/').filter(Boolean);
}

function navrootId(content: ContentRecord): string | undefined {
  const components = content['@components'] as
    Record<string, unknown> | undefined;
  const navroot = components?.navroot as Record<string, unknown> | undefined;
  const root = navroot?.navroot as Record<string, unknown> | undefined;
  return typeof root?.['@id'] === 'string' ? root['@id'] : undefined;
}

async function readContentAndRoot(
  contentUrl: URL,
  auth: EndpointAuth,
  fetchImpl: Fetch,
): Promise<{ content: ContentRecord; rootUrl: URL }> {
  let content: ContentRecord | undefined;
  let successfulCandidate: URL | undefined;
  let firstError: unknown;

  for (const candidate of apiUrlCandidates(contentUrl)) {
    const expandedUrl = new URL(candidate);
    expandedUrl.searchParams.set('expand', 'navroot');
    try {
      content = await requestJson(expandedUrl, auth, fetchImpl);
      successfulCandidate = candidate;
      break;
    } catch (error) {
      if (!(error instanceof TransferError) || error.status !== 404)
        throw error;
      firstError ??= error;
    }
  }

  if (!content || !successfulCandidate) throw firstError;

  let rootId = navrootId(content);

  if (!rootId) {
    const navroot = await requestJson(
      appendPath(successfulCandidate, '@navroot'),
      auth,
      fetchImpl,
    );
    const root = navroot.navroot as Record<string, unknown> | undefined;
    rootId = typeof root?.['@id'] === 'string' ? root['@id'] : undefined;
  }

  if (!rootId) {
    throw new TransferError(
      'missing_navroot',
      `The REST API response for ${contentUrl} did not expose a navigation root.`,
      502,
    );
  }

  return { content, rootUrl: rebaseApiUrl(rootId, contentUrl) };
}

function getIdentity(content: ContentRecord, url: URL) {
  const id =
    typeof content.id === 'string' && content.id
      ? content.id
      : decodeURIComponent(
          url.pathname.split('/').filter(Boolean).at(-1) || '',
        );
  const title = typeof content.title === 'string' ? content.title : id;
  const uid = typeof content.UID === 'string' ? content.UID : '';
  const type = typeof content['@type'] === 'string' ? content['@type'] : '';

  if (!id || !title || !uid || !type) {
    throw new TransferError(
      'incomplete_source',
      `Source ${url} must expose id, title, UID, and @type.`,
      502,
    );
  }

  return { id, title, uid, type };
}

export function createContentPayload(
  content: ContentRecord,
  sourceUrl: URL,
): Record<string, unknown> {
  const identity = getIdentity(content, sourceUrl);
  const payload: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(content)) {
    if (RESPONSE_ONLY_FIELDS.has(key)) continue;
    if (key.startsWith('@') && key !== '@type') continue;
    if (
      isBinaryFieldName(key) &&
      isBinaryDescriptor(value) &&
      typeof value.data !== 'string'
    ) {
      continue;
    }
    payload[key] = value;
  }

  return {
    ...payload,
    '@type': identity.type,
    id: identity.id,
    title: identity.title,
    UID: identity.uid,
  };
}

function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 8192;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(index, Math.min(index + chunkSize, bytes.length)),
    );
  }
  return btoa(binary);
}

async function requestBinary(
  url: URL,
  auth: EndpointAuth,
  fetchImpl: Fetch,
  contentType?: string,
): Promise<{ data: string; contentType: string }> {
  const headers = new Headers();
  headers.set('Accept', contentType || '*/*');
  const authHeader = authorization(auth);
  if (authHeader) headers.set('Authorization', authHeader);

  const response = await fetchImpl(url, {
    headers,
    redirect: 'manual',
  });

  if (response.status >= 300 && response.status < 400) {
    throw new TransferError(
      'redirect_rejected',
      `The resource request redirected ${url}. Redirects are not followed for server-side transfer requests.`,
      502,
    );
  }

  if (response.status === 401) {
    throw unauthorizedError(url, 'GET', auth);
  }

  if (!response.ok) {
    throw new TransferError(
      `resource_${response.status}`,
      `GET ${url} returned ${response.status} while downloading a resource.`,
      response.status,
    );
  }

  return {
    data: base64Encode(new Uint8Array(await response.arrayBuffer())),
    contentType:
      contentType ||
      response.headers.get('content-type')?.split(';', 1)[0] ||
      'application/octet-stream',
  };
}

function resourceFilename(
  descriptor: Record<string, unknown>,
  url: URL,
): string {
  if (typeof descriptor.filename === 'string' && descriptor.filename)
    return descriptor.filename;

  const filename = decodeURIComponent(
    url.pathname.split('/').filter(Boolean).at(-1) || '',
  );
  return filename || 'resource';
}

async function prepareContentPayload(
  content: ContentRecord,
  sourceUrl: URL,
  sourceAuth: EndpointAuth,
  fetchImpl: Fetch,
): Promise<Record<string, unknown>> {
  const payload = createContentPayload(content, sourceUrl);

  for (const [key, value] of Object.entries(content)) {
    if (!isBinaryFieldName(key) || !isBinaryDescriptor(value)) continue;

    const resourceUrl = new URL(value.download as string, sourceUrl);
    if (resourceUrl.origin !== sourceUrl.origin) {
      throw new TransferError(
        'external_resource',
        `The image field ${key} on ${sourceUrl} points to an external resource. External resource transfers are not enabled yet.`,
        422,
      );
    }

    const resource = await requestBinary(
      resourceUrl,
      sourceAuth,
      fetchImpl,
      typeof value['content-type'] === 'string'
        ? value['content-type']
        : undefined,
    );
    payload[key] = {
      data: resource.data,
      encoding: 'base64',
      filename: resourceFilename(value, resourceUrl),
      'content-type': resource.contentType,
    };
  }

  return payload;
}

function internalContentUrl(value: unknown, currentUrl: URL): URL | undefined {
  if (typeof value !== 'string' || !value || value.startsWith('data:'))
    return undefined;
  if (/^\/?resolveuid\//.test(value)) return undefined;

  let resolved: URL;
  try {
    resolved = new URL(value, currentUrl);
  } catch {
    return undefined;
  }

  if (resolved.origin !== currentUrl.origin) return undefined;
  if (/\/@\@(images|download)(\/|$)/.test(resolved.pathname)) return undefined;

  resolved.pathname = canonicalizePathname(resolved.pathname);
  resolved.search = '';
  resolved.hash = '';
  return resolved;
}

function collectImageReferences(
  content: ContentRecord,
  sourceUrl: URL,
): ImageReference[] {
  const references: ImageReference[] = [];

  const visit = (value: unknown, path: PathSegment[], key?: string) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...path, index], key));
      return;
    }
    if (!isRecord(value)) return;

    const blockType =
      typeof value['@type'] === 'string'
        ? value['@type'].toLowerCase()
        : undefined;
    if (blockType === 'image') {
      for (const field of ['url', 'image']) {
        const reference = internalContentUrl(value[field], sourceUrl);
        if (reference) {
          references.push({
            sourceUrl: reference,
            path: [...path, field],
            kind: 'url',
          });
        }
      }
    }

    if (key === 'image' || key === 'preview_image') {
      const relationId = internalContentUrl(value['@id'], sourceUrl);
      if (relationId) {
        references.push({
          sourceUrl: relationId,
          path: [...path, '@id'],
          kind: 'relation',
        });
      }
    }

    for (const [childKey, childValue] of Object.entries(value)) {
      if (childKey === 'image_scales') continue;
      visit(childValue, [...path, childKey], childKey);
    }
  };

  visit(content, []);
  return references;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function setPath(value: unknown, path: PathSegment[], replacement: string) {
  let current: unknown = value;
  for (const segment of path.slice(0, -1)) {
    if (isRecord(current)) {
      current = current[String(segment)];
    } else if (Array.isArray(current) && typeof segment === 'number') {
      current = current[segment];
    } else {
      return;
    }
  }
  const last = path.at(-1);
  if (last === undefined) return;
  if (isRecord(current)) {
    current[String(last)] = replacement;
  } else if (Array.isArray(current) && typeof last === 'number') {
    current[last] = replacement;
  }
}

function rewriteImageReferences(
  payload: Record<string, unknown>,
  references: ImageReference[],
  destinationBySourceUrl: Map<string, string>,
): Record<string, unknown> {
  const rewritten = cloneJson(payload);
  for (const reference of references) {
    const destinationUrl = destinationBySourceUrl.get(
      reference.sourceUrl.toString(),
    );
    if (destinationUrl) setPath(rewritten, reference.path, destinationUrl);
  }
  return rewritten;
}

function placeholderPayload(content: ContentRecord, sourceUrl: URL) {
  const identity = getIdentity(content, sourceUrl);
  return {
    '@type': PLACEHOLDER_TYPE,
    id: identity.id,
    title: identity.title,
    UID: identity.uid,
    // The source's publication dates, so publishing keeps them.
    ...(typeof content.effective === 'string'
      ? { effective: content.effective }
      : {}),
    ...(typeof content.expires === 'string'
      ? { expires: content.expires }
      : {}),
  };
}

async function isUidTaken(
  destinationRoot: URL,
  uid: string,
  auth: EndpointAuth,
  fetchImpl: Fetch,
): Promise<boolean> {
  const searchUrl = apiUrlAtRoot(destinationRoot, destinationRoot, '@search');
  searchUrl.searchParams.set('UID', uid);
  const result = await requestJson(searchUrl, auth, fetchImpl);
  const items = Array.isArray(result.items) ? result.items : [];
  return items.length > 0 || Number(result.items_total || 0) > 0;
}

async function assertUidAvailable(
  destinationRoot: URL,
  destinationUrl: URL,
  uid: string,
  auth: EndpointAuth,
  fetchImpl: Fetch,
) {
  if (await isUidTaken(destinationRoot, uid, auth, fetchImpl)) {
    throw new TransferError(
      'uid_conflict',
      `UUID ${uid} already exists at the destination and cannot be created at ${destinationUrl}.`,
      409,
    );
  }
}

async function findFreeDestinationUrl(
  parentUrl: URL,
  baseId: string,
  rootUrl: URL,
  auth: EndpointAuth,
  fetchImpl: Fetch,
): Promise<{ url: URL; id: string }> {
  for (let suffix = 1; suffix <= 1000; suffix += 1) {
    const candidateId = `${baseId}-${suffix}`;
    const candidateUrl = appendPath(parentUrl, candidateId);
    const exists = await contentExists(candidateUrl, rootUrl, auth, fetchImpl);
    if (!exists) return { url: candidateUrl, id: candidateId };
  }
  throw new TransferError(
    'rename_exhausted',
    `Could not find a free id to rename ${baseId} under ${parentUrl}.`,
    409,
  );
}

const DEFAULT_MAX_ITEMS = 500;
const CHILDREN_PAGE_SIZE = 100;

/** The item limit from `MR_SCOTTY_MAX_ITEMS`, or 500. */
/**
 * Where the destination site is shown to people, for links in reports. The
 * Plone site root comes from `@site`; the frontend from plone.volto's
 * `volto.frontend_domain` setting, which needs a Manager to read. Anything
 * missing is left out, and links then point to the backend.
 */
async function readDestinationSite(
  rootUrl: URL,
  auth: EndpointAuth,
  fetchImpl: Fetch,
): Promise<DestinationSite> {
  let siteUrl = rootUrl.toString();
  try {
    const site = await requestJson(
      apiUrlAtRoot(rootUrl, rootUrl, '@site'),
      auth,
      fetchImpl,
    );
    if (typeof site['@id'] === 'string') {
      siteUrl = rebaseApiUrl(
        site['@id'].replace(/\/@site\/?$/, ''),
        rootUrl,
      ).toString();
    }
  } catch {
    // Older backends have no @site: the navigation root will do.
  }

  let frontendUrl: string | undefined;
  try {
    const value: unknown = await requestJson(
      apiUrlAtRoot(rootUrl, rootUrl, '@registry', 'volto.frontend_domain'),
      auth,
      fetchImpl,
    );
    const candidate = typeof value === 'string' ? new URL(value) : undefined;
    if (
      candidate &&
      (candidate.protocol === 'http:' || candidate.protocol === 'https:') &&
      // The setting defaults to http://localhost:3000. On a backend that is
      // not local itself, that is the unset default, not its frontend.
      (!isPrivateHost(candidate.hostname) || isPrivateHost(rootUrl.hostname))
    ) {
      frontendUrl = candidate.origin + candidate.pathname.replace(/\/+$/, '');
    }
  } catch {
    // No plone.volto, or not allowed to read its settings.
  }

  return { siteUrl, ...(frontendUrl ? { frontendUrl } : {}) };
}

/**
 * The destination's content types, or undefined when it does not list them,
 * in which case the plan does not check types.
 */
async function readDestinationTypes(
  rootUrl: URL,
  auth: EndpointAuth,
  fetchImpl: Fetch,
): Promise<DestinationType[] | undefined> {
  let listing: unknown;
  try {
    listing = await requestJson(
      apiUrlAtRoot(rootUrl, rootUrl, '@types'),
      auth,
      fetchImpl,
    );
  } catch {
    return undefined;
  }
  if (!Array.isArray(listing)) return undefined;
  return listing.flatMap((entry: unknown) => {
    if (!isRecord(entry) || typeof entry['@id'] !== 'string') return [];
    const id = decodeURIComponent(entry['@id'].split('/').at(-1) as string);
    return [{ id, title: typeof entry.title === 'string' ? entry.title : id }];
  });
}

/** The field names of a type's schema, or undefined when it can't be read. */
async function readTypeFields(
  rootUrl: URL,
  type: string,
  auth: EndpointAuth,
  fetchImpl: Fetch,
): Promise<Set<string> | undefined> {
  try {
    const schema = await requestJson(
      apiUrlAtRoot(rootUrl, rootUrl, '@types', type),
      auth,
      fetchImpl,
    );
    return isRecord(schema.properties)
      ? new Set(Object.keys(schema.properties))
      : undefined;
  } catch {
    return undefined;
  }
}

function hasValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

/** Refuses a plan with items whose type the destination lacks. */
export function assertTypesResolved(plan: TransferPlan) {
  const unresolved = (plan.typeIssues ?? []).filter(
    (issue) => issue.mappedTo === undefined,
  );
  if (unresolved.length > 0) {
    throw new TransferError(
      'missing_types',
      `The destination has no ${unresolved
        .map((issue) => issue.sourceType)
        .join(
          ', ',
        )} type. Choose a type to beam those items as, or skip them, and inspect again.`,
      409,
    );
  }
}

export function readMaxItemsFromEnv(
  env: Record<string, string | undefined> = currentEnv(),
): number {
  const value = Number(env.MR_SCOTTY_MAX_ITEMS);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_ITEMS;
}

/** The children of a folder, in their order, a page at a time. */
async function listChildren(
  folderUrl: URL,
  rootUrl: URL,
  auth: EndpointAuth,
  fetchImpl: Fetch,
): Promise<URL[]> {
  const children: URL[] = [];
  for (let start = 0; ; start += CHILDREN_PAGE_SIZE) {
    const pageUrl = apiUrlAtRoot(folderUrl, rootUrl);
    pageUrl.searchParams.set('b_start', String(start));
    pageUrl.searchParams.set('b_size', String(CHILDREN_PAGE_SIZE));
    const page = await requestJson(pageUrl, auth, fetchImpl);
    const items = Array.isArray(page.items) ? page.items : [];
    for (const item of items) {
      if (isRecord(item) && typeof item['@id'] === 'string') {
        // Rebased to the folder's origin, without `++api++`.
        children.push(rebaseApiUrl(item['@id'], folderUrl));
      }
    }
    const total = Number(page.items_total ?? 0);
    if (items.length < CHILDREN_PAGE_SIZE || start + items.length >= total) {
      break;
    }
  }
  return children;
}

export async function createTransferPlan(
  input: TransferInput,
  fetchImpl: Fetch = fetch,
  policy: SsrfPolicy = readSsrfPolicyFromEnv(),
): Promise<TransferPlan> {
  const conflictPolicy: ConflictPolicy =
    input.conflictPolicy ?? (input.overwrite === true ? 'replace' : 'fail');
  const overwrite = conflictPolicy === 'replace';
  const sourceUrl = normalizeUrl(input.sourceUrl, 'Source URL');
  const destinationUrl = normalizeUrl(input.destinationUrl, 'Destination URL');
  // Referenced resources are rebased to the source origin, so allowing the
  // source and destination hosts covers every outbound request the plan makes.
  assertHostAllowed(sourceUrl, 'Source URL', policy);
  assertHostAllowed(destinationUrl, 'Destination URL', policy);
  assertTokenUsable(input.sourceAuth, 'source');
  assertTokenUsable(input.destinationAuth, 'destination');
  const source = await readContentAndRoot(
    sourceUrl,
    input.sourceAuth,
    fetchImpl,
  );
  const destination = await readContentAndRoot(
    destinationUrl,
    input.destinationAuth,
    fetchImpl,
  );

  if (destination.content.is_folderish !== true) {
    throw new TransferError(
      'destination_not_folderish',
      `Destination ${destinationUrl} is not a container.`,
    );
  }

  const typeMap = input.typeMap ?? {};
  const destinationTypes = await readDestinationTypes(
    destination.rootUrl,
    input.destinationAuth,
    fetchImpl,
  );
  const destinationTypeIds = destinationTypes
    ? new Set(destinationTypes.map((type) => type.id))
    : undefined;
  for (const [sourceType, target] of Object.entries(typeMap)) {
    if (
      target !== null &&
      destinationTypeIds &&
      !destinationTypeIds.has(target)
    ) {
      throw new TransferError(
        'invalid_type_mapping',
        `${sourceType} cannot be beamed as ${target}: the destination has no such type.`,
      );
    }
  }

  const segments = relativeSegments(source.rootUrl, sourceUrl);
  if (segments.length === 0) {
    throw new TransferError(
      'source_is_root',
      'Transferring the source site root is not supported by the single-URL workflow.',
    );
  }

  const sourceNodes = new Map<string, SourceNode>();

  const addSourceNode = (
    sourceItemUrl: URL,
    content: ContentRecord,
    nodeKind: SourceNode['kind'],
    strictConflict = false,
    position?: number,
  ) => {
    const key = sourceItemUrl.toString();
    const existing = sourceNodes.get(key);
    if (existing) {
      if (nodeKind === 'content') existing.kind = 'content';
      if (strictConflict) existing.strictConflict = true;
      if (nodeKind === 'content') existing.content = content;
      return;
    }

    sourceNodes.set(key, {
      sourceUrl: sourceItemUrl,
      content,
      segments: relativeSegments(source.rootUrl, sourceItemUrl),
      kind: nodeKind,
      strictConflict,
      ...(position === undefined ? {} : { position }),
    });
  };

  for (let index = 0; index < segments.length; index += 1) {
    const sourceItemUrl = appendPath(
      source.rootUrl,
      ...segments.slice(0, index + 1),
    );
    const content =
      index === segments.length - 1
        ? source.content
        : await requestJson(
            apiUrlAtRoot(sourceItemUrl, source.rootUrl),
            input.sourceAuth,
            fetchImpl,
          );
    addSourceNode(
      sourceItemUrl,
      content,
      index === segments.length - 1 ? 'content' : 'placeholder',
      index === segments.length - 1,
    );
  }

  const maxItems = input.maxItems ?? readMaxItemsFromEnv();
  const pendingReferences = collectImageReferences(source.content, sourceUrl);
  const includeChildren =
    input.includeChildren === true && source.content.is_folderish === true;

  if (includeChildren) {
    // Walk the selected item folder by folder. Each folder lists its children
    // in their order, which the destination keeps.
    const folders = [appendPath(source.rootUrl, ...segments)];
    let itemCount = segments.length;
    while (folders.length > 0) {
      const folderUrl = folders.shift() as URL;
      const children = await listChildren(
        folderUrl,
        source.rootUrl,
        input.sourceAuth,
        fetchImpl,
      );
      itemCount += children.length;
      if (itemCount > maxItems) {
        throw new TransferError(
          'too_many_items',
          `${appendPath(source.rootUrl, ...segments)} holds more than ${maxItems} items, the most one transfer may include. Beam its folders one by one, or raise MR_SCOTTY_MAX_ITEMS.`,
          413,
        );
      }
      for (const [position, childUrl] of children.entries()) {
        const childSegments = relativeSegments(source.rootUrl, childUrl);
        const canonicalChildUrl = appendPath(source.rootUrl, ...childSegments);
        const content = await requestJson(
          apiUrlAtRoot(canonicalChildUrl, source.rootUrl),
          input.sourceAuth,
          fetchImpl,
        );
        addSourceNode(canonicalChildUrl, content, 'content', true, position);
        pendingReferences.push(
          ...collectImageReferences(content, canonicalChildUrl),
        );
        if (content.is_folderish === true) folders.push(canonicalChildUrl);
      }
    }
  }
  const visitedReferences = new Set<string>();

  while (pendingReferences.length > 0) {
    const reference = pendingReferences.shift() as ImageReference;
    const referenceKey = reference.sourceUrl.toString();
    if (visitedReferences.has(referenceKey)) continue;
    visitedReferences.add(referenceKey);

    let referenced: { content: ContentRecord; rootUrl: URL };
    try {
      referenced = await readContentAndRoot(
        reference.sourceUrl,
        input.sourceAuth,
        fetchImpl,
      );
    } catch (error) {
      if (error instanceof TransferError && error.status === 404) continue;
      throw error;
    }

    let referenceSegments: string[];
    try {
      referenceSegments = relativeSegments(source.rootUrl, reference.sourceUrl);
    } catch (error) {
      if (
        error instanceof TransferError &&
        error.code === 'source_outside_root'
      )
        continue;
      throw error;
    }
    if (referenceSegments.length === 0) continue;

    for (let index = 0; index < referenceSegments.length; index += 1) {
      const sourceItemUrl = appendPath(
        source.rootUrl,
        ...referenceSegments.slice(0, index + 1),
      );
      const isReferencedContent = index === referenceSegments.length - 1;
      const content = isReferencedContent
        ? referenced.content
        : sourceNodes.get(sourceItemUrl.toString())?.content ||
          (await requestJson(
            apiUrlAtRoot(sourceItemUrl, source.rootUrl),
            input.sourceAuth,
            fetchImpl,
          ));
      addSourceNode(
        sourceItemUrl,
        content,
        isReferencedContent ? 'content' : 'placeholder',
      );
    }

    pendingReferences.push(
      ...collectImageReferences(referenced.content, reference.sourceUrl),
    );
  }

  // First pass: resolve each node's status and final destination. Nodes come
  // parents first, so a node's parent destination is already known, and the
  // children of a renamed item follow it to its new id.
  type PlannedNode = {
    node: SourceNode;
    identity: ReturnType<typeof getIdentity>;
    destinationItemUrl: URL;
    destinationParentUrl: URL;
    status: TransferOperation['status'];
    renamedFrom?: string;
    newUid: boolean;
    /** The type it is written as. */
    targetType: string;
    missingType?: boolean;
    skipReason?: TransferOperation['skipReason'];
  };
  const destinationBySourceUrl = new Map<string, string>();
  const planned: PlannedNode[] = [];
  // Items that were renamed, and everything written inside them.
  const inRenamedCopy = new Set<string>();
  // Items skipped for their type, and everything inside them.
  const skippedForType = new Set<string>();
  const typeIssues = new Map<string, TypeIssue>();
  // Parents before children, and referenced items before the content that
  // references them, so relations resolve. Siblings otherwise keep the source
  // order (the sort is stable); the executor restores it where references
  // changed it.
  const orderedNodes = [...sourceNodes.values()].sort(
    (left, right) =>
      left.segments.length - right.segments.length ||
      Number(!visitedReferences.has(left.sourceUrl.toString())) -
        Number(!visitedReferences.has(right.sourceUrl.toString())) ||
      Number(left.strictConflict) - Number(right.strictConflict),
  );
  if (orderedNodes.length > maxItems) {
    throw new TransferError(
      'too_many_items',
      `The transfer would include ${orderedNodes.length} items, more than the ${maxItems} one transfer may include.`,
      413,
    );
  }

  for (const node of orderedNodes) {
    const identity = getIdentity(node.content, node.sourceUrl);
    const parentSegments = node.segments.slice(0, -1);
    const parentKey = appendPath(source.rootUrl, ...parentSegments).toString();
    const resolvedParent = destinationBySourceUrl.get(parentKey);
    const destinationParentUrl = resolvedParent
      ? new URL(resolvedParent)
      : appendPath(destinationUrl, ...parentSegments);
    let destinationItemUrl = appendPath(
      destinationParentUrl,
      node.segments.at(-1) as string,
    );

    // Content of a type the destination lacks is beamed as the type chosen
    // for it, skipped, or flagged until someone chooses.
    let targetType = identity.type;
    let missingType = false;
    let skipReason: PlannedNode['skipReason'];
    if (skippedForType.has(parentKey)) {
      skipReason = 'parent';
    } else if (node.kind === 'content') {
      const mapped = Object.hasOwn(typeMap, identity.type)
        ? typeMap[identity.type]
        : undefined;
      const missing =
        destinationTypeIds !== undefined &&
        !destinationTypeIds.has(identity.type);
      if (missing || mapped !== undefined) {
        const issue = typeIssues.get(identity.type) ?? {
          sourceType: identity.type,
          count: 0,
          ...(mapped === undefined ? {} : { mappedTo: mapped }),
        };
        issue.count += 1;
        typeIssues.set(identity.type, issue);
        if (mapped === null) skipReason = 'type';
        else if (mapped) targetType = mapped;
        else missingType = true;
      }
    }
    if (skipReason) {
      skippedForType.add(node.sourceUrl.toString());
      destinationBySourceUrl.set(
        node.sourceUrl.toString(),
        destinationItemUrl.toString(),
      );
      planned.push({
        node,
        identity,
        destinationItemUrl,
        destinationParentUrl,
        status: 'skip',
        newUid: false,
        targetType,
        skipReason,
      });
      continue;
    }

    const existing = await contentExists(
      destinationItemUrl,
      destination.rootUrl,
      input.destinationAuth,
      fetchImpl,
    );

    let status: TransferOperation['status'];
    let renamedFrom: string | undefined;
    let newUid = false;

    if (!existing) {
      if (inRenamedCopy.has(parentKey)) {
        // Inside a renamed copy, as when a folder is beamed again with "keep
        // both": a UUID the first copy already holds goes to the new copy
        // as a new one.
        newUid = await isUidTaken(
          destination.rootUrl,
          identity.uid,
          input.destinationAuth,
          fetchImpl,
        );
        inRenamedCopy.add(node.sourceUrl.toString());
      } else {
        await assertUidAvailable(
          destination.rootUrl,
          destinationItemUrl,
          identity.uid,
          input.destinationAuth,
          fetchImpl,
        );
      }
      status = 'create';
    } else if (node.kind === 'placeholder') {
      if (existing.is_folderish !== true) {
        throw new TransferError(
          'parent_not_folderish',
          `Existing destination parent ${destinationItemUrl} is not a container.`,
          409,
        );
      }
      status = 'reuse';
    } else if (conflictPolicy === 'replace') {
      status = 'replace';
    } else if (conflictPolicy === 'update') {
      if (existing['@type'] !== targetType) {
        throw new TransferError(
          'type_mismatch',
          `The ${String(existing['@type'])} at ${destinationItemUrl} cannot be updated from a ${targetType}. Replace or rename it instead.`,
          409,
        );
      }
      status = 'update';
    } else if (!node.strictConflict && existing.UID === identity.uid) {
      // A referenced image that is already there.
      status = 'reuse';
    } else if (conflictPolicy === 'skip') {
      status = 'skip';
    } else if (conflictPolicy === 'rename') {
      const free = await findFreeDestinationUrl(
        destinationParentUrl,
        identity.id,
        destination.rootUrl,
        input.destinationAuth,
        fetchImpl,
      );
      renamedFrom = destinationItemUrl.toString();
      destinationItemUrl = free.url;
      // A UUID is unique in a site: when it is already taken, typically by
      // the item being renamed away from, the copy gets a new one.
      newUid = await isUidTaken(
        destination.rootUrl,
        identity.uid,
        input.destinationAuth,
        fetchImpl,
      );
      status = 'rename';
      inRenamedCopy.add(node.sourceUrl.toString());
    } else {
      throw node.strictConflict
        ? new TransferError(
            'path_conflict',
            `Content already exists at ${destinationItemUrl}.`,
            409,
          )
        : new TransferError(
            'resource_path_conflict',
            `A different content item already exists at referenced resource path ${destinationItemUrl}.`,
            409,
          );
    }

    destinationBySourceUrl.set(
      node.sourceUrl.toString(),
      destinationItemUrl.toString(),
    );
    planned.push({
      node,
      identity,
      destinationItemUrl,
      destinationParentUrl,
      status,
      renamedFrom,
      newUid,
      targetType,
      ...(missingType ? { missingType } : {}),
    });
  }

  // Second pass: build the payloads, now that every destination is final and
  // image references can be rewritten to renamed items too.
  const operations: TransferOperation[] = [];
  for (const item of planned) {
    const { node, identity, status } = item;
    let payload: Record<string, unknown> | undefined;
    if (status !== 'reuse' && status !== 'skip') {
      payload =
        node.kind === 'placeholder'
          ? placeholderPayload(node.content, node.sourceUrl)
          : await prepareContentPayload(
              node.content,
              node.sourceUrl,
              input.sourceAuth,
              fetchImpl,
            );
      if (node.kind === 'content') {
        payload = rewriteImageReferences(
          payload,
          collectImageReferences(node.content, node.sourceUrl),
          destinationBySourceUrl,
        );
      }
      if (status === 'rename') {
        payload.id = decodeURIComponent(
          item.destinationItemUrl.pathname.split('/').at(-1) as string,
        );
      }
      if (item.targetType !== identity.type) payload['@type'] = item.targetType;
      if (item.newUid) delete payload.UID;
      if (status === 'update') {
        // The existing item keeps its type, id and UUID.
        delete payload['@type'];
        delete payload.id;
        delete payload.UID;
      }
    }

    operations.push({
      sourceUrl: node.sourceUrl.toString(),
      destinationUrl: item.destinationItemUrl.toString(),
      destinationParentUrl: item.destinationParentUrl.toString(),
      ...identity,
      type: item.targetType,
      ...(item.targetType === identity.type
        ? {}
        : { sourceType: identity.type }),
      ...(item.missingType ? { missingType: true } : {}),
      ...(item.skipReason ? { skipReason: item.skipReason } : {}),
      kind: node.kind,
      status,
      ...(item.renamedFrom ? { renamedFrom: item.renamedFrom } : {}),
      ...(node.position === undefined ? {} : { position: node.position }),
      ...(payload && typeof node.content.review_state === 'string'
        ? { reviewState: node.content.review_state }
        : {}),
      payload,
    });
  }

  // For each mapped type: the source fields with a value that the chosen
  // type has no field for, which Plone drops silently.
  for (const issue of typeIssues.values()) {
    if (typeof issue.mappedTo !== 'string') continue;
    const targetFields = await readTypeFields(
      destination.rootUrl,
      issue.mappedTo,
      input.destinationAuth,
      fetchImpl,
    );
    if (!targetFields) continue;
    const sourceFields = await readTypeFields(
      source.rootUrl,
      issue.sourceType,
      input.sourceAuth,
      fetchImpl,
    );
    const dropped = new Set<string>();
    for (const operation of operations) {
      if (operation.sourceType !== issue.sourceType || !operation.payload)
        continue;
      for (const [field, value] of Object.entries(operation.payload)) {
        if (field.startsWith('@') || field === 'UID' || field === 'id')
          continue;
        if (targetFields.has(field) || !hasValue(value)) continue;
        if (sourceFields && !sourceFields.has(field)) continue;
        dropped.add(field);
      }
    }
    issue.droppedFields = [...dropped].sort();
  }

  return {
    ...(typeIssues.size > 0
      ? {
          typeIssues: [...typeIssues.values()],
          ...(destinationTypes ? { destinationTypes } : {}),
        }
      : {}),
    sourceUrl: sourceUrl.toString(),
    sourceRootUrl: source.rootUrl.toString(),
    destinationUrl: destinationUrl.toString(),
    destinationRootUrl: destination.rootUrl.toString(),
    destinationSite: await readDestinationSite(
      destination.rootUrl,
      input.destinationAuth,
      fetchImpl,
    ),
    sourceRelativePath: `/${segments.join('/')}`,
    destinationPath: new URL(
      destinationBySourceUrl.get(
        appendPath(source.rootUrl, ...segments).toString(),
      ) ?? appendPath(destinationUrl, ...segments).toString(),
    ).pathname,
    conflictPolicy,
    includeChildren,
    overwrite,
    operations,
  };
}

/**
 * Transitions known to lead to a workflow state in Plone's stock workflows
 * (simple publication, intranet, folder and one-state workflows). Plone's
 * REST API lists the transitions available on an item, but not where they
 * lead, so the target state picks the candidates.
 */
const TRANSITIONS_TO_STATE: Record<string, string[]> = {
  published: ['publish', 'publish_externally'],
  pending: ['submit'],
  private: ['make_private', 'retract', 'reject', 'hide'],
  visible: ['show', 'retract'],
  internal: ['retract', 'hide', 'make_private'],
  internally_published: ['publish_internally'],
  external: ['publish_externally'],
};

/** At most this many transitions are tried to reach a state. */
const MAX_TRANSITIONS = 4;

/**
 * Moves an item to `target` with workflow transitions. Returns a warning when
 * the state cannot be reached; a workflow problem never fails the transfer.
 */
async function alignReviewState(
  contentUrl: URL,
  target: string,
  destinationRoot: URL,
  auth: EndpointAuth,
  fetchImpl: Fetch,
): Promise<TransferReport['warnings'][number] | undefined> {
  const tried = new Set<string>();
  let state: string | undefined;
  try {
    for (let step = 0; step <= MAX_TRANSITIONS; step += 1) {
      const workflow = await requestJson(
        apiUrlAtRoot(contentUrl, destinationRoot, '@workflow'),
        auth,
        fetchImpl,
      );
      state = isRecord(workflow.state) ? String(workflow.state.id) : undefined;
      if (state === target) return undefined;
      if (step === MAX_TRANSITIONS) break;

      const available = (
        Array.isArray(workflow.transitions) ? workflow.transitions : []
      )
        .map((transition) =>
          isRecord(transition) ? String(transition['@id']) : '',
        )
        .map((id) => id.split('/').at(-1) as string)
        .filter((id) => id && !tried.has(id));
      // A known transition to the target first. For a known target,
      // submitting often opens the way, as from private to pending to
      // published. An unknown target leaves the item alone.
      const candidates = TRANSITIONS_TO_STATE[target];
      const next = candidates
        ? (candidates.find((id) => available.includes(id)) ??
          (available.includes('submit') ? 'submit' : undefined))
        : undefined;
      if (!next) break;
      tried.add(next);
      await requestJson(
        apiUrlAtRoot(contentUrl, destinationRoot, '@workflow', next),
        auth,
        fetchImpl,
        { method: 'POST', body: '{}' },
      );
    }
  } catch (error) {
    return {
      destinationUrl: contentUrl.toString(),
      code: 'workflow_failed',
      message: `Could not set the workflow state to "${target}": ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  return {
    destinationUrl: contentUrl.toString(),
    code: 'workflow_unreachable',
    message: `The destination workflow has no way to "${target}"${
      state ? ` from "${state}"` : ''
    }; the item is left ${state ? `"${state}"` : 'as it is'}.`,
  };
}

export interface TransferProgress {
  /** How many operations are finished. */
  done: number;
  total: number;
  /** The operation being written now, if any. */
  current?: Pick<TransferOperation, 'destinationUrl' | 'status' | 'kind'>;
}

export interface ExecuteOptions {
  /** Called before each operation, and once more when the run ends. */
  onProgress?: (progress: TransferProgress) => void;
  /**
   * Cancels the run between operations: the one being written finishes, and
   * nothing after it is attempted.
   */
  signal?: AbortSignal;
}

export async function executeTransferPlan(
  plan: TransferPlan,
  destinationAuth: EndpointAuth,
  fetchImpl: Fetch = fetch,
  { onProgress, signal }: ExecuteOptions = {},
): Promise<TransferReport> {
  assertTypesResolved(plan);
  const selectedOperation = plan.operations.find(
    (operation) => operation.sourceUrl === plan.sourceUrl,
  );
  const report: TransferReport = {
    created: [],
    replaced: [],
    updated: [],
    reused: [],
    skipped: [],
    warnings: [],
    destinationUrl:
      selectedOperation?.destinationUrl ||
      plan.operations.at(-1)?.destinationUrl ||
      plan.destinationUrl,
  };

  const destinationRoot = new URL(plan.destinationRootUrl);

  const alignState = async (operation: TransferOperation) => {
    written.add(operation);
    if (!operation.reviewState) return;
    const warning = await alignReviewState(
      new URL(operation.destinationUrl),
      operation.reviewState,
      destinationRoot,
      destinationAuth,
      fetchImpl,
    );
    if (warning) report.warnings.push(warning);
  };

  const written = new Set<TransferOperation>();

  /**
   * New items land at the bottom of their folder in the order they were
   * written. Where that differs from the source order (referenced items are
   * written first), move them to the bottom again in source order.
   */
  const restoreOrder = async () => {
    const byParent = new Map<string, TransferOperation[]>();
    for (const operation of plan.operations) {
      if (operation.position === undefined || !written.has(operation)) continue;
      const siblings = byParent.get(operation.destinationParentUrl) ?? [];
      siblings.push(operation);
      byParent.set(operation.destinationParentUrl, siblings);
    }
    for (const [parentUrl, siblings] of byParent) {
      const sourceOrder = [...siblings].sort(
        (left, right) => (left.position ?? 0) - (right.position ?? 0),
      );
      if (
        sourceOrder.every((operation, index) => operation === siblings[index])
      )
        continue;
      try {
        for (const operation of sourceOrder) {
          await requestJson(
            apiUrlAtRoot(new URL(parentUrl), destinationRoot),
            destinationAuth,
            fetchImpl,
            {
              method: 'PATCH',
              body: JSON.stringify({
                ordering: {
                  obj_id: decodeURIComponent(
                    new URL(operation.destinationUrl).pathname
                      .split('/')
                      .at(-1) as string,
                  ),
                  delta: 'bottom',
                },
              }),
            },
          );
        }
      } catch (error) {
        report.warnings.push({
          destinationUrl: parentUrl,
          code: 'ordering_failed',
          message: `Could not put the items back in their source order: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }
  };

  const reportItem = (operation: TransferOperation) => ({
    sourceUrl: operation.sourceUrl,
    destinationUrl: operation.destinationUrl,
    uid: operation.uid,
    kind: operation.kind,
  });

  const createAt = (
    parentUrl: string,
    payload: Record<string, unknown> | undefined,
  ) =>
    requestJson(
      apiUrlAtRoot(new URL(parentUrl), destinationRoot),
      destinationAuth,
      fetchImpl,
      { method: 'POST', body: JSON.stringify(payload) },
    );

  const recordFailure = (
    operation: TransferOperation,
    error: unknown,
    restored?: boolean,
  ) => {
    const transferError =
      error instanceof TransferError
        ? error
        : new TransferError(
            'unexpected_error',
            error instanceof Error ? error.message : 'Transfer failed.',
            500,
          );
    report.failed = {
      sourceUrl: operation.sourceUrl,
      destinationUrl: operation.destinationUrl,
      code: transferError.code,
      message: transferError.message,
      ...(restored === undefined ? {} : { restored }),
    };
  };

  // A long run can outlast the destination token: renew it shortly before it
  // expires. If renewal fails, the run carries on with the old token, which
  // still works until it expires.
  let renewalFailed = false;
  const keepTokenFresh = async () => {
    if (renewalFailed) return;
    try {
      await renewTokenIfDue(destinationAuth, destinationRoot, fetchImpl);
    } catch (error) {
      renewalFailed = true;
      report.warnings.push({
        destinationUrl: plan.destinationRootUrl,
        code: 'token_renewal_failed',
        message: `Could not renew the destination token, so the transfer goes on with the current one until it expires: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  };

  const total = plan.operations.length;
  let done = 0;
  operations: for (const operation of plan.operations) {
    if (signal?.aborted) {
      report.cancelled = true;
      break;
    }
    await keepTokenFresh();
    onProgress?.({
      done,
      total,
      current: {
        destinationUrl: operation.destinationUrl,
        status: operation.status,
        kind: operation.kind,
      },
    });
    done += 1;
    if (operation.status === 'reuse') {
      report.reused.push(operation.destinationUrl);
      continue;
    }

    if (operation.status === 'skip') {
      report.skipped.push(operation.destinationUrl);
      continue;
    }

    if (operation.status === 'update') {
      // Plone applies a PATCH in one transaction, so a failed update leaves
      // the item as it was.
      try {
        await requestJson(
          apiUrlAtRoot(new URL(operation.destinationUrl), destinationRoot),
          destinationAuth,
          fetchImpl,
          { method: 'PATCH', body: JSON.stringify(operation.payload) },
        );
      } catch (error) {
        recordFailure(operation, error);
        break operations;
      }
      report.updated.push(reportItem(operation));
      await alignState(operation);
      continue;
    }

    if (operation.status === 'replace') {
      // Back up the existing item, its files and images included, so a
      // failed recreate can put it back. Without a backup nothing is deleted.
      let restorePayload: Record<string, unknown>;
      let restoreState: string | undefined;
      try {
        const existing = await requestJson(
          apiUrlAtRoot(new URL(operation.destinationUrl), destinationRoot),
          destinationAuth,
          fetchImpl,
        );
        restorePayload = await prepareContentPayload(
          existing,
          new URL(operation.destinationUrl),
          destinationAuth,
          fetchImpl,
        );
        restoreState =
          typeof existing.review_state === 'string'
            ? existing.review_state
            : undefined;
      } catch (error) {
        recordFailure(
          operation,
          new TransferError(
            'backup_failed',
            `Could not back up ${operation.destinationUrl} before replacing it, so it was left in place: ${
              error instanceof Error ? error.message : String(error)
            }`,
            502,
          ),
        );
        break operations;
      }

      try {
        await requestJson(
          // plone.restapi exposes content deletion on the normal content URL;
          // unlike GET/POST, DELETE is not served through the ++api++ traversal.
          new URL(operation.destinationUrl),
          destinationAuth,
          fetchImpl,
          { method: 'DELETE' },
        );
      } catch (error) {
        // The original is still in place, so nothing to roll back.
        recordFailure(operation, error);
        break operations;
      }

      try {
        await createAt(operation.destinationParentUrl, operation.payload);
      } catch (error) {
        // The original is gone; put it back from the backup, in its state.
        let restored = false;
        try {
          await createAt(operation.destinationParentUrl, restorePayload);
          restored = true;
        } catch {
          restored = false;
        }
        recordFailure(operation, error, restored);
        if (restored && restoreState) {
          const warning = await alignReviewState(
            new URL(operation.destinationUrl),
            restoreState,
            destinationRoot,
            destinationAuth,
            fetchImpl,
          );
          if (warning) report.warnings.push(warning);
        }
        break operations;
      }
      report.replaced.push(reportItem(operation));
      await alignState(operation);
      continue;
    }

    try {
      await createAt(operation.destinationParentUrl, operation.payload);
    } catch (error) {
      recordFailure(operation, error);
      break operations;
    }
    report.created.push(reportItem(operation));
    await alignState(operation);
  }

  await keepTokenFresh();
  await restoreOrder();
  onProgress?.({
    done: report.failed ? done - 1 : report.cancelled ? done : total,
    total,
  });
  return report;
}
