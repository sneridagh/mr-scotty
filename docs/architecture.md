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
- When content already exists at its destination path, the conflict policy decides what happens:
  - `fail` (the default) aborts during preflight, before any write.
  - `skip` leaves the existing item untouched and beams the rest.
  - `update` patches the existing item with the source fields (`PATCH`), keeping its UUID, id, history, and position.
    The types must match.
  - `rename` creates the item next to the existing one under the first free id (`<id>-1`, `<id>-2`, …).
    The copy keeps the source UUID unless the destination already holds it, in which case Plone assigns a new one.
    Children and image references follow the new id.
  - `replace` deletes the existing item and recreates it, after a confirmation.
  Structural parents are always reused, and a referenced image already at its path with the same UUID is reused under `fail`, `skip`, and `rename`.
- With **Include everything inside**, Mr. Scotty also beams everything inside the selected item, folder by folder, as the source connection can see it: read anonymously, private items are left out.
  Each folder's children are read a page at a time, in their order, and the destination folder ends up in the same order.
  Referenced items are written before the content that references them, so relations resolve; the folders are then put back in source order.
  One transfer includes at most `MR_SCOTTY_MAX_ITEMS` items (500 by default), counting structural parents and referenced images; a larger folder is refused during preflight.
- Every item Mr. Scotty writes, structural parents included, is moved to its source workflow state with workflow transitions.
  Plone's REST API lists an item's transitions but not where they lead, so Mr. Scotty picks them by target state from Plone's stock workflows (`publish`, `submit`, `retract`, …), taking up to four steps.
  When the destination workflow cannot reach the state, the item stays where it got to and the report carries a warning; the transfer goes on.
- Publication and expiry dates (`effective`, `expires`), creators, and contributors are copied, and publishing keeps them.
  Plone stores dates to the minute.
  Creation and modification dates are set by the destination, because the REST API does not accept them.

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
- `MR_SCOTTY_MAX_ITEMS` — the most items one transfer may include (500 by
  default).

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
- Preserve creation and modification dates (needs a backend endpoint), ownership, aliases, translations, local roles, and sharing.
- Add content-type mapping and project-specific transformer registration.
- Add querystring preview.
- Add persistent jobs, SSE progress, cancellation, retry, and restart recovery.
- Transfer external image URLs and images embedded in rich-text HTML.
- Add production resource limits, DNS rebinding protection, and saved
  connections with encrypted secrets (the SSRF allowlist and private-network
  policy are now in place).
