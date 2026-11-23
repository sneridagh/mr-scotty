import { useEffect, useRef, useState } from 'react';
import config from '@plone/registry';
import {
  Cell as PlanCell,
  Column as PlanColumn,
  Row as PlanRow,
  Table as PlanTable,
  TableBody as PlanTableBody,
  TableHeader as PlanTableHeader,
} from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Checkbox,
  Container,
  Heading,
  Link,
  ModalSheet,
  ProgressBar,
  Radio,
  RadioGroup,
  Select,
  SelectItem,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  TextField,
} from '@plone/quanta';
import {
  ArrowleftIcon,
  ArrowrightIcon,
  CheckboxIcon,
  CloseIcon,
  FolderIcon,
  InfoIcon,
  LinkIcon,
  SliderIcon,
  WorldIcon,
} from '@plone/icons';
import { Plug } from '@plone/layout/components/Pluggable';
import { requireManager } from '../server/auth.server';
import {
  cancelJob,
  listJobs,
  startJob,
  type JobSnapshot,
} from '../server/jobs.server';
import {
  Form,
  data,
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
  useSubmit,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from 'react-router';

const FORM_ID = 'mr-scotty-transfer';
import {
  assertTypesResolved,
  createTransferPlan,
  readMaxItemsFromEnv,
  TransferError,
  type ConflictPolicy,
  type EndpointAuth,
  type TransferOperation,
  type TransferPlan,
  type TransferReport,
} from '../server/transfer.server';
import BeamIcon from '../components/BeamIcon';
import { describeToken } from '../helpers/token';
import {
  isWithin,
  publicUrl,
  siteLabel,
  sitePath,
  splitPath,
} from '../helpers/paths';

type AuthMode = 'anonymous' | 'session' | 'bearer' | 'basic';
const CONFLICT_POLICIES: ReadonlyArray<{
  value: ConflictPolicy;
  label: string;
  badge: string;
  badgeClassName: string;
  description: string;
}> = [
  {
    value: 'fail',
    label: 'Fail',
    badge: 'safe',
    badgeClassName: 'bg-quanta-mint text-quanta-turtle',
    description:
      'Abort before any write when the path or a UUID collides. The default.',
  },
  {
    value: 'skip',
    label: 'Skip existing content',
    badge: 'safe',
    badgeClassName: 'bg-quanta-mint text-quanta-turtle',
    description:
      'Leave items that are already there untouched and beam only what is missing.',
  },
  {
    value: 'update',
    label: 'Update existing content',
    badge: 'in place',
    badgeClassName: 'bg-quanta-cream text-quanta-bronze',
    description:
      'Write the source fields into the existing item. Its UUID, history and position are kept; the types must match.',
  },
  {
    value: 'rename',
    label: 'Keep both',
    badge: 'new id',
    badgeClassName: 'bg-quanta-arctic text-quanta-royal',
    description:
      'Beam the item next to the existing one under a free id, such as item-1. It gets a new UUID when the original holds it.',
  },
  {
    value: 'replace',
    label: 'Replace existing content',
    badge: 'destructive',
    badgeClassName: 'bg-quanta-ballet text-quanta-candy',
    description:
      'Delete the item at the source-relative path, with everything inside it, then recreate it. Unrelated siblings and parents are preserved. Confirmed before it runs.',
  },
];

function isConflictPolicy(value: unknown): value is ConflictPolicy {
  return CONFLICT_POLICIES.some((policy) => policy.value === value);
}
type SubmittedForm = {
  sourceUrl: string;
  destinationUrl: string;
  conflictPolicy: ConflictPolicy;
  includeChildren: boolean;
  typeMap: TypeMap;
};

/** Source type → destination type, or `null` to skip its items. */
type TypeMap = Record<string, string | null>;

/** The form field that carries the choice for one source type. */
const TYPE_MAP_PREFIX = 'typeMap:';
/** The value that skips a type's items. */
const SKIP_TYPE = '__skip__';

function readTypeMap(formData: FormData): TypeMap {
  const typeMap: TypeMap = {};
  for (const [name, value] of formData.entries()) {
    if (!name.startsWith(TYPE_MAP_PREFIX) || typeof value !== 'string')
      continue;
    const sourceType = name.slice(TYPE_MAP_PREFIX.length);
    if (!sourceType || !value) continue;
    typeMap[sourceType] = value === SKIP_TYPE ? null : value;
  }
  return typeMap;
}

type ActionResult =
  | { ok: true; intent: 'preflight'; plan: TransferPlan; form: SubmittedForm }
  | {
      ok: true;
      intent: 'transfer';
      plan: TransferPlan;
      job: JobSnapshot;
      form: SubmittedForm;
    }
  | { ok: true; intent: 'cancel'; cancelled: boolean }
  | { ok: false; error: { code: string; message: string } };

export async function loader({ request }: LoaderFunctionArgs) {
  await requireManager(request);
  return {
    destinationUrl: config.settings.apiPath,
    maxItems: readMaxItemsFromEnv(),
    jobs: listJobs(),
  };
}

function requiredString(formData: FormData, name: string): string {
  const value = String(formData.get(name) || '').trim();
  if (!value) {
    throw new TransferError('missing_field', `${name} is required.`);
  }
  return value;
}

function endpointAuth(
  formData: FormData,
  prefix: 'source' | 'destination',
  sessionToken?: string,
): EndpointAuth {
  const mode = String(formData.get(`${prefix}AuthMode`) || 'anonymous');

  if (mode === 'session') {
    if (!sessionToken) {
      throw new TransferError(
        'missing_session',
        'The Aurora session does not contain a destination token.',
        401,
      );
    }
    return { type: 'bearer', token: sessionToken };
  }

  if (mode === 'bearer') {
    return {
      type: 'bearer',
      token: requiredString(formData, `${prefix}Token`),
    };
  }

  if (mode === 'basic') {
    return {
      type: 'basic',
      username: requiredString(formData, `${prefix}Username`),
      password: requiredString(formData, `${prefix}Password`),
    };
  }

  return { type: 'anonymous' };
}

function assertSessionDestination(formData: FormData) {
  if (String(formData.get('destinationAuthMode')) !== 'session') return;

  let destination: URL;
  let configured: URL;
  try {
    destination = new URL(requiredString(formData, 'destinationUrl'));
    configured = new URL(config.settings.apiPath);
  } catch {
    throw new TransferError(
      'invalid_destination_url',
      'Destination URL must be a valid URL.',
    );
  }

  const configuredPath = configured.pathname.replace(/\/+$/, '');
  const isConfiguredBackend =
    destination.origin === configured.origin &&
    (destination.pathname === configuredPath ||
      destination.pathname.startsWith(`${configuredPath}/`));

  if (!isConfiguredBackend) {
    throw new TransferError(
      'session_destination_mismatch',
      'Aurora session authentication can only be used with the configured Plone backend. Choose explicit destination credentials for another server.',
    );
  }
}

export async function action({ request }: ActionFunctionArgs) {
  const sessionToken = await requireManager(request);
  const formData = await request.formData();

  if (formData.get('intent') === 'cancel') {
    return data({
      ok: true,
      intent: 'cancel',
      cancelled: cancelJob(String(formData.get('jobId') || '')),
    } satisfies ActionResult);
  }

  try {
    assertSessionDestination(formData);
    const destinationAuth = endpointAuth(formData, 'destination', sessionToken);
    const sourceUrl = requiredString(formData, 'sourceUrl');
    const destinationUrl = requiredString(formData, 'destinationUrl');
    const submittedPolicy = formData.get('conflictPolicy');
    let conflictPolicy: ConflictPolicy = formData.has('overwrite')
      ? 'replace'
      : 'fail';
    if (isConflictPolicy(submittedPolicy)) {
      conflictPolicy = submittedPolicy;
    } else if (submittedPolicy !== null) {
      throw new TransferError(
        'invalid_conflict_policy',
        `Unknown conflict policy: ${String(submittedPolicy)}.`,
      );
    }
    const includeChildren = formData.get('includeChildren') === 'true';
    const typeMap = readTypeMap(formData);
    const input = {
      sourceUrl,
      destinationUrl,
      sourceAuth: endpointAuth(formData, 'source'),
      destinationAuth,
      conflictPolicy,
      includeChildren,
      typeMap,
    };
    const form = {
      sourceUrl,
      destinationUrl,
      conflictPolicy,
      includeChildren,
      typeMap,
    };
    const intent = String(formData.get('intent') || 'preflight');
    const plan = await createTransferPlan(input);

    if (intent === 'transfer') {
      assertTypesResolved(plan);
      // The plan is checked here; the writing runs in the background and
      // streams its progress to the Activity tab.
      const job = startJob(plan, destinationAuth);
      return data({
        ok: true,
        intent,
        plan,
        job,
        form,
      } satisfies ActionResult);
    }

    return data({
      ok: true,
      intent: 'preflight',
      plan,
      form,
    } satisfies ActionResult);
  } catch (error) {
    const transferError =
      error instanceof TransferError
        ? error
        : new TransferError(
            'unexpected_error',
            error instanceof Error ? error.message : 'Transfer failed.',
            500,
          );
    return data(
      {
        ok: false,
        error: { code: transferError.code, message: transferError.message },
      } satisfies ActionResult,
      { status: transferError.status },
    );
  }
}

// The page's icons come from @plone/icons, as in the core control panels; only
// the beam is Mr. Scotty's own mark.
const ICONS = {
  beam: BeamIcon,
  source: WorldIcon,
  destination: FolderIcon,
  options: SliderIcon,
  link: LinkIcon,
  info: InfoIcon,
  warning: InfoIcon,
  arrow: ArrowrightIcon,
  check: CheckboxIcon,
  close: CloseIcon,
} as const;

type IconName = keyof typeof ICONS;

function Icon({ name, className }: { name: IconName; className?: string }) {
  const Component = ICONS[name];
  return <Component aria-hidden className={className} />;
}

function TokenField({
  prefix,
  label,
}: {
  prefix: 'source' | 'destination';
  label: string;
}) {
  const [token, setToken] = useState('');
  const { description, expired } = describeToken(token, prefix);
  return (
    <TextField
      label={`${label} bearer token`}
      name={`${prefix}Token`}
      type="password"
      autoComplete="off"
      isRequired
      value={token}
      onChange={setToken}
      isInvalid={expired}
      errorMessage={expired ? description : undefined}
      description={expired ? undefined : description}
    />
  );
}

function AuthenticationFields({
  prefix,
  defaultMode,
}: {
  prefix: 'source' | 'destination';
  defaultMode: AuthMode;
}) {
  const [mode, setMode] = useState<AuthMode>(defaultMode);
  const label = prefix === 'source' ? 'Source' : 'Destination';

  return (
    <div className="flex flex-col gap-3">
      <Select
        label="Connection"
        name={`${prefix}AuthMode`}
        selectedKey={mode}
        onSelectionChange={(key) => setMode(key as AuthMode)}
        description={
          prefix === 'destination'
            ? 'Your Aurora session is reused only for this site’s configured backend.'
            : 'How Mr. Scotty authenticates when reading from the source server.'
        }
      >
        {prefix === 'destination' ? (
          <SelectItem id="session">This site (Aurora session)</SelectItem>
        ) : null}
        <SelectItem id="anonymous">Anonymous</SelectItem>
        <SelectItem id="bearer">Bearer token</SelectItem>
        <SelectItem id="basic">Username and password</SelectItem>
      </Select>

      {mode === 'bearer' && <TokenField prefix={prefix} label={label} />}
      {mode === 'basic' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label={`${label} username`}
            name={`${prefix}Username`}
            autoComplete="username"
            isRequired
          />
          <TextField
            label={`${label} password`}
            name={`${prefix}Password`}
            type="password"
            autoComplete="current-password"
            isRequired
          />
        </div>
      )}
    </div>
  );
}

