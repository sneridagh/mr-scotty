import { describe, expect, test } from 'vitest';
import { isWithin, publicUrl, siteLabel, sitePath, splitPath } from './paths';

describe('sitePath', () => {
  test('gives the path below the site root', () => {
    expect(
      sitePath(
        'https://old.example/Plone/news/launch',
        'https://old.example/Plone',
      ),
    ).toBe('/news/launch');
    expect(
      sitePath('https://old.example/Plone', 'https://old.example/Plone/'),
    ).toBe('/');
  });

  test('keeps the whole path without a matching root', () => {
    expect(sitePath('https://old.example/Plone/news')).toBe('/Plone/news');
    expect(
      sitePath('https://old.example/Plone/news', 'https://new.example/Plone'),
    ).toBe('/Plone/news');
    expect(
      sitePath(
        'https://old.example/Plonetwo/news',
        'https://old.example/Plone',
      ),
    ).toBe('/Plonetwo/news');
    expect(sitePath('https://old.example/', 'https://old.example/')).toBe('/');
  });

  test('leaves something that is not a URL alone', () => {
    expect(sitePath('not a url')).toBe('not a url');
  });
});

describe('splitPath', () => {
  test('splits off the last segment', () => {
    expect(splitPath('/news/launch')).toEqual({
      parent: '/news/',
      leaf: 'launch',
    });
    expect(splitPath('/launch')).toEqual({ parent: '/', leaf: 'launch' });
    expect(splitPath('/')).toEqual({ parent: '', leaf: '/' });
  });
});

describe('siteLabel', () => {
  const thisSite = 'http://127.0.0.1:55001/plone';

  test('names the Aurora site’s own backend "this site"', () => {
    expect(siteLabel('http://127.0.0.1:55001/plone/news', thisSite)).toBe(
      'this site',
    );
    expect(isWithin('http://127.0.0.1:55001/plone2/news', thisSite)).toBe(
      false,
    );
  });

  test('names other sites by their host', () => {
    expect(siteLabel('http://127.0.0.1:55002/plone/news', thisSite)).toBe(
      '127.0.0.1:55002',
    );
    expect(siteLabel('https://old.example.org/Plone')).toBe('old.example.org');
  });
});

describe('publicUrl', () => {
  const thisSiteUrl = 'http://127.0.0.1:55001/plone';

  test('links content on this site to its Aurora page', () => {
    expect(
      publicUrl('http://127.0.0.1:55001/plone/blog/post', { thisSiteUrl }),
    ).toBe('/blog/post');
    expect(publicUrl('http://127.0.0.1:55001/plone', { thisSiteUrl })).toBe(
      '/',
    );
  });

  test('links content on another site to its frontend', () => {
    const site = {
      thisSiteUrl,
      siteUrl: 'https://cms.example.org/Plone',
      frontendUrl: 'https://www.example.org/',
    };
    expect(publicUrl('https://cms.example.org/Plone/blog/post', site)).toBe(
      'https://www.example.org/blog/post',
    );
    expect(publicUrl('https://cms.example.org/Plone', site)).toBe(
      'https://www.example.org',
    );
  });

  test('falls back to the backend URL without a frontend', () => {
    expect(
      publicUrl('https://cms.example.org/Plone/blog/post', {
        thisSiteUrl,
        siteUrl: 'https://cms.example.org/Plone',
      }),
    ).toBe('https://cms.example.org/Plone/blog/post');
  });
});
