/**
 * Reading plone.restapi tokens. A Plone token is a JWT whose claims name the
 * user (`sub`, `fullname`) and when it expires (`exp`, in seconds). The
 * signature is not checked here: only the site that issued a token can do
 * that. This is for telling people what they pasted, and for knowing when to
 * renew it.
 */

export interface TokenClaims {
  /** The user id. */
  sub?: string;
  fullname?: string;
  /** When the token expires. */
  expiresAt?: Date;
}

function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** The claims of a JWT, or undefined for anything that is not one. */
export function readTokenClaims(token: string): TokenClaims | undefined {
  const parts = token.trim().split('.');
  if (parts.length !== 3 || !parts[1]) return undefined;
  let claims: unknown;
  try {
    claims = JSON.parse(decodeBase64Url(parts[1]));
  } catch {
    return undefined;
  }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
    return undefined;
  }
  const { sub, fullname, exp } = claims as Record<string, unknown>;
  return {
    ...(typeof sub === 'string' && sub ? { sub } : {}),
    ...(typeof fullname === 'string' && fullname ? { fullname } : {}),
    ...(typeof exp === 'number' && Number.isFinite(exp)
      ? { expiresAt: new Date(exp * 1000) }
      : {}),
  };
}

/** Whether a token's `exp` has passed. False when it has none. */
export function isTokenExpired(token: string, now = Date.now()): boolean {
  const expiresAt = readTokenClaims(token)?.expiresAt;
  return expiresAt !== undefined && expiresAt.getTime() <= now;
}

/** Where to find a token, for help texts and error messages. */
export const TOKEN_HELP =
  'Log in to the site in your browser and copy the token from its cookies in the developer tools: auth_token on Volto sites, auth_seven on Aurora sites. This also works for people who log in through Google, GitHub or another provider.';

/**
 * Describes a pasted token: whose it is and when it expires, read from its
 * claims. Only the issuing site can tell whether it is genuine.
 */
export function describeToken(
  token: string,
  prefix: 'source' | 'destination',
  now = Date.now(),
): { description: string; expired: boolean } {
  const claims = token.trim() ? readTokenClaims(token) : undefined;
  if (!claims) return { description: TOKEN_HELP, expired: false };

  const user = claims.fullname || claims.sub;
  const expiresAt = claims.expiresAt;
  const when = expiresAt?.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  if (expiresAt && expiresAt.getTime() <= now) {
    return {
      description: `This token expired on ${when}. Log in to the site again and copy a new one.`,
      expired: true,
    };
  }
  const parts = [
    user ? `Token for ${user}.` : 'Plone token.',
    when ? `Expires on ${when}.` : '',
    prefix === 'destination' && when
      ? 'Mr. Scotty renews it during long transfers.'
      : '',
  ];
  return { description: parts.filter(Boolean).join(' '), expired: false };
}
