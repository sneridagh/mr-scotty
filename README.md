# Mr.Scotty (mr-scotty)

Mr.Scotty takes care of beaming up and down Plone content.

[![npm](https://img.shields.io/npm/v/mr-scotty)](https://www.npmjs.com/package/mr-scotty)
[![Code analysis checks](https://github.com/sneridagh/mr-scotty/actions/workflows/code.yml/badge.svg)](https://github.com/sneridagh/mr-scotty/actions/workflows/code.yml)
[![Unit tests](https://github.com/sneridagh/mr-scotty/actions/workflows/unit.yml/badge.svg)](https://github.com/sneridagh/mr-scotty/actions/workflows/unit.yml)
[![Acceptance tests](https://github.com/sneridagh/mr-scotty/actions/workflows/acceptance.yml/badge.svg)](https://github.com/sneridagh/mr-scotty/actions/workflows/acceptance.yml)

Mr. Scotty is a [Plone Aurora](https://github.com/plone/aurora) control panel that beams content from one Plone site to another through `plone.restapi`.
Pick a source item and a destination folder, inspect the transfer plan, and beam it.
The transfer runs on the Aurora server, with live progress, and can be cancelled.

## Features

- Server-side transfer between `plone.restapi` compliant servers.
- Source-relative path and UUID preservation.
- Whole folders can be beamed with everything inside, in their order.
- Workflow state, publication dates and creators are kept.
- Preflight conflict detection and automatic structural parent creation.
- Conflict policies for content that already exists: fail, skip, update in place, keep both under a new id, or replace.
- Inline image/file fields and internal image-block dependencies are transferred with their content.
- Transfers run as background jobs with live progress in the Activity tab, and can be cancelled.
- Anonymous, bearer token, or username and password connections. Bearer tokens work for people who log in through Google, GitHub or another provider, and are renewed during long transfers.

See the [architecture and current transfer contract](docs/architecture.md).

## Requirements

- A Plone Aurora project.
- Plone 6 backends with `plone.restapi`, for the source and the destination.
- A user with the Manager role on the Aurora site: the control panel is only open to Managers.

## Installation

Add `mr-scotty` to your Aurora project's dependencies:

```shell
pnpm add mr-scotty
```

Register it in your project's `registry.config.ts`:

```ts
import { addons } from '@plone/aurora/registry.config';

addons.push('mr-scotty');

export { addons };
```

Restart Aurora.
Mr. Scotty appears in Site Setup, in the Content group, and opens at `/@@controlpanel/mr-scotty`.

## Configuration

Mr. Scotty reads these environment variables on the Aurora server.
All are optional.

- `MR_SCOTTY_ALLOWED_HOSTS`: a comma-separated list of the only hosts Mr. Scotty may read from or write to.
- `MR_SCOTTY_BLOCK_PRIVATE_NETWORK`: when set to a true value, Mr. Scotty refuses loopback, private and link-local hosts.
- `MR_SCOTTY_MAX_ITEMS`: the most items one transfer may include. The default is 500.

On a public deployment, set `MR_SCOTTY_ALLOWED_HOSTS` or `MR_SCOTTY_BLOCK_PRIVATE_NETWORK`, so the server can't be used to reach internal hosts.
See the [security notes](docs/architecture.md#security).

Transfer jobs are kept in the memory of the Aurora server process.
A restart loses running jobs and the Activity history, and with several server processes, each one only shows its own jobs.

## Development

The add-on is developed in isolation, in a pnpm workspace that checks out Plone Aurora with `mrs-developer`.


### Pre-requisites

-   [Node.js](https://6.docs.plone.org/install/create-project.html#node-js)
-   [Make](https://6.docs.plone.org/install/create-project.html#make)
-   [Docker](https://6.docs.plone.org/install/create-project.html#docker)

Install and enable the latest Corepack. Corepack will resolve the pnpm version
pinned by this repository's `packageManager` field.

```shell
npm install --global corepack@latest
corepack enable
```


### Make convenience commands

Run `make help` to list the available commands.

```text
help                             Show this help
install                          Installs the add-on in a development environment
start                            Starts Volto, allowing reloading of the add-on during development
build                            Build a production bundle for distribution of the project with the add-on
i18n                             Sync i18n
ci-i18n                          Check if i18n is not synced
format                           Format codebase
lint                             Lint, or catch and remove problems, in code base
release                          Release the add-on on npmjs.org
release-dry-run                  Dry-run the release of the add-on on npmjs.org
test                             Run unit tests
ci-test                          Run unit tests in CI
backend-docker-start             Starts a Docker-based backend for development
storybook-start                  Start Storybook server on port 6006
storybook-build                  Build Storybook
acceptance-frontend-dev-start    Start acceptance frontend in development mode
acceptance-frontend-prod-start   Start acceptance frontend in production mode
acceptance-backend-start         Start backend acceptance server
ci-acceptance-backend-start      Start backend acceptance server in headless mode for CI
install-acceptance               Install the Playwright browsers used by the acceptance tests
acceptance-test                  Start the acceptance tests in interactive (UI) mode
ci-acceptance-test               Run the acceptance tests in headless mode for CI
```

### Development environment set up

Install package requirements.

```shell
make install
```

### Start developing

Start the backend.

```shell
make backend-docker-start
```

In a separate terminal session, start the frontend.

```shell
make start
```

### Lint code

Run ESlint, Prettier, and Stylelint in analyze mode.

```shell
make lint
```

### Format code

Run ESlint, Prettier, and Stylelint in fix mode.

```shell
make format
```

### i18n

Extract the i18n messages to locales.

```shell
make i18n
```

### Unit tests

Run unit tests.

```shell
make test
```

### Run acceptance tests

Run each of these steps in separate terminal sessions.

In the first session, start the frontend in development mode.

```shell
make acceptance-frontend-dev-start
```

In the second session, start the backend acceptance server.

```shell
make acceptance-backend-start
```

In the third session, start the acceptance test runner (Playwright UI).

```shell
make acceptance-test
```

## License

The project is licensed under the MIT license.

## Credits and Acknowledgements 🙏

Crafted with care by **Generated using [Cookieplone (2.0.0)](https://github.com/plone/cookieplone) and [cookieplone-templates (98096de)](https://github.com/plone/cookieplone-templates/commit/98096dea66c9131d77568d02e43e42eb7bf90eb8) on 2026-09-18 17:24:38.656235**. A special thanks to all contributors and supporters!
