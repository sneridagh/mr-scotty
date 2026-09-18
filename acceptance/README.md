# Playwright acceptance tests

End-to-end acceptance tests driven by [Playwright](https://playwright.dev/),
running against two Plone **acceptance** backends (with `RobotRemote` enabled,
so both backends can be reset between tests) and a running Aurora frontend.

The destination backend listens on port `55001`; the source backend listens on
port `55002`. The Mr. Scotty acceptance test seeds the source through its REST
API, then transfers it through the real Aurora server-side route. This keeps
the test close to production behavior without relying on a browser mock or a
second application-specific fixture server.

They live in `acceptance/tests/` and are configured through
`../playwright-acceptance.config.ts`.

## Layout

- `tests/reset-fixture.ts` — `setup`/`teardown` helpers that call `RobotRemote`
  to reset the backend ZODB to the `VOLTO_ROBOT_TESTING` baseline.
- `tests/test.ts` — the extended `test`/`expect`. Provides an auto `resetBackend`
  fixture that tears down and sets up the backend around every test.
- `tests/login.ts` — `login(page)`, authenticates via `@login` and sets the
  `auth_token` cookie (equivalent to Cypress' `cy.autologin`).
- `tests/content.ts` — `createContent(...)`, creates content through the REST
  API (equivalent to `cy.createContent`).
- `tests/mr-scotty.test.ts` — seeds a source document and image, then verifies
  the end-to-end transfer, UUID preservation, image reference rewriting, and
  binary resource transfer. It also verifies the opt-in overwrite behavior
  leaves unrelated destination siblings untouched.
- `tests/accessibility.ts` — `expectNoAccessibilityViolations(page, ...)`, an
  axe-core based accessibility assertion.
- `tests/*.test.ts` — the tests themselves.

## Configuration

The helpers read the following environment variables (with sensible defaults for
the acceptance backend):

- `BACKEND_HOST` (default `127.0.0.1`)
- `SITE_ID` (default `plone`)
- `API_PATH` (default `http://${BACKEND_HOST}:55001/${SITE_ID}`)
- `SOURCE_BACKEND_HOST` (default `BACKEND_HOST` or `127.0.0.1`)
- `SOURCE_BACKEND_PORT` (default `55002`)
- `SOURCE_SITE_ID` (default `SITE_ID` or `plone`)
- `SOURCE_API_PATH` (default `http://${SOURCE_BACKEND_HOST}:55002/${SOURCE_SITE_ID}`)
- `FRONTEND_URL` (default `http://localhost:3000`)

## Running locally

From the repository root, start the two acceptance containers and frontend in
separate terminals, then run the suite:

```bash
make acceptance-backend-start
make acceptance-source-backend-start
make acceptance-frontend-dev-start
make acceptance-test
```

CI uses the corresponding headless targets and starts both backends before
running `make ci-acceptance-test`.

To iterate interactively (with the Playwright UI) against already-running
servers, start both acceptance backends and the frontend, then:

```bash
make acceptance-test
```

The first time, install the browsers used by Playwright:

```bash
make -C frontend install-acceptance
```
