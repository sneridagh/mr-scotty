import { expect, test as base } from '@playwright/test';

import {
  getDefaultApiURL,
  getDefaultSourceApiURL,
  setup,
  teardown,
} from './reset-fixture';

type TestFixtures = {
  resetBackend: void;
};

export const test = base.extend<TestFixtures>({
  resetBackend: [
    async ({ page, request }, use) => {
      const destinationApiURL = getDefaultApiURL();
      const sourceApiURL = getDefaultSourceApiURL();

      await teardown(request, destinationApiURL);
      await setup(request, destinationApiURL);
      await teardown(request, sourceApiURL);
      await setup(request, sourceApiURL);

      try {
        await use();
      } finally {
        // Close the live page before resetting the backend so teardown does
        // not trigger refresh noise that obscures the real test failure.
        await page.close().catch(() => {});
        await teardown(request, sourceApiURL);
        await teardown(request, destinationApiURL);
      }
    },
    { auto: true },
  ],
});

export { expect };
