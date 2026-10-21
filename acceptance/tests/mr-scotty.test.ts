import type { Page } from '@playwright/test';

import { expect, test } from './test';
import { createContent, type RequestOptions } from './content';
import { getDefaultApiURL, getDefaultSourceApiURL } from './reset-fixture';
import { login } from './login';

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function apiContentURL(apiURL: string, id: string) {
  const normalized = apiURL.replace(/\/+$/, '');
  return normalized.includes('/++api++/') || normalized.endsWith('/++api++')
    ? `${normalized}/${id}`
    : `${normalized}/++api++/${id}`;
}

function basicAuth(username: string, password: string) {
  return {
    Authorization: `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`,
  };
}

function bearerAuth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

async function typeSourceUrl(page: Page, sourceUrl: string) {
  const sourceInput = page.locator('input[name="sourceUrl"]');
  // The source field has no defaultValue, so React Aria seeds its controlled
  // state to empty and wipes the input once, when the client hydrates. A value
  // filled before that one-time render is discarded, so fill, let the wipe
  // happen, and refill until the value survives it.
  await expect(async () => {
    await sourceInput.fill(sourceUrl);
    await page.waitForTimeout(300);
    await expect(sourceInput).toHaveValue(sourceUrl);
  }).toPass({ timeout: 20_000 });
}

async function waitForMrScottyHydration(page: Page) {
  await expect(
    page.getByRole('button', { name: 'Inspect transfer' }),
  ).toHaveAttribute('name', 'intent');
  await expect(
    page.getByRole('button', { name: 'Inspect transfer' }),
  ).toHaveAttribute('value', 'preflight');
  await expect(
    page.getByRole('button', { name: 'Beam content' }),
  ).toHaveAttribute('value', 'transfer');
}

async function getJson(
  page: Page,
  url: string,
  headers: Record<string, string>,
) {
  const response = await page.request.get(url, {
    headers: { Accept: 'application/json', ...headers },
  });
  expect(response.ok(), `${url} returned ${response.status()}`).toBeTruthy();
  return response.json() as Promise<Record<string, unknown>>;
}

