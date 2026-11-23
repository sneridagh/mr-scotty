import { describe, expect, test } from 'vitest';
import {
  describeToken,
  isTokenExpired,
  readTokenClaims,
  TOKEN_HELP,
} from './token';

function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function makeToken(claims: Record<string, unknown>): string {
  return [
    base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' })),
    base64Url(JSON.stringify(claims)),
    'signature',
  ].join('.');
}

describe('readTokenClaims', () => {
  test('reads the user and the expiry of a Plone token', () => {
    const token = makeToken({
      sub: 'admin',
      fullname: 'Ådmin',
      exp: 1_800_000_000,
    });
    expect(readTokenClaims(token)).toEqual({
      sub: 'admin',
      fullname: 'Ådmin',
      expiresAt: new Date(1_800_000_000_000),
    });
  });

  test('returns undefined for anything that is not a JWT', () => {
    expect(readTokenClaims('secret')).toBeUndefined();
    expect(readTokenClaims('a.b.c')).toBeUndefined();
    expect(readTokenClaims(`x.${base64Url('[1]')}.y`)).toBeUndefined();
  });

  test('leaves out claims of the wrong type', () => {
    expect(readTokenClaims(makeToken({ sub: 1, exp: 'soon' }))).toEqual({});
  });
});

describe('isTokenExpired', () => {
  test('compares exp with now', () => {
    const token = makeToken({ exp: 1_000 });
    expect(isTokenExpired(token, 999_999)).toBe(false);
    expect(isTokenExpired(token, 1_000_000)).toBe(true);
  });

  test('treats a token without exp as not expired', () => {
    expect(isTokenExpired(makeToken({ sub: 'admin' }))).toBe(false);
    expect(isTokenExpired('secret')).toBe(false);
  });
});

describe('describeToken', () => {
  const now = 1_000_000_000_000;

  test('shows where to find a token when there is none', () => {
    expect(describeToken('', 'source', now)).toEqual({
      description: TOKEN_HELP,
      expired: false,
    });
    expect(describeToken('not-a-jwt', 'source', now).description).toBe(
      TOKEN_HELP,
    );
  });

  test('names the user and the expiry, and renewal for the destination', () => {
    const token = makeToken({
      sub: 'ana',
      fullname: 'Ana',
      exp: now / 1000 + 3600,
    });
    const source = describeToken(token, 'source', now);
    expect(source.expired).toBe(false);
    expect(source.description).toMatch(/^Token for Ana\. Expires on .+\.$/);
    expect(describeToken(token, 'destination', now).description).toContain(
      'renews it during long transfers',
    );
  });

  test('flags an expired token', () => {
    const token = makeToken({ sub: 'ana', exp: now / 1000 - 1 });
    expect(describeToken(token, 'destination', now)).toMatchObject({
      expired: true,
      description: expect.stringContaining('expired on'),
    });
  });
});
