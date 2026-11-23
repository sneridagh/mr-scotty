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

async function expectBeamed(page: Page, sourceUrl: string) {
  // A finished transfer switches to the Activity tab, which reports it.
  await expect(page.getByRole('tab', { name: 'Activity' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(
    page.getByText(`Beamed ${sourceUrl}`, { exact: true }),
  ).toBeVisible();
}

async function selectConflictPolicy(page: Page, label: string) {
  // The native radio input is visually hidden behind its styled card, so
  // target the option's label text and confirm the selection took.
  const radio = page.getByRole('radio', { name: new RegExp(label) });
  await expect(async () => {
    await page.getByText(label).click();
    await expect(radio).toBeChecked();
  }).toPass({ timeout: 10_000 });
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
  test('opens from its Site Setup entry', async ({ page }) => {
    await login(page);
    await page.goto('/@@controlpanel');
    await page.getByRole('link', { name: /Mr\. Scotty/ }).click();

    await expect(page).toHaveURL(/\/@@controlpanel\/mr-scotty$/);
    await expect(
      page.getByRole('button', { name: 'Inspect transfer' }),
    ).toBeVisible();
  });

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
    await expectBeamed(page, `${sourceApiURL}/${sourceId}`);

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

    // Each item arrives in its source workflow state, with its publication
    // date: the published document is published, the private image private.
    expect(sourceDocument.review_state).toBe('published');
    expect(destinationDocument.review_state).toBe('published');
    // Plone stores the publication date to the minute.
    expect(String(destinationDocument.effective).slice(0, 16)).toBe(
      String(sourceDocument.effective).slice(0, 16),
    );
    expect(destinationImage.review_state).toBe(sourceImage.review_state);
    expect(destinationDocument.creators).toEqual(sourceDocument.creators);

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
      page.getByRole('gridcell', { name: 'replace' }).first(),
    ).toBeVisible();

    // A destructive replace is confirmed in a dialog before it runs.
    await page.getByRole('button', { name: 'Beam content' }).click();
    await page.getByRole('button', { name: 'Delete & beam' }).click();
    await expectBeamed(page, `${sourceApiURL}/${sourceId}`);

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

  test.describe('conflict policies', () => {
    /**
     * A published source document and an unrelated destination document at
     * the same path, then a transfer with the chosen policy.
     */
    async function beamOverExisting(
      page: Page,
      policyLabel: string,
      expectedStatus: string,
    ) {
      const sourceApiURL = getDefaultSourceApiURL();
      const destinationApiURL = getDefaultApiURL();
      const id = `mr-scotty-policy-${Date.now()}`;
      await createContent(
        page,
        {
          contentType: 'Document',
          contentId: id,
          contentTitle: 'Source version',
          transition: 'publish',
        },
        { apiURL: sourceApiURL, username: 'admin', password: 'secret' },
      );
      await createContent(
        page,
        {
          contentType: 'Document',
          contentId: id,
          contentTitle: 'Destination version',
        },
        { apiURL: destinationApiURL, username: 'admin', password: 'secret' },
      );
      const sourceDocument = await getJson(
        page,
        apiContentURL(sourceApiURL, id),
        basicAuth('admin', 'secret'),
      );
      const { token } = await login(page);
      const destinationHeaders = bearerAuth(token);
      const before = await getJson(
        page,
        apiContentURL(destinationApiURL, id),
        destinationHeaders,
      );

      await page.goto('/mr-scotty');
      await waitForMrScottyHydration(page);
      await typeSourceUrl(page, `${sourceApiURL}/${id}`);
      await selectConflictPolicy(page, policyLabel);

      await page.getByRole('button', { name: 'Inspect transfer' }).click();
      await expect(page.getByText('Transfer plan')).toBeVisible();
      await expect(
        page.getByRole('gridcell', { name: expectedStatus }),
      ).toBeVisible();

      await page.getByRole('button', { name: 'Beam content' }).click();
      await expectBeamed(page, `${sourceApiURL}/${id}`);

      return {
        id,
        before,
        sourceDocument,
        destinationApiURL,
        destinationHeaders,
      };
    }

    test('skip leaves the existing item untouched', async ({ page }) => {
      const { id, before, destinationApiURL, destinationHeaders } =
        await beamOverExisting(page, 'Skip existing content', 'skip');

      await expect(
        page.getByRole('tabpanel').getByText('Skipped 1 item.'),
      ).toBeVisible();
      const after = await getJson(
        page,
        apiContentURL(destinationApiURL, id),
        destinationHeaders,
      );
      expect(after.title).toBe('Destination version');
      expect(after.UID).toBe(before.UID);
    });

    test('update writes the source fields into the existing item', async ({
      page,
    }) => {
      const { id, before, destinationApiURL, destinationHeaders } =
        await beamOverExisting(page, 'Update existing content', 'update');

      const after = await getJson(
        page,
        apiContentURL(destinationApiURL, id),
        destinationHeaders,
      );
      expect(after.title).toBe('Source version');
      // Updated in place: the existing item keeps its UUID.
      expect(after.UID).toBe(before.UID);
    });

    test('keep both beams the item under a free id', async ({ page }) => {
      const {
        id,
        before,
        sourceDocument,
        destinationApiURL,
        destinationHeaders,
      } = await beamOverExisting(page, 'Keep both', 'rename');

      const original = await getJson(
        page,
        apiContentURL(destinationApiURL, id),
        destinationHeaders,
      );
      const copy = await getJson(
        page,
        apiContentURL(destinationApiURL, `${id}-1`),
        destinationHeaders,
      );
      expect(original.title).toBe('Destination version');
      expect(original.UID).toBe(before.UID);
      expect(copy.title).toBe('Source version');
      // The source UUID was free at the destination, so the copy keeps it.
      expect(copy.UID).toBe(sourceDocument.UID);
    });
  });
});