function SectionCard({
  icon,
  title,
  description,
  children,
}: {
  icon: IconName;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-quanta-smoke bg-quanta-air p-6">
      <header className="mb-4 flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-quanta-azure/15 text-quanta-sapphire">
          <Icon name={icon} className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-quanta-denim">{title}</h2>
          <p className="mt-0.5 text-sm text-quanta-pigeon">{description}</p>
        </div>
      </header>
      {children}
    </section>
  );
}

function isDependency(
  plan: TransferPlan,
  operation: TransferPlan['operations'][number],
): boolean {
  // Items inside the selected folder have a place in it; referenced images,
  // picked up from the content that uses them, do not.
  return (
    operation.kind === 'content' &&
    operation.sourceUrl !== plan.sourceUrl &&
    operation.position === undefined
  );
}

const STATUS_TAG: Record<TransferOperation['status'], string> = {
  create: 'bg-quanta-mint text-quanta-turtle',
  reuse: 'bg-quanta-snow text-quanta-pigeon',
  skip: 'bg-quanta-snow text-quanta-pigeon',
  update: 'bg-quanta-cream text-quanta-bronze',
  rename: 'bg-quanta-arctic text-quanta-royal',
  replace: 'bg-quanta-ballet text-quanta-candy',
};

const STATUS_ORDER: TransferOperation['status'][] = [
  'create',
  'update',
  'rename',
  'replace',
  'skip',
  'reuse',
];

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** "Created 2 items, updated 1 item and skipped 1 item." */
function reportSummary(report: TransferReport): string {
  const parts = [
    ['created', report.created.length],
    ['updated', report.updated.length],
    ['replaced', report.replaced.length],
    ['skipped', report.skipped.length],
    ['reused', report.reused.length],
  ] as const;
  const done = parts
    .filter(([, count]) => count > 0)
    .map(([verb, count]) => `${verb} ${plural(count, 'item')}`);
  if (done.length === 0) return 'Nothing was written.';
  const sentence =
    done.length === 1
      ? done[0]
      : `${done.slice(0, -1).join(', ')} and ${done.at(-1)}`;
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

function StatusTag({ status }: { status: TransferOperation['status'] }) {
  return (
    <span
      className={`inline-block rounded-md px-2 py-0.5 text-[11px] font-semibold tracking-wide uppercase ${STATUS_TAG[status]}`}
    >
      {status}
    </span>
  );
}

function StatPill({
  count,
  label,
  className,
}: {
  count: number;
  label: string;
  className: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${className}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {count} {label}
    </span>
  );
}

/** A small outlined tag next to a type, such as "structural". */
function RowTag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-quanta-smoke px-1.5 text-[10px] leading-4 text-quanta-pigeon">
      {children}
    </span>
  );
}

