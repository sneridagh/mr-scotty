import {
  apiUrlAtRoot,
  hasValue,
  isRecord,
  requestJson,
  TransferError,
  type EndpointAuth,
  type Fetch,
  type TransferOperation,
  type TransferPlan,
  type TransferReport,
} from './transfer.server';

/**
 * Checking a finished transfer: every item that was written is read back
 * from the destination and compared with what was meant to arrive. The
 * checks look at what the destination actually stored, so they catch
 * differences between servers that the plan could not foresee.
 */

export type VerificationCode =
  /** The item can't be read on the destination. */
  | 'missing'
  /** Anonymous visitors see it on the source, but not on the destination. */
  | 'not_visible'
  /** The destination gave it another UID. */
  | 'uid_changed'
  /** A file or image is missing, or has another size. */
  | 'file_mismatch'
  /** A field still points at the source site. */
  | 'source_urls'
  /** A field with a value arrived empty. */
  | 'field_not_stored';

export interface VerificationProblem {
  code: VerificationCode;
  /** Problems break the item; warnings are worth a look. */
  severity: 'problem' | 'warning';
  message: string;
  /** The fields concerned, if any. */
  fields?: string[];
}

export interface VerifiedItem {
  destinationUrl: string;
  title: string;
  problems: VerificationProblem[];
}

export interface Verification {
  /** How many written items were checked. */
  checked: number;
  /** Items with no problems and no warnings. */
  passed: number;
  /** Items with at least one problem or warning, in plan order. */
  items: VerifiedItem[];
  /** Set when the check itself could not run to the end. */
  error?: string;
}

const ANONYMOUS: EndpointAuth = { type: 'anonymous' };
/** How many items are checked at the same time. */
const CONCURRENCY = 4;
/** How many field paths a problem names at most. */
const MAX_FIELDS = 5;
/** Fields that are not compared: the server sets or reshapes them. */
const NOT_COMPARED = new Set([
  '@type',
  'id',
  'UID',
  'blocks',
  'blocks_layout',
  'review_state',
  // Set by the destination from who wrote the item.
  'creators',
]);
/**
 * Parts of a stored item that are not its own fields: summaries of other
 * items, which are checked on their own.
 */
const NOT_SCANNED = new Set(['@components', 'items', 'parent', 'breadcrumbs']);

function normalizeUid(uid: unknown): string {
  return typeof uid === 'string' ? uid.replaceAll('-', '').toLowerCase() : '';
}

/** The size of base64 data once decoded. */
function decodedSize(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

function isFilePayload(
  value: unknown,
): value is { data: string; encoding?: string; filename?: string } {
  return isRecord(value) && typeof value.data === 'string';
}

/** Whether `text` mentions a URL below `prefix`, and not a longer host. */
function mentions(text: string, prefix: string): boolean {
  let index = text.indexOf(prefix);
  while (index !== -1) {
    const next = text[index + prefix.length];
    if (next === undefined || !/[\w.-]/.test(next)) return true;
    index = text.indexOf(prefix, index + 1);
  }
  return false;
}

/** The paths of the string values below `value` that mention `prefix`. */
function pathsMentioning(
  value: unknown,
  prefix: string,
  path = '',
  found: string[] = [],
): string[] {
  if (typeof value === 'string') {
    if (mentions(value, prefix)) found.push(path);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) =>
      pathsMentioning(item, prefix, `${path}[${index}]`, found),
    );
  } else if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      pathsMentioning(child, prefix, path ? `${path}.${key}` : key, found);
    }
  }
  return found;
}

function listFields(fields: string[]): string {
  const shown = fields.slice(0, MAX_FIELDS).join(', ');
  return fields.length > MAX_FIELDS
    ? `${shown} and ${fields.length - MAX_FIELDS} more`
    : shown;
}

/** Reads an item, or returns why it couldn't. */
async function read(
  url: URL,
  auth: EndpointAuth,
  fetchImpl: Fetch,
): Promise<{ content?: Record<string, unknown>; status?: number }> {
  try {
    return { content: await requestJson(url, auth, fetchImpl) };
  } catch (error) {
    if (error instanceof TransferError) return { status: error.status };
    throw error;
  }
}

