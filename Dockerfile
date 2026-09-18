# syntax=docker/dockerfile:1
ARG AURORA_VERSION=1.0.0-alpha.9
FROM plone/aurora-builder:${AURORA_VERSION} AS builder

COPY --chown=node packages/mr-scotty /app/packages/mr-scotty
COPY --chown=node registry.config.ts /app/
COPY --chown=node Makefile /app/Makefile
COPY --chown=node pnpm-workspace.yaml /app/pnpm-workspace.yaml
COPY --chown=node .pnpmfile.cjs /app/.pnpmfile.cjs
COPY --chown=node package.json /app/package.json.temp
COPY --chown=node pnpm-lock.yaml /app/pnpm-lock.yaml

RUN --mount=type=cache,id=pnpm,target=/app/.pnpm-store,uid=1000 <<EOT
    set -e
    python3 -c "import json; orig_data = json.load(open('package.json.temp')); orig_deps = orig_data['dependencies']; data = json.load(open('package.json')); data['dependencies'].update(orig_deps); json.dump(data, open('package.json', 'w'), indent=2)"
    rm package.json.temp
    pnpm install && make build-deps
    pnpm build
    # This is necessary because the build is trying to recreate the node_modules folder
    # by telling it to CI=1 it will just recreate them
    CI=1 pnpm install --prod
EOT

FROM plone/aurora-prod-config:${AURORA_VERSION}

LABEL maintainer="Victor Fernandez de Alba <sneridagh@gmail.com>" \
      org.label-schema.name="mr-scotty-frontend" \
      org.label-schema.description="Mr.Scotty frontend image." \
      org.label-schema.vendor="Victor Fernandez de Alba"

COPY --from=builder /app/ /app/

RUN <<EOT
    set -e
    # CI=true keeps corepack/pnpm non-interactive: if it decides to reconcile the
    # copied node_modules it must not block on a modules-purge confirmation
    # prompt (there is no TTY during the image build).
    export CI=true
    corepack enable pnpm
    corepack use pnpm@11.20.0
    corepack prepare pnpm@11.20.0 --activate
EOT