/** `/news/launch`, with the last segment stressed. */
function PathText({ path, title }: { path: string; title?: string }) {
  const { parent, leaf } = splitPath(path);
  return (
    <span className="font-mono break-all" title={title}>
      <span className="text-quanta-pigeon">{parent}</span>
      <span className="font-semibold text-quanta-denim">{leaf}</span>
    </span>
  );
}

/** `old.example.org /news/launch`, or `this site /archive/news/launch`. */
function Place({
  url,
  rootUrl,
  thisSiteUrl,
  suffix,
}: {
  url: string;
  rootUrl?: string;
  thisSiteUrl: string;
  suffix?: string;
}) {
  return (
    // Inline, so a long path wraps with the text around it.
    <span>
      <span className="text-quanta-iron">
        {siteLabel(rootUrl ?? url, thisSiteUrl)}
      </span>{' '}
      <PathText
        path={
          suffix
            ? `${sitePath(url, rootUrl).replace(/\/$/, '')}/${suffix}`
            : sitePath(url, rootUrl)
        }
        title={url}
      />
    </span>
  );
}

function Callout({
  tone = 'neutral',
  children,
}: {
  tone?: 'info' | 'warning' | 'neutral';
  children: React.ReactNode;
}) {
  const styles = {
    info: 'bg-quanta-azure/10 text-quanta-denim',
    warning: 'bg-quanta-ballet text-quanta-candy',
    neutral: 'bg-quanta-snow text-quanta-pigeon',
  }[tone];
  return (
    <div
      className={`flex items-start gap-2.5 rounded-lg p-3 text-sm ${styles}`}
    >
      <Icon
        name={tone === 'warning' ? 'warning' : 'info'}
        className="mt-0.5 h-4 w-4 shrink-0"
      />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

type PlanResult = Extract<ActionResult, { plan: TransferPlan }>;

function hasPlan(result: ActionResult | undefined): result is PlanResult {
  return result?.ok === true && 'plan' in result;
}

/** The operation for the item the person picked. */
function selectedOperation(plan: TransferPlan) {
  return plan.operations.find(
    (operation) => operation.sourceUrl === plan.sourceUrl,
  );
}

const PLAN_HEAD = `
  px-3 py-2 text-left text-[11px] font-semibold tracking-wide text-quanta-pigeon uppercase
`;
const PLAN_CELL = `
  px-3 py-2.5 align-middle outline-none
  focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-quanta-sapphire
`;

function PlanTableView({ plan }: { plan: TransferPlan }) {
  return (
    <div
      className={`overflow-auto rounded-lg border border-quanta-smoke ${
        // Long plans scroll inside the table instead of stretching the page.
        plan.operations.length > 12 ? 'max-h-112' : ''
      }`}
    >
      <PlanTable
        aria-label="Transfer plan operations"
        className="w-full border-collapse text-sm"
      >
        <PlanTableHeader className="sticky top-0 z-10 bg-quanta-snow">
          <PlanColumn isRowHeader className={PLAN_HEAD}>
            Destination path
          </PlanColumn>
          <PlanColumn className={PLAN_HEAD}>Type</PlanColumn>
          <PlanColumn className={`${PLAN_HEAD} w-28`}>Action</PlanColumn>
        </PlanTableHeader>
        <PlanTableBody items={plan.operations}>
          {(operation) => {
            const dependency = isDependency(plan, operation);
            const selected = operation.sourceUrl === plan.sourceUrl;
            return (
              <PlanRow
                id={operation.destinationUrl}
                className={`border-t border-quanta-smoke outline-none ${
                  operation.missingType
                    ? 'bg-quanta-cream/60'
                    : operation.status === 'replace'
                      ? 'bg-quanta-ballet/50'
                      : ''
                }`}
              >
                <PlanCell className={PLAN_CELL}>
                  <span className="flex items-center gap-2 text-[13px]">
                    {dependency && (
                      <Icon
                        name="link"
                        className="h-3.5 w-3.5 shrink-0 text-quanta-sapphire"
                      />
                    )}
                    <span className="flex flex-col">
                      <PathText
                        path={sitePath(
                          operation.destinationUrl,
                          plan.destinationRootUrl,
                        )}
                        title={operation.destinationUrl}
                      />
                      {operation.renamedFrom && (
                        <span className="font-sans text-xs text-quanta-iron">
                          {operation.renamedFrom.split('/').at(-1)} is taken
                        </span>
                      )}
                    </span>
                  </span>
                </PlanCell>
                <PlanCell className={PLAN_CELL}>
                  <span className="flex flex-col gap-0.5 text-quanta-iron">
                    <span className="flex flex-wrap items-center gap-1.5">
                      {operation.sourceType && (
                        <>
                          <span className="text-quanta-pigeon line-through">
                            {operation.sourceType}
                          </span>
                          <span aria-hidden>→</span>
                          <span className="sr-only">beamed as</span>
                        </>
                      )}
                      <span
                        className={
                          operation.missingType
                            ? 'font-medium text-quanta-bronze'
                            : undefined
                        }
                      >
                        {operation.kind === 'placeholder'
                          ? 'Document'
                          : operation.type}
                      </span>
                      {operation.missingType && (
                        <RowTag>not on destination</RowTag>
                      )}
                      {operation.sourceType && <RowTag>mapped</RowTag>}
                      {operation.skipReason === 'type' && (
                        <RowTag>type skipped</RowTag>
                      )}
                      {operation.skipReason === 'parent' && (
                        <RowTag>inside a skipped item</RowTag>
                      )}
                      {operation.kind === 'placeholder' && (
                        <RowTag>structural</RowTag>
                      )}
                      {selected && <RowTag>selected</RowTag>}
                      {dependency && <RowTag>dependency</RowTag>}
                    </span>
                    {operation.reviewState && (
                      <span className="text-xs text-quanta-pigeon">
                        {operation.reviewState}
                      </span>
                    )}
                  </span>
                </PlanCell>
                <PlanCell className={PLAN_CELL}>
                  <StatusTag status={operation.status} />
                </PlanCell>
              </PlanRow>
            );
          }}
        </PlanTableBody>
      </PlanTable>
    </div>
  );
}

/**
 * Types the destination lacks, each with a choice: beam its items as one of
 * the destination's types, or skip them. Choosing inspects again.
 */
function TypeIssuesPanel({
  plan,
  disabled,
  onChoose,
}: {
  plan: TransferPlan;
  disabled: boolean;
  onChoose: (sourceType: string, choice: string) => void;
}) {
  const issues = plan.typeIssues ?? [];
  const unresolved = issues.filter((issue) => issue.mappedTo === undefined);
  const insideSkipped = plan.operations.filter(
    (operation) => operation.skipReason === 'parent',
  ).length;
  return (
    <div
      className={`rounded-lg border p-4 ${
        unresolved.length > 0
          ? 'border-quanta-bronze/40 bg-quanta-cream/60'
          : 'border-quanta-smoke bg-quanta-snow'
      }`}
    >
      <p className="flex items-center gap-2 text-sm font-semibold text-quanta-denim">
        <Icon name="warning" className="h-4 w-4 shrink-0 text-quanta-bronze" />
        {unresolved.length > 0
          ? `${plural(unresolved.length, 'content type')} ${
              unresolved.length === 1 ? "doesn't" : "don't"
            } exist on the destination`
          : 'Content types beamed as other types'}
      </p>
      <p className="mt-1 text-xs text-quanta-pigeon">
        Choose a destination type for each, or skip their items. Nothing is
        beamed until every type has a choice.
      </p>
      <ul className="mt-3 flex flex-col gap-3">
        {issues.map((issue) => (
          <li
            key={issue.sourceType}
            className="grid items-start gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,16rem)]"
          >
            <div className="pt-2 text-sm">
              <span className="font-mono font-semibold text-quanta-denim">
                {issue.sourceType}
              </span>{' '}
              <span className="text-quanta-pigeon">
                · {plural(issue.count, 'item')}
              </span>
              {issue.droppedFields && issue.droppedFields.length > 0 && (
                <p className="mt-1 text-xs text-quanta-bronze">
                  {issue.mappedTo} has no field for{' '}
                  {issue.droppedFields.join(', ')}:{' '}
                  {issue.droppedFields.length === 1
                    ? 'it is dropped.'
                    : 'they are dropped.'}
                </p>
              )}
              {issue.mappedTo === null && insideSkipped > 0 && (
                <p className="mt-1 text-xs text-quanta-pigeon">
                  Everything inside skipped items is skipped too.
                </p>
              )}
            </div>
            <Select
              aria-label={`Beam ${issue.sourceType} as`}
              placeholder="Choose a type"
              selectedKey={
                issue.mappedTo === undefined
                  ? null
                  : issue.mappedTo === null
                    ? SKIP_TYPE
                    : issue.mappedTo
              }
              onSelectionChange={(key) =>
                key !== null && onChoose(issue.sourceType, String(key))
              }
              isDisabled={disabled}
            >
              {[
                ...(plan.destinationTypes ?? []).map((type) => (
                  <SelectItem key={type.id} id={type.id}>
                    {`Beam as ${type.title}`}
                  </SelectItem>
                )),
                <SelectItem key={SKIP_TYPE} id={SKIP_TYPE}>
                  Skip these items
                </SelectItem>,
              ]}
            </Select>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PlanReview({
  result,
  beamButton,
  onEdit,
  onChooseType,
  busy,
}: {
  result: PlanResult;
  beamButton: React.ReactNode;
  onEdit: () => void;
  onChooseType: (sourceType: string, choice: string) => void;
  busy: boolean;
}) {
  const { plan } = result;
  const countOf = (status: TransferOperation['status']) =>
    plan.operations.filter((o) => o.status === status).length;
  const replacements = countOf('replace');
  const updates = countOf('update');
  const renames = countOf('rename');
  const dependencies = plan.operations.filter((o) => isDependency(plan, o));
  // Once beaming starts, its progress and report are on the Activity tab.
  const started = result.intent === 'transfer';
  const ref = useRef<HTMLElement>(null);

  // Bring a fresh plan into view: it renders below the whole form.
  useEffect(() => {
    if (!started) {
      ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [result, started]);

  return (
    <section
      ref={ref}
      className="scroll-mt-6 overflow-hidden rounded-xl border border-quanta-smoke bg-quanta-air"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-quanta-smoke px-6 py-4">
        <h2 className="text-base font-semibold text-quanta-denim">
          Transfer plan
        </h2>
        <div className="flex flex-wrap gap-2">
          {STATUS_ORDER.filter((status) => countOf(status) > 0).map(
            (status) => (
              <StatPill
                key={status}
                count={countOf(status)}
                label={status}
                className={STATUS_TAG[status]}
              />
            ),
          )}
          {dependencies.length > 0 && (
            <StatPill
              count={dependencies.length}
              label={dependencies.length === 1 ? 'dependency' : 'dependencies'}
              className="bg-quanta-azure/20 text-quanta-sapphire"
            />
          )}
        </div>
        <span className="ml-auto text-xs text-quanta-pigeon">
          {started
            ? 'Beaming started'
            : 'Checked against the destination · nothing written yet'}
        </span>
      </div>

      <div className="flex flex-col gap-4 px-6 pt-4">
        {plan.typeIssues && plan.typeIssues.length > 0 && !started && (
          <TypeIssuesPanel
            plan={plan}
            disabled={busy}
            onChoose={onChooseType}
          />
        )}
        <PlanTableView plan={plan} />
      </div>

      <div className="flex flex-col gap-3 px-6 py-4">
        {dependencies.length > 0 && (
          <Callout tone="info">
            {dependencies.length} internal image
            {dependencies.length === 1 ? '' : 's'} referenced by the content{' '}
            {dependencies.length === 1 ? 'is' : 'are'} beamed alongside it, and
            the block URLs are rewritten to the destination.
          </Callout>
        )}
        {updates > 0 && !started && (
          <Callout tone="info">
            <b className="font-semibold">Update</b> writes the source fields
            into {plural(updates, 'existing item')}. Their UUIDs and history are
            kept, so earlier versions can be restored.
          </Callout>
        )}
        {renames > 0 && !started && (
          <Callout tone="info">
            {plural(renames, 'item')} {renames === 1 ? 'is' : 'are'} beamed
            under a new id because{' '}
            {renames === 1 ? 'its path is' : 'their paths are'} taken.
          </Callout>
        )}
        {!started &&
          plan.operations.some((operation) => operation.reviewState) && (
            <Callout tone="neutral">
              Written items are moved to their source workflow state, shown
              under their type. Creation and modification dates are set by the
              destination: the REST API does not accept them.
            </Callout>
          )}
        {replacements > 0 && !started && (
          <Callout tone="warning">
            <b className="font-semibold">Replace</b> deletes the existing item
            at its path, with everything inside it, before recreating it. If
            recreating fails, the item is put back with its files, but not what
            was inside it. You confirm this before anything is written.
          </Callout>
        )}
        {started && (
          <Callout tone="info">
            Beaming started. Follow its progress on the Activity tab.
          </Callout>
        )}
      </div>

      {!started && (
        <div className="flex flex-wrap items-center gap-3 border-t border-quanta-smoke px-6 py-4">
          {beamButton}
          <Button type="button" variant="neutral" onPress={onEdit}>
            Edit options
          </Button>
          <span className="text-sm text-quanta-pigeon">
            Runs in the background; follow it under Activity.
          </span>
        </div>
      )}
    </section>
  );
}

function WorkflowWarnings({
  warnings,
}: {
  warnings: TransferReport['warnings'];
}) {
  return (
    <Callout tone="warning">
      <span className="font-semibold">
        {plural(warnings.length, 'item')} kept a different workflow state.
      </span>
      <ul className="mt-1 flex flex-col gap-1 text-xs [overflow-wrap:anywhere]">
        {warnings.map((warning) => (
          <li key={warning.destinationUrl}>
            <span className="font-mono break-all">
              {warning.destinationUrl}
            </span>
            : {warning.message}
          </li>
        ))}
      </ul>
    </Callout>
  );
}

function ActivityEmpty({ hint }: { hint: string }) {
  return (
    <div className="rounded-xl border border-dashed border-quanta-smoke bg-quanta-air p-8 text-center">
      <span className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-quanta-snow text-quanta-pigeon">
        <Icon name="beam" className="h-5 w-5" />
      </span>
      <p className="text-sm font-medium text-quanta-denim">No transfers yet</p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-quanta-pigeon">{hint}</p>
    </div>
  );
}

type JobTone = 'running' | 'done' | 'failed' | 'cancelled';

function JobIcon({ tone }: { tone: JobTone }) {
  const badge = {
    running: 'bg-quanta-arctic text-quanta-royal',
    done: 'bg-quanta-mint text-quanta-turtle',
    failed: 'bg-quanta-ballet text-quanta-candy',
    cancelled: 'bg-quanta-snow text-quanta-pigeon',
  }[tone];
  return (
    <span
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${badge}`}
    >
      <Icon
        name={tone === 'running' ? 'beam' : tone === 'done' ? 'check' : 'close'}
        className="h-4 w-4"
      />
    </span>
  );
}

/**
 * The current time, ticking every 30 seconds. Undefined until the page has
 * hydrated, so the server and the first client render agree.
 */
function useNow(): number | undefined {
  const [now, setNow] = useState<number>();
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function relativeTime(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    dateStyle: 'medium',
  });
}

function When({
  iso,
  prefix,
  now,
}: {
  iso: string;
  prefix?: string;
  now: number | undefined;
}) {
  if (now === undefined) return null;
  return (
    <time
      dateTime={iso}
      title={new Date(iso).toLocaleString()}
      className="text-xs font-normal text-quanta-pigeon"
    >
      · {prefix ? `${prefix} ` : ''}
      {relativeTime(iso, now)}
    </time>
  );
}

/** The newer of two snapshots of one job. */
function newer(left: JobSnapshot, right: JobSnapshot): JobSnapshot {
  if (left.finishedAt && !right.finishedAt) return left;
  if (right.finishedAt && !left.finishedAt) return right;
  return right.progress.done >= left.progress.done ? right : left;
}

/**
 * The jobs from the loader and the last action, kept current by the server's
 * event stream.
 */
function useLiveJobs(seed: JobSnapshot[]): JobSnapshot[] {
  const [streamed, setStreamed] = useState<JobSnapshot[]>([]);

  useEffect(() => {
    const source = new EventSource('/@@controlpanel/mr-scotty/events');
    source.addEventListener('job', (event) => {
      const job = JSON.parse(
        (event as MessageEvent<string>).data,
      ) as JobSnapshot;
      setStreamed((current) => [
        ...current.filter((known) => known.id !== job.id),
        job,
      ]);
    });
    return () => source.close();
  }, []);

  const byId = new Map<string, JobSnapshot>();
  for (const job of [...seed, ...streamed]) {
    const known = byId.get(job.id);
    byId.set(job.id, known ? newer(known, job) : job);
  }
  return [...byId.values()].sort((left, right) =>
    right.startedAt.localeCompare(left.startedAt),
  );
}

function CancelButton({ jobId }: { jobId: string }) {
  const fetcher = useFetcher();
  return (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="cancel" />
      <input type="hidden" name="jobId" value={jobId} />
      <Button
        type="submit"
        variant="neutral"
        size="S"
        isDisabled={fetcher.state !== 'idle'}
      >
        {fetcher.state !== 'idle' ? 'Cancelling…' : 'Cancel'}
      </Button>
    </fetcher.Form>
  );
}

function JobItem({
  job,
  thisSiteUrl,
  now,
}: {
  job: JobSnapshot;
  thisSiteUrl: string;
  now: number | undefined;
}) {
  const { report, progress } = job;
  const sourcePath = sitePath(job.sourceUrl, job.sourceRootUrl);
  const route = (
    <p className="mt-1 text-xs text-quanta-pigeon">
      <Place
        url={job.sourceUrl}
        rootUrl={job.sourceRootUrl}
        thisSiteUrl={thisSiteUrl}
      />{' '}
      <span aria-hidden>→</span>
      <span className="sr-only">beamed to</span>{' '}
      <Place
        url={job.destinationUrl}
        rootUrl={job.destinationRootUrl}
        thisSiteUrl={thisSiteUrl}
      />
    </p>
  );
  const verb =
    job.status === 'running'
      ? 'Beaming'
      : job.status === 'done'
        ? 'Beamed'
        : job.status === 'cancelled'
          ? 'Cancelled'
          : report
            ? 'Partially beamed'
            : 'Could not beam';
  const failed = report?.failed;

  return (
    <li className="flex items-start gap-3 px-5 py-4">
      <JobIcon tone={job.status} />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-1.5 text-sm font-semibold text-quanta-denim">
          <span>
            {verb} <PathText path={sourcePath} title={job.sourceUrl} />
          </span>
          {job.status === 'running' ? (
            <When iso={job.startedAt} prefix="started" now={now} />
          ) : (
            <When iso={job.finishedAt ?? job.startedAt} now={now} />
          )}
        </p>
        {route}
        {job.typeIssues && job.typeIssues.length > 0 && (
          <p className="mt-1 text-xs text-quanta-pigeon">
            {job.typeIssues
              .map((issue) =>
                issue.mappedTo === null
                  ? `${issue.sourceType} skipped`
                  : `${issue.sourceType} beamed as ${issue.mappedTo}`,
              )
              .join(' · ')}
          </p>
        )}

        {job.status === 'running' ? (
          <>
            <div className="mt-3 flex items-end gap-4">
              <ProgressBar
                label={`${progress.done} of ${plural(progress.total, 'item')}`}
                value={progress.done}
                maxValue={Math.max(progress.total, 1)}
                className="max-w-sm flex-1"
              />
              <CancelButton jobId={job.id} />
            </div>
            {progress.current && (
              <p className="mt-2 truncate text-xs text-quanta-pigeon">
                {progress.current.status}{' '}
                <PathText
                  path={sitePath(
                    progress.current.destinationUrl,
                    job.destinationRootUrl,
                  )}
                  title={progress.current.destinationUrl}
                />
              </p>
            )}
          </>
        ) : (
          <>
            {report && (
              <p className="mt-2 text-sm text-quanta-pigeon">
                {job.status === 'cancelled' &&
                  `Stopped after ${progress.done} of ${plural(progress.total, 'item')}. `}
                {reportSummary(report)}{' '}
                <Link
                  className="text-quanta-sapphire underline"
                  href={publicUrl(report.destinationUrl, {
                    thisSiteUrl,
                    siteUrl: job.destinationSite?.siteUrl,
                    frontendUrl: job.destinationSite?.frontendUrl,
                  })}
                >
                  Open destination
                </Link>
              </p>
            )}
            {failed && (
              <p className="mt-2 text-xs [overflow-wrap:anywhere] text-quanta-candy">
                Stopped at{' '}
                <span className="font-mono break-all">
                  {sitePath(failed.destinationUrl, job.destinationRootUrl)}
                </span>
                : {failed.message}
                {failed.restored !== undefined &&
                  (failed.restored
                    ? ' The original content at that path was restored.'
                    : ' The original content at that path could not be restored.')}
              </p>
            )}
            {job.error && (
              <p className="mt-2 text-xs [overflow-wrap:anywhere] text-quanta-candy">
                {job.error.message} (error code: {job.error.code})
              </p>
            )}
            {report && report.warnings.length > 0 && (
              <div className="mt-3">
                <WorkflowWarnings warnings={report.warnings} />
              </div>
            )}
          </>
        )}
      </div>
    </li>
  );
}

function ActivityPanel({
  result,
  jobs,
  thisSiteUrl,
}: {
  result: ActionResult | undefined;
  jobs: JobSnapshot[];
  thisSiteUrl: string;
}) {
  const now = useNow();
  return (
    <div className="flex flex-col gap-4" aria-live="polite">
      {result?.ok === false && (
        <div className="flex items-start gap-3 rounded-xl border border-quanta-smoke bg-quanta-air px-5 py-4">
          <JobIcon tone="failed" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-quanta-denim">
              Transfer failed to start
            </p>
            <p className="mt-1 text-sm [overflow-wrap:anywhere] text-quanta-denim">
              {result.error.message}
            </p>
            <p className="mt-1 text-xs text-quanta-pigeon">
              Error code: {result.error.code}
            </p>
          </div>
        </div>
      )}
      {jobs.length === 0 && result?.ok !== false && (
        <ActivityEmpty
          hint={
            hasPlan(result)
              ? 'Preflight ran, but nothing has been beamed yet. Transfers show up here as they run.'
              : 'Transfers show up here as they run, with their report.'
          }
        />
      )}
      {jobs.length > 0 && (
        <ul
          aria-label="Transfers"
          className="divide-y divide-quanta-smoke overflow-hidden rounded-xl border border-quanta-smoke bg-quanta-air"
        >
          {jobs.map((job) => (
            <JobItem
              key={job.id}
              job={job}
              thisSiteUrl={thisSiteUrl}
              now={now}
            />
          ))}
        </ul>
      )}
      <p className="text-center text-xs text-quanta-pigeon">
        Runs are kept on this server until it restarts.
      </p>
    </div>
  );
}

/** Where the form's content would land, as far as it is known yet. */
function TransferPreview({
  sourceUrl,
  destinationUrl,
  plan,
  thisSiteUrl,
}: {
  sourceUrl: string;
  destinationUrl: string;
  plan?: TransferPlan;
  thisSiteUrl: string;
}) {
  const selected = plan && selectedOperation(plan);
  return (
    <div className="flex items-start gap-2.5 rounded-lg bg-quanta-snow p-3 text-[13px] text-quanta-pigeon">
      <Icon name="arrow" className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-semibold text-quanta-denim">Result:</span>
        {plan && selected ? (
          <>
            <Place
              url={plan.sourceUrl}
              rootUrl={plan.sourceRootUrl}
              thisSiteUrl={thisSiteUrl}
            />
            <span aria-hidden>→</span>
            <span className="sr-only">beamed to</span>
            <Place
              url={selected.destinationUrl}
              rootUrl={plan.destinationRootUrl}
              thisSiteUrl={thisSiteUrl}
            />
          </>
        ) : (
          <>
            {sourceUrl ? (
              <Place url={sourceUrl} thisSiteUrl={thisSiteUrl} />
            ) : (
              <span>the source item</span>
            )}
            <span aria-hidden>→</span>
            <span className="sr-only">beamed to</span>
            {destinationUrl ? (
              <Place
                url={destinationUrl}
                rootUrl={
                  isWithin(destinationUrl, thisSiteUrl)
                    ? thisSiteUrl
                    : undefined
                }
                thisSiteUrl={thisSiteUrl}
                suffix="…"
              />
            ) : (
              <span>the destination container</span>
            )}
            <span className="basis-full text-xs">
              Inspect the transfer to see the exact destination path.
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function BeamButton({
  policy,
  busy,
  label,
  onConfirm,
  blocked = false,
}: {
  policy: ConflictPolicy;
  busy: boolean;
  label: string;
  onConfirm: () => void;
  /** Set while the plan cannot be beamed yet. */
  blocked?: boolean;
}) {
  // Replace is confirmed in a dialog, whose button submits the form.
  return policy === 'replace' ? (
    <Button
      type="button"
      variant="primary"
      accent
      isDisabled={busy || blocked}
      onPress={onConfirm}
    >
      {busy ? 'Working…' : label}
    </Button>
  ) : (
    <Button
      type="submit"
      form={FORM_ID}
      name="intent"
      value="transfer"
      variant="primary"
      accent
      isDisabled={busy || blocked}
    >
      {busy ? 'Working…' : label}
    </Button>
  );
}

export default function MrScotty() {
  const { t } = useTranslation();
  const {
    destinationUrl,
    maxItems,
    jobs: loadedJobs,
  } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>() as ActionResult | undefined;
  const navigation = useNavigation();
  const jobs = useLiveJobs(
    result?.ok === true && result.intent === 'transfer'
      ? [...loadedJobs, result.job]
      : loadedJobs,
  );
  const busy = navigation.state !== 'idle';
  const running = jobs.filter((job) => job.status === 'running').length;

  const [tab, setTab] = useState<'new' | 'activity'>('new');
  const [policy, setPolicy] = useState<ConflictPolicy>('fail');
  const [includeChildren, setIncludeChildren] = useState(false);
  const [typeMap, setTypeMap] = useState<TypeMap>(
    hasPlan(result) ? result.form.typeMap : {},
  );
  const submit = useSubmit();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sourceUrlValue, setSourceUrlValue] = useState(
    hasPlan(result) ? result.form.sourceUrl : '',
  );
  const [destinationUrlValue, setDestinationUrlValue] =
    useState(destinationUrl);
  const formTop = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hasPlan(result)) return;
    setPolicy(result.form.conflictPolicy);
    setIncludeChildren(result.form.includeChildren);
    setTypeMap(result.form.typeMap);
    setSourceUrlValue(result.form.sourceUrl);
    setDestinationUrlValue(result.form.destinationUrl);
    if (result.intent === 'transfer') setTab('activity');
  }, [result]);

  // The inspected plan, while the form still asks for that same transfer.
  const currentPlan =
    hasPlan(result) &&
    result.intent === 'preflight' &&
    result.form.sourceUrl === sourceUrlValue.trim() &&
    result.form.destinationUrl === destinationUrlValue.trim() &&
    result.form.includeChildren === includeChildren
      ? result.plan
      : undefined;
  // Only a plan inspected with Replace knows what Replace deletes.
  // A type the destination lacks with no choice yet blocks beaming.
  const unresolvedTypes = Boolean(
    hasPlan(result) &&
    result.plan.typeIssues?.some((issue) => issue.mappedTo === undefined),
  );

  /** Records a choice for a missing type, and inspects again with it. */
  const chooseType = (sourceType: string, choice: string) => {
    setTypeMap((current) => ({
      ...current,
      [sourceType]: choice === SKIP_TYPE ? null : choice,
    }));
    const form = document.getElementById(FORM_ID);
    if (!(form instanceof HTMLFormElement)) return;
    const formData = new FormData(form);
    formData.set(`${TYPE_MAP_PREFIX}${sourceType}`, choice);
    formData.set('intent', 'preflight');
    void submit(formData, { method: 'post' });
  };

  const toReplace =
    currentPlan?.conflictPolicy === 'replace'
      ? currentPlan.operations.filter(
          (operation) => operation.status === 'replace',
        )
      : undefined;

  return (
    <main className="route-mr-scotty">
      <Plug pluggable="toolbar-top" id="button-back">
        <Link aria-label="back" href="/@@controlpanel">
          <ArrowleftIcon />
        </Link>
      </Plug>
      <Container
        width="default"
        className={`
          route-controlpanel px-4 pt-6 pb-16
          md:px-12 md:pt-12
        `}
      >
        {/* The same header as the core control panels. */}
        <header className="mb-8 flex flex-col gap-1">
          <Link
            href="/@@controlpanel"
            className={`
            self-start text-[13px] font-medium text-quanta-sapphire no-underline
            hover:text-quanta-royal
          `}
          >
            {t('cmsui.siteSetup')}
          </Link>
          <h1
            className={`documentFirstHeading text-[28px] leading-[34px] font-bold text-quanta-denim`}
          >
            Mr. Scotty
          </h1>
          <p className="max-w-prose text-sm text-quanta-iron">
            {t('mrScotty.description')}
          </p>
        </header>

        <Tabs
          selectedKey={tab}
          onSelectionChange={(key) => setTab(key as 'new' | 'activity')}
        >
          <TabList aria-label="Mr. Scotty" className="mb-6">
            <Tab id="new">New transfer</Tab>
            <Tab id="activity">
              <span className="flex items-center gap-2">
                Activity
                {running > 0 ? (
                  <span className="rounded-full bg-quanta-arctic px-2 text-[11px] font-semibold text-quanta-royal">
                    {running} running
                  </span>
                ) : jobs.length > 0 ? (
                  <span className="rounded-full border border-quanta-smoke bg-quanta-snow px-1.5 text-[11px] text-quanta-pigeon">
                    {jobs.length}
                  </span>
                ) : null}
              </span>
            </Tab>
          </TabList>

          {/* Both panels stay mounted so the form keeps its state. React Aria
              marks the hidden one inert, and only that panel itself is hidden:
              Tailwind's `inert:` would also match a panel inside an inert
              page, which is what an open dropdown or dialog makes it. */}
          <TabPanel
            id="new"
            shouldForceMount
            className="flex flex-col gap-6 p-0 [&[inert]]:hidden"
          >
            <Form id={FORM_ID} method="post" noValidate>
              <input type="hidden" name="conflictPolicy" value={policy} />
              {includeChildren && (
                <input type="hidden" name="includeChildren" value="true" />
              )}
              {Object.entries(typeMap).map(([sourceType, target]) => (
                <input
                  key={sourceType}
                  type="hidden"
                  name={`${TYPE_MAP_PREFIX}${sourceType}`}
                  value={target ?? SKIP_TYPE}
                />
              ))}
              <div ref={formTop} className="flex scroll-mt-6 flex-col gap-6">
                <SectionCard
                  icon="source"
                  title="Source"
                  description="Where content is read from."
                >
                  <div className="flex flex-col gap-4">
                    <div className="grid gap-4 md:grid-cols-2 md:items-start">
                      <AuthenticationFields
                        prefix="source"
                        defaultMode="anonymous"
                      />
                      <TextField
                        label="Source content URL"
                        description="A complete plone.restapi content URL. Mr. Scotty adds ++api++ automatically."
                        name="sourceUrl"
                        type="url"
                        placeholder="https://old.example/Plone/news/item"
                        value={sourceUrlValue}
                        onChange={setSourceUrlValue}
                        isRequired
                      />
                    </div>
                    <Checkbox
                      isSelected={includeChildren}
                      onChange={setIncludeChildren}
                      isDisabled={busy}
                      description={`Beam the whole folder, keeping its order. A transfer includes at most ${maxItems} items.`}
                    >
                      Include everything inside
                    </Checkbox>
                  </div>
                </SectionCard>

                <SectionCard
                  icon="destination"
                  title="Destination"
                  description="The container content is beamed into."
                >
                  <div className="flex flex-col gap-4">
                    <div className="grid gap-4 md:grid-cols-2 md:items-start">
                      <AuthenticationFields
                        prefix="destination"
                        defaultMode="session"
                      />
                      <TextField
                        label="Destination container URL"
                        description="The source-relative path is appended below this container. Mr. Scotty adds ++api++ automatically."
                        name="destinationUrl"
                        type="url"
                        value={destinationUrlValue}
                        onChange={setDestinationUrlValue}
                        isRequired
                      />
                    </div>
                    <TransferPreview
                      sourceUrl={sourceUrlValue.trim()}
                      destinationUrl={destinationUrlValue.trim()}
                      plan={currentPlan}
                      thisSiteUrl={destinationUrl}
                    />
                  </div>
                </SectionCard>

                <SectionCard
                  icon="options"
                  title="Options"
                  description="How Mr. Scotty resolves a path that already exists."
                >
                  <RadioGroup
                    aria-label="Conflict policy"
                    orientation="vertical"
                    value={policy}
                    onChange={(value) => setPolicy(value as ConflictPolicy)}
                    isDisabled={busy}
                    className="w-full"
                  >
                    {CONFLICT_POLICIES.map((option) => (
                      <Radio
                        key={option.value}
                        value={option.value}
                        className={({ isSelected }: { isSelected: boolean }) =>
                          `w-full items-start rounded-lg border p-3 ${
                            isSelected
                              ? 'border-quanta-sapphire bg-quanta-azure/10'
                              : 'border-quanta-smoke'
                          }`
                        }
                      >
                        <span className="flex flex-col">
                          <span className="flex items-center gap-2 font-medium text-quanta-denim">
                            {option.label}
                            <span
                              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${option.badgeClassName}`}
                            >
                              {option.badge}
                            </span>
                          </span>
                          <span className="mt-0.5 text-xs text-quanta-pigeon">
                            {option.description}
                          </span>
                        </span>
                      </Radio>
                    ))}
                  </RadioGroup>
                </SectionCard>

                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="submit"
                    name="intent"
                    value="preflight"
                    variant="neutral"
                    isDisabled={busy}
                  >
                    {busy ? 'Inspecting…' : 'Inspect transfer'}
                  </Button>
                  <BeamButton
                    policy={policy}
                    busy={busy}
                    blocked={unresolvedTypes}
                    label="Beam content"
                    onConfirm={() => setConfirmOpen(true)}
                  />
                  <span className="text-sm text-quanta-pigeon">
                    Inspect is a dry run — nothing is written.
                  </span>
                </div>
              </div>
            </Form>

            {result?.ok === false && (
              <section
                className="rounded-xl border border-quanta-candy bg-quanta-ballet p-5 text-sm text-quanta-denim"
                role="alert"
              >
                <p className="font-semibold">Transfer could not start</p>
                <p className="mt-1 [overflow-wrap:anywhere]">
                  {result.error.message}
                </p>
                <p className="mt-2 text-xs text-quanta-pigeon">
                  Error code: {result.error.code}
                </p>
              </section>
            )}
            {hasPlan(result) && (
              <PlanReview
                result={result}
                beamButton={
                  <BeamButton
                    policy={policy}
                    busy={busy}
                    blocked={unresolvedTypes}
                    label={`Beam ${plural(
                      result.plan.operations.filter(
                        (operation) =>
                          operation.status !== 'reuse' &&
                          operation.status !== 'skip',
                      ).length,
                      'item',
                    )}`}
                    onConfirm={() => setConfirmOpen(true)}
                  />
                }
                busy={busy}
                onChooseType={chooseType}
                onEdit={() =>
                  formTop.current?.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start',
                  })
                }
              />
            )}
          </TabPanel>

          <TabPanel
            id="activity"
            shouldForceMount
            className="p-0 [&[inert]]:hidden"
          >
            <ActivityPanel
              result={result}
              jobs={jobs}
              thisSiteUrl={destinationUrl}
            />
          </TabPanel>
        </Tabs>

        <ModalSheet
          isOpen={confirmOpen}
          onOpenChange={setConfirmOpen}
          className="[--modal-max-width:440px]"
        >
          <Heading
            slot="title"
            className="mb-2 flex items-center gap-2.5 text-xl font-bold"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-quanta-ballet text-quanta-candy">
              <Icon name="warning" className="h-4 w-4" />
            </span>
            Confirm replace
          </Heading>
          <p className="text-sm text-quanta-iron">
            This transfer deletes the existing content at the source-relative
            path, with everything inside it, and recreates it. Structural
            parents and unrelated siblings are left untouched.
          </p>
          {currentPlan && toReplace ? (
            toReplace.length > 0 ? (
              <div className="mt-3 rounded-lg bg-quanta-ballet p-3 text-[13px] text-quanta-candy">
                <p className="font-semibold">
                  {plural(toReplace.length, 'item')}{' '}
                  {toReplace.length === 1 ? 'is' : 'are'} deleted first:
                </p>
                <ul className="mt-1 flex max-h-40 flex-col gap-0.5 overflow-auto">
                  {toReplace.map((operation) => (
                    <li key={operation.destinationUrl}>
                      <PathText
                        path={sitePath(
                          operation.destinationUrl,
                          currentPlan.destinationRootUrl,
                        )}
                        title={operation.destinationUrl}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="mt-3 rounded-lg bg-quanta-snow p-3 text-[13px] text-quanta-pigeon">
                The inspection found nothing at these paths, so nothing is
                deleted.
              </p>
            )
          ) : (
            <p className="mt-3 rounded-lg bg-quanta-snow p-3 text-[13px] text-quanta-pigeon">
              Inspect the transfer with Replace first to see exactly which items
              are deleted.
            </p>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <Button
              type="button"
              variant="neutral"
              onPress={() => setConfirmOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form={FORM_ID}
              name="intent"
              value="transfer"
              variant="destructive"
              accent
              onPress={() => setConfirmOpen(false)}
            >
              Delete &amp; beam
            </Button>
          </div>
        </ModalSheet>
      </Container>
    </main>
  );
}