async function verifyItem(
  operation: TransferOperation,
  context: {
    plan: TransferPlan;
    sourceRoot: URL;
    destinationRoot: URL;
    destinationAuth: EndpointAuth;
    sourcePrefix?: string;
    droppedByType: Map<string, Set<string>>;
    fetchImpl: Fetch;
  },
): Promise<VerificationProblem[]> {
  const { destinationRoot, destinationAuth, fetchImpl } = context;
  const problems: VerificationProblem[] = [];
  const destinationApiUrl = apiUrlAtRoot(
    new URL(operation.destinationUrl),
    destinationRoot,
  );

  const stored = await read(destinationApiUrl, destinationAuth, fetchImpl);
  if (!stored.content) {
    return [
      {
        code: 'missing',
        severity: 'problem',
        message: `The destination answers ${stored.status ?? 'an error'} for it.`,
      },
    ];
  }
  const content = stored.content;

  // Visibility: what anyone may see on the source, anyone may see here.
  const publicOnSource = await read(
    apiUrlAtRoot(new URL(operation.sourceUrl), context.sourceRoot),
    ANONYMOUS,
    fetchImpl,
  );
  if (publicOnSource.content) {
    const publicHere = await read(destinationApiUrl, ANONYMOUS, fetchImpl);
    if (!publicHere.content) {
      problems.push({
        code: 'not_visible',
        severity: 'problem',
        message: `Anonymous visitors can see it on the source, but the destination answers them ${publicHere.status ?? 'with an error'}${
          typeof content.review_state === 'string' && content.review_state
            ? `: it is ${content.review_state}`
            : ''
        }.`,
      });
    }
  }

  const payload = operation.payload ?? {};

  // The UID, unless the item was meant to get a new one.
  if (
    operation.status !== 'update' &&
    typeof payload.UID === 'string' &&
    normalizeUid(payload.UID) !== normalizeUid(content.UID)
  ) {
    problems.push({
      code: 'uid_changed',
      severity: 'problem',
      message: `It was written with the UID ${payload.UID}, but the destination has ${String(content.UID)}.`,
    });
  }

  // Files and images: there, and the same size.
  for (const [field, value] of Object.entries(payload)) {
    if (!isFilePayload(value)) continue;
    const expected = decodedSize(value.data);
    const storedFile = content[field];
    const size = isRecord(storedFile) ? storedFile.size : undefined;
    if (!isRecord(storedFile)) {
      problems.push({
        code: 'file_mismatch',
        severity: 'problem',
        message: `The ${field} is missing on the destination.`,
        fields: [field],
      });
    } else if (typeof size === 'number' && size !== expected) {
      problems.push({
        code: 'file_mismatch',
        severity: 'problem',
        message: `The ${field} has ${size} bytes on the destination, and ${expected} on the source.`,
        fields: [field],
      });
    }
  }

  // Fields that still point at the source site.
  if (context.sourcePrefix) {
    const fields = Object.fromEntries(
      Object.entries(content).filter(([key]) => !NOT_SCANNED.has(key)),
    );
    const paths = pathsMentioning(fields, context.sourcePrefix);
    if (paths.length > 0) {
      problems.push({
        code: 'source_urls',
        severity: 'warning',
        message: `Still points at ${context.sourcePrefix} in ${listFields(paths)}.`,
        fields: paths,
      });
    }
  }

  // Fields with a value that arrived empty, such as a relation the
  // destination could not resolve. Fields the chosen type lacks are known
  // already from the plan.
  const known = context.droppedByType.get(
    operation.sourceType ?? operation.type,
  );
  const empty = Object.entries(payload)
    .filter(
      ([field, value]) =>
        !field.startsWith('@') &&
        !NOT_COMPARED.has(field) &&
        !isFilePayload(value) &&
        !known?.has(field) &&
        // An unset flag means the same as no flag.
        value !== false &&
        hasValue(value) &&
        !hasValue(content[field]),
    )
    .map(([field]) => field);
  if (empty.length > 0) {
    problems.push({
      code: 'field_not_stored',
      severity: 'warning',
      message: `Arrived empty: ${listFields(empty)}.`,
      fields: empty,
    });
  }

  return problems;
}

/**
 * Reads back every item the run wrote and reports what differs from the
 * plan. Reused and skipped items are left out: the run didn't touch them.
 */
export async function verifyTransfer(
  plan: TransferPlan,
  report: TransferReport,
  destinationAuth: EndpointAuth,
  fetchImpl: Fetch = fetch,
  { signal }: { signal?: AbortSignal } = {},
): Promise<Verification> {
  const written = new Set(
    [...report.created, ...report.replaced, ...report.updated].map(
      (item) => item.destinationUrl,
    ),
  );
  const operations = plan.operations.filter((operation) =>
    written.has(operation.destinationUrl),
  );

  const sourceRoot = new URL(plan.sourceRootUrl);
  const destinationRoot = new URL(plan.destinationRootUrl);
  // The source site as its URLs start. Beaming within one site, every
  // destination URL starts so too, so the check is left out.
  const prefix = plan.sourceRootUrl.replace(/\/+$/, '');
  const sourcePrefix = plan.destinationRootUrl.startsWith(prefix)
    ? undefined
    : prefix;
  const droppedByType = new Map(
    (plan.typeIssues ?? []).map((issue) => [
      issue.sourceType,
      new Set(issue.droppedFields ?? []),
    ]),
  );

  const results: VerifiedItem[] = new Array(operations.length);
  let next = 0;
  let error: string | undefined;
  const worker = async () => {
    while (next < operations.length && !error && !signal?.aborted) {
      const index = next;
      next += 1;
      const operation = operations[index];
      try {
        results[index] = {
          destinationUrl: operation.destinationUrl,
          title: operation.title,
          problems: await verifyItem(operation, {
            plan,
            sourceRoot,
            destinationRoot,
            destinationAuth,
            sourcePrefix,
            droppedByType,
            fetchImpl,
          }),
        };
      } catch (caught) {
        error = caught instanceof Error ? caught.message : String(caught);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const checked = results.filter(Boolean);
  if (signal?.aborted && !error) error = 'The check was stopped.';
  return {
    checked: checked.length,
    passed: checked.filter((item) => item.problems.length === 0).length,
    items: checked.filter((item) => item.problems.length > 0),
    ...(error ? { error } : {}),
  };
}