test.describe('Mr. Scotty', () => {
  test('beams a document and its image dependency between Plone servers', async ({
    page,
  }) => {
    const sourceApiURL = getDefaultSourceApiURL();
    const destinationApiURL = getDefaultApiURL();
    const sourceAuth: RequestOptions = {
      apiURL: sourceApiURL,
      username: 'admin',
      password: 'secret',
    };
    const sourceId = `mr-scotty-source-${Date.now()}`;
    const imageId = `${sourceId}-image`;

    await createContent(
      page,
      {
        contentType: 'Image',
        contentId: imageId,
        contentTitle: 'Mr. Scotty source image',
        bodyModifier: (body) => ({
          ...body,
          image: {
            data: TINY_PNG_BASE64,
            encoding: 'base64',
            filename: 'mr-scotty.png',
            'content-type': 'image/png',
          },
        }),
      },
      sourceAuth,
    );

    await createContent(
      page,
      {
        contentType: 'Document',
        contentId: sourceId,
        contentTitle: 'Mr. Scotty source document',
        transition: 'publish',
        bodyModifier: (body) => ({
          ...body,
          blocks: {
            image: {
              '@type': 'image',
              url: `${sourceApiURL}/${imageId}`,
              alt: 'Mr. Scotty source image',
            },
          },
          blocks_layout: { items: ['image'] },
        }),
      },
      sourceAuth,
    );

    const sourceHeaders = basicAuth('admin', 'secret');
    const sourceDocument = await getJson(
      page,
      apiContentURL(sourceApiURL, sourceId),
      sourceHeaders,
    );
    const sourceImage = await getJson(
      page,
      apiContentURL(sourceApiURL, imageId),
      sourceHeaders,
    );

    const { token: destinationToken } = await login(page);

    await page.goto('/mr-scotty');
    await waitForMrScottyHydration(page);
    await typeSourceUrl(page, `${sourceApiURL}/${sourceId}`);

    await page.getByRole('button', { name: 'Inspect transfer' }).click();
    await expect(page.getByText('Transfer plan')).toBeVisible();
    await expect(
      page.getByText(`${destinationApiURL}/${sourceId}`, { exact: true }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Beam content' }).click();
    await expect(page.getByText('Transfer complete')).toBeVisible();

    const destinationHeaders = bearerAuth(destinationToken);
    const destinationDocument = await getJson(
      page,
      apiContentURL(destinationApiURL, sourceId),
      destinationHeaders,
    );
    const destinationImage = await getJson(
      page,
      apiContentURL(destinationApiURL, imageId),
      destinationHeaders,
    );

    expect(destinationDocument.UID).toBe(sourceDocument.UID);
    expect(destinationImage.UID).toBe(sourceImage.UID);
    const destinationBlocks = destinationDocument.blocks as {
      image: { url: string };
    };
    expect(destinationBlocks.image.url).toBe(`${destinationApiURL}/${imageId}`);

    const destinationImageField = destinationImage.image as {
      download?: string;
    };
    expect(destinationImageField.download).toBeTruthy();
    const imageResponse = await page.request.get(
      destinationImageField.download as string,
      { headers: destinationHeaders },
    );
    expect(imageResponse.ok()).toBeTruthy();
    expect(Buffer.from(await imageResponse.body())).toEqual(
      Buffer.from(TINY_PNG_BASE64, 'base64'),
    );
  });

  test('overwrites the imported path while preserving an unrelated sibling', async ({
    page,
  }) => {
    const sourceApiURL = getDefaultSourceApiURL();
    const destinationApiURL = getDefaultApiURL();
    const sourceAuth: RequestOptions = {
      apiURL: sourceApiURL,
      username: 'admin',
      password: 'secret',
    };
    const destinationAuth: RequestOptions = {
      apiURL: destinationApiURL,
      username: 'admin',
      password: 'secret',
    };
    const sourceId = `mr-scotty-overwrite-${Date.now()}`;
    const imageId = `${sourceId}-image`;
    const siblingId = `${sourceId}-sibling`;

    await createContent(
      page,
      {
        contentType: 'Image',
        contentId: imageId,
        contentTitle: 'New source image',
        bodyModifier: (body) => ({
          ...body,
          image: {
            data: TINY_PNG_BASE64,
            encoding: 'base64',
            filename: 'mr-scotty-overwrite.png',
            'content-type': 'image/png',
          },
        }),
      },
      sourceAuth,
    );
    await createContent(
      page,
      {
        contentType: 'Document',
        contentId: sourceId,
        contentTitle: 'New source version',
        transition: 'publish',
        bodyModifier: (body) => ({
          ...body,
          blocks: {
            image: {
              '@type': 'image',
              url: `${sourceApiURL}/${imageId}`,
              alt: 'New source image',
            },
          },
          blocks_layout: { items: ['image'] },
        }),
      },
      sourceAuth,
    );
    await createContent(
      page,
      {
        contentType: 'Image',
        contentId: imageId,
        contentTitle: 'Old destination image',
        bodyModifier: (body) => ({
          ...body,
          image: {
            data: TINY_PNG_BASE64,
            encoding: 'base64',
            filename: 'old-image.png',
            'content-type': 'image/png',
          },
        }),
      },
      destinationAuth,
    );
    await createContent(
      page,
      {
        contentType: 'Document',
        contentId: sourceId,
        contentTitle: 'Old destination version',
      },
      destinationAuth,
    );
    await createContent(
      page,
      {
        contentType: 'Document',
        contentId: siblingId,
        contentTitle: 'Unrelated destination sibling',
      },
      destinationAuth,
    );

    const sourceDocument = await getJson(
      page,
      apiContentURL(sourceApiURL, sourceId),
      basicAuth('admin', 'secret'),
    );
    const sourceImage = await getJson(
      page,
      apiContentURL(sourceApiURL, imageId),
      basicAuth('admin', 'secret'),
    );
    const { token: destinationToken } = await login(page);

    await page.goto('/mr-scotty');
    await waitForMrScottyHydration(page);
    // Fill first: typeSourceUrl waits out hydration, after which the policy
    // selection sticks. The native radio input is visually hidden behind its
    // styled card, so target the option's label text and confirm it took.
    await typeSourceUrl(page, `${sourceApiURL}/${sourceId}`);
    const replaceRadio = page.getByRole('radio', {
      name: /Replace existing content/,
    });
    await expect(async () => {
      await page.getByText('Replace existing content').click();
      await expect(replaceRadio).toBeChecked();
    }).toPass({ timeout: 10_000 });

    await page.getByRole('button', { name: 'Inspect transfer' }).click();
    await expect(page.getByText('Transfer plan')).toBeVisible();
    await expect(
      page.getByRole('cell', { name: 'replace' }).first(),
    ).toBeVisible();

    // A destructive replace is confirmed in a dialog before it runs.
    await page.getByRole('button', { name: 'Beam content' }).click();
    await page.getByRole('button', { name: 'Delete & beam' }).click();
    await expect(page.getByText('Transfer complete')).toBeVisible();

    const destinationHeaders = bearerAuth(destinationToken);
    const destinationDocument = await getJson(
      page,
      apiContentURL(destinationApiURL, sourceId),
      destinationHeaders,
    );
    const destinationImage = await getJson(
      page,
      apiContentURL(destinationApiURL, imageId),
      destinationHeaders,
    );
    const sibling = await getJson(
      page,
      apiContentURL(destinationApiURL, siblingId),
      destinationHeaders,
    );

    expect(destinationDocument.UID).toBe(sourceDocument.UID);
    expect(destinationImage.UID).toBe(sourceImage.UID);
    expect(destinationDocument.title).toBe('New source version');
    expect(destinationImage.title).toBe('New source image');
    const destinationBlocks = destinationDocument.blocks as {
      image: { url: string };
    };
    expect(destinationBlocks.image.url).toBe(`${destinationApiURL}/${imageId}`);
    expect(sibling.title).toBe('Unrelated destination sibling');
  });
});
