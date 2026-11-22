# Mr. Scotty architecture

Mr. Scotty transfers content between servers that implement the `plone.restapi` contract.
All source and destination traffic originates from the Aurora server.
The browser only starts jobs and observes their state.

## Initial contract

- A source URL identifies one content object.
- A destination URL identifies an existing destination container and acts as a path prefix.
- The source path relative to its Plone site root is preserved below that prefix.
- Missing structural ancestors are created as minimal Documents before the selected object.
- Source UUIDs are preserved.
  A path or UUID collision aborts preflight before any write occurs.
- Inline image, preview-image, and file fields are downloaded from the source and uploaded as base64 field data.
- Image blocks and image relations are scanned for internal references.
  Referenced content is planned as a dependency and block or relation URLs are rewritten to the destination.
- You do not need to add `++api++` to source or destination URLs.
  Mr. Scotty adds the traversal segment exactly once immediately after the
  server/site root (for example, `/++api++/blog/item`), and removes it from
  canonical URLs used for planning and reports. Mounted Plone sites such as
  `/Plone` are also supported (`/Plone/++api++/item`).
- Aurora's session token is reused only for its configured Plone destination.
  A source or destination may instead use anonymous, bearer-token, or Basic authentication.
- The initial conflict policy is `fail`.

For example, transferring `https://old.example/Plone/news/launch` to `https://new.example/Plone/archive` creates `https://new.example/Plone/archive/news/launch`.

## Transfer pipeline

1. Normalize and validate the HTTP(S) URLs, removing any existing `++api++` traversal segment.
2. Fetch the source object and discover its navigation root.
3. Fetch the destination container and discover its navigation root.
4. Build the source ancestor chain and destination path mapping.
5. Discover referenced image content and add its dependency paths.
6. Check every destination path and UUID without writing.
7. Download inline binary fields and prepare upload payloads.
8. Create missing structural Documents and referenced resources from the root downward.
9. Create the selected object with its original UUID and writable fields.
10. Return a structured report.

The transfer code is independent of React Router UI code.
This boundary will allow the synchronous first slice to move behind a persistent job runner and Server-Sent Events without changing content planning or execution.

## Security

The route is gated on the Manager role, not mere authentication: the loader and
action verify the session against the Manager-only `@controlpanels` endpoint of
the configured backend before doing any work.
Explicit credentials are used only in server memory and are never returned in plans or reports.
Parent and navigation-root URLs are rebased to the origin supplied by you, and HTTP redirects are not followed.

Outbound requests are subject to an opt-in SSRF policy, read from the
environment so local development and acceptance tests keep working unconfigured:

- `MR_SCOTTY_ALLOWED_HOSTS` — a comma-separated allowlist; when set, the source
  and destination hosts must match one of its entries exactly.
- `MR_SCOTTY_BLOCK_PRIVATE_NETWORK` — when truthy, refuses loopback, private,
  and link-local hosts (including the cloud metadata address).

A destructive `replace` captures the existing content before deleting it and
restores it best-effort if the recreate fails; when an operation fails mid-run,
the executor returns a partial report naming what was written rather than
discarding the progress.

Before production use, still add DNS rebinding protection (resolve-and-pin),
request and content size limits, audit logs, encrypted durable secret handling,
and restore of binary fields on a rolled-back replace.

## Fidelity roadmap

The first slice supports scalar/custom fields and Volto blocks on Documents.
Image and file fields use the standard `download` metadata and base64 upload shape from `plone.restapi`.

TODO:

- Recreate non-image relations in a second pass and rewrite internal links.
- Preserve workflow state, ownership, creators, dates, ordering, aliases, translations, local roles, and sharing.
- Add content-type mapping and project-specific transformer registration.
- Add `skip`, `update`, and `rename` conflict policies.
- Add querystring preview and bulk dependency planning.
- Add persistent jobs, SSE progress, cancellation, retry, and restart recovery.
- Transfer external image URLs and images embedded in rich-text HTML.
- Add production resource limits, DNS rebinding protection, and saved
  connections with encrypted secrets (the SSRF allowlist and private-network
  policy are now in place).
