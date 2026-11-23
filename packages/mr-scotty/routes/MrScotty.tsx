import { useEffect, useState } from 'react';
import config from '@plone/registry';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Cell,
  Checkbox,
  Column,
  Container,
  Heading,
  Link,
  ModalSheet,
  ProgressBar,
  Radio,
  RadioGroup,
  Row,
  Select,
  SelectItem,
  Tab,
  Table,
  TableBody,
  TableHeader,
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
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from 'react-router';

const FORM_ID = 'mr-scotty-transfer';
import {
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
};

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
    const input = {
      sourceUrl,
      destinationUrl,
      sourceAuth: endpointAuth(formData, 'source'),
      destinationAuth,
      conflictPolicy,
      includeChildren,
    };
    const form = { sourceUrl, destinationUrl, conflictPolicy, includeChildren };
    const intent = String(formData.get('intent') || 'preflight');
    const plan = await createTransferPlan(input);

    if (intent === 'transfer') {
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

      {mode === 'bearer' && (
        <TextField
          label={`${label} bearer token`}
          name={`${prefix}Token`}
          type="password"
          autoComplete="off"
          isRequired
        />
      )}
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
  return operation.kind === 'content' && operation.sourceUrl !== plan.sourceUrl;
}

function operationType(
  plan: TransferPlan,
  operation: TransferPlan['operations'][number],
): string {
  if (operation.kind === 'placeholder') return 'Document (structural)';
  if (isDependency(plan, operation)) return `${operation.type} (dependency)`;
  return operation.type;
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

function PlanReview({ result }: { result: PlanResult }) {
  const { plan } = result;
  const countOf = (status: TransferOperation['status']) =>
    plan.operations.filter((o) => o.status === status).length;
  const replacements = countOf('replace');
  const updates = countOf('update');
  const renames = countOf('rename');
  const dependencies = plan.operations.filter((o) => isDependency(plan, o));
  // Once beaming starts, its progress and report are on the Activity tab.
  const started = result.intent === 'transfer';

  return (
    <section
      className="overflow-hidden rounded-xl border border-quanta-smoke bg-quanta-air"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-quanta-smoke px-6 py-4">
        <h2 className="text-base font-semibold text-quanta-denim">
          Transfer plan
        </h2>
        <div className="flex flex-wrap gap-2">
          {STATUS_ORDER.filter(
            (status) => status === 'create' || countOf(status) > 0,
          ).map((status) => (
            <StatPill
              key={status}
              count={countOf(status)}
              label={status}
              className={STATUS_TAG[status]}
            />
          ))}
          {dependencies.length > 0 && (
            <StatPill
              count={dependencies.length}
              label="dependency"
              className="bg-quanta-azure/20 text-quanta-sapphire"
            />
          )}
        </div>
        <span className="ml-auto font-mono text-xs break-all text-quanta-pigeon">
          {plan.destinationPath}
        </span>
      </div>

      <div className="px-6 pt-4">
        <Table
          aria-label="Transfer plan operations"
          // Long plans scroll inside the table instead of stretching the page.
          className={plan.operations.length > 12 ? 'max-h-112' : 'max-h-none'}
        >
          <TableHeader>
            <Column isRowHeader defaultWidth="3fr" minWidth={240}>
              Destination path
            </Column>
            <Column defaultWidth="1fr" minWidth={140}>
              Type
            </Column>
            <Column defaultWidth={110} minWidth={110}>
              Action
            </Column>
          </TableHeader>
          <TableBody items={plan.operations}>
            {(operation) => (
              <Row id={operation.destinationUrl}>
                <Cell>
                  <span className="flex items-center gap-2 font-mono text-[13px] break-all text-quanta-denim">
                    {isDependency(plan, operation) && (
                      <Icon
                        name="link"
                        className="h-3.5 w-3.5 shrink-0 text-quanta-sapphire"
                      />
                    )}
                    <span className="flex flex-col">
                      {operation.destinationUrl}
                      {operation.renamedFrom && (
                        <span className="font-sans text-xs text-quanta-iron">
                          {operation.renamedFrom.split('/').at(-1)} is taken
                        </span>
                      )}
                    </span>
                  </span>
                </Cell>
                <Cell>
                  <span className="flex flex-col text-quanta-iron">
                    {operationType(plan, operation)}
                    {operation.reviewState && (
                      <span className="text-xs">{operation.reviewState}</span>
                    )}
                  </span>
                </Cell>
                <Cell>
                  <StatusTag status={operation.status} />
                </Cell>
              </Row>
            )}
          </TableBody>
        </Table>
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
      <ul className="mt-1 flex flex-col gap-1 text-xs">
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

function JobCard({
  tone,
  title,
  children,
}: {
  tone: 'running' | 'done' | 'failed' | 'cancelled';
  title: React.ReactNode;
  children: React.ReactNode;
}) {
  const badge = {
    running: 'bg-quanta-arctic text-quanta-royal',
    done: 'bg-quanta-mint text-quanta-turtle',
    failed: 'bg-quanta-ballet text-quanta-candy',
    cancelled: 'bg-quanta-snow text-quanta-pigeon',
  }[tone];
  return (
    <div className="rounded-xl border border-quanta-smoke bg-quanta-air p-5">
      <div className="flex items-start gap-3">
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${badge}`}
        >
          <Icon
            name={
              tone === 'running' ? 'beam' : tone === 'done' ? 'check' : 'close'
            }
            className="h-4 w-4"
          />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold break-words text-quanta-denim">
            {title}
          </p>
          {children}
        </div>
      </div>
    </div>
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

function JobItem({ job }: { job: JobSnapshot }) {
  const { report, progress } = job;
  const destinationLink = report && (
    <Link
      className="text-quanta-sapphire underline"
      href={report.destinationUrl}
    >
      Open destination
    </Link>
  );

  if (job.status === 'running') {
    return (
      <JobCard tone="running" title={`Beaming ${job.sourceUrl}`}>
        <div className="mt-3 flex items-end gap-4">
          <ProgressBar
            label={`${progress.done} of ${plural(progress.total, 'item')}`}
            value={progress.done}
            maxValue={Math.max(progress.total, 1)}
            className="flex-1"
          />
          <CancelButton jobId={job.id} />
        </div>
        {progress.current && (
          <p className="mt-2 truncate font-mono text-xs text-quanta-pigeon">
            {progress.current.status} {progress.current.destinationUrl}
          </p>
        )}
      </JobCard>
    );
  }

  const failed = report?.failed;
  const title =
    job.status === 'done'
      ? `Beamed ${job.sourceUrl}`
      : job.status === 'cancelled'
        ? `Cancelled ${job.sourceUrl}`
        : report
          ? `Partially beamed ${job.sourceUrl}`
          : `Could not beam ${job.sourceUrl}`;
  return (
    <JobCard tone={job.status} title={title}>
      <p className="mt-1 font-mono text-xs break-all text-quanta-pigeon">
        {job.sourceUrl} → {job.destinationUrl}
      </p>
      {report && (
        <p className="mt-2 text-sm text-quanta-pigeon">
          {job.status === 'cancelled' &&
            `Stopped after ${progress.done} of ${plural(progress.total, 'item')}. `}
          {reportSummary(report)} {destinationLink}
        </p>
      )}
      {failed && (
        <p className="mt-2 text-xs text-quanta-candy">
          Stopped at {failed.destinationUrl}: {failed.message}
          {failed.restored !== undefined &&
            (failed.restored
              ? ' The original content at that path was restored.'
              : ' The original content at that path could not be restored.')}
        </p>
      )}
      {job.error && (
        <p className="mt-2 text-xs text-quanta-candy">
          {job.error.message} (error code: {job.error.code})
        </p>
      )}
      {report && report.warnings.length > 0 && (
        <div className="mt-3">
          <WorkflowWarnings warnings={report.warnings} />
        </div>
      )}
    </JobCard>
  );
}

function ActivityPanel({
  result,
  jobs,
}: {
  result: ActionResult | undefined;
  jobs: JobSnapshot[];
}) {
  return (
    <div className="flex flex-col gap-4" aria-live="polite">
      {result?.ok === false && (
        <JobCard tone="failed" title="Transfer failed to start">
          <p className="mt-1 text-sm text-quanta-denim">
            {result.error.message}
          </p>
          <p className="mt-1 text-xs text-quanta-pigeon">
            Error code: {result.error.code}
          </p>
        </JobCard>
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
      {jobs.map((job) => (
        <JobItem key={job.id} job={job} />
      ))}
      <p className="text-center text-xs text-quanta-pigeon">
        Runs are kept on this server until it restarts.
      </p>
    </div>
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

  const [tab, setTab] = useState<'new' | 'activity'>('new');
  const [policy, setPolicy] = useState<ConflictPolicy>('fail');
  const [includeChildren, setIncludeChildren] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sourceUrlValue, setSourceUrlValue] = useState(
    hasPlan(result) ? result.form.sourceUrl : '',
  );
  const [destinationUrlValue, setDestinationUrlValue] =
    useState(destinationUrl);

  useEffect(() => {
    if (!hasPlan(result)) return;
    setPolicy(result.form.conflictPolicy);
    setIncludeChildren(result.form.includeChildren);
    setSourceUrlValue(result.form.sourceUrl);
    setDestinationUrlValue(result.form.destinationUrl);
    if (result.intent === 'transfer') setTab('activity');
  }, [result]);

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
          <p className="text-sm text-quanta-iron">
            {t('cmsui.controlpanelDescriptions.mr-scotty')}
          </p>
        </header>

        <Tabs
          selectedKey={tab}
          onSelectionChange={(key) => setTab(key as 'new' | 'activity')}
        >
          <TabList aria-label="Mr. Scotty" className="mb-6">
            <Tab id="new">New transfer</Tab>
            <Tab id="activity">Activity</Tab>
          </TabList>

          {/* Both panels stay mounted so the form keeps its state; React Aria
              marks the hidden one inert and leaves hiding it to the styles. */}
          <TabPanel
            id="new"
            shouldForceMount
            className="flex flex-col gap-6 p-0 inert:hidden"
          >
            <Form id={FORM_ID} method="post" noValidate>
              <input type="hidden" name="conflictPolicy" value={policy} />
              {includeChildren && (
                <input type="hidden" name="includeChildren" value="true" />
              )}
              <div className="flex flex-col gap-6">
                <SectionCard
                  icon="source"
                  title="Source"
                  description="The content object to read from."
                >
                  <div className="flex flex-col gap-4">
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
                    <Checkbox
                      isSelected={includeChildren}
                      onChange={setIncludeChildren}
                      isDisabled={busy}
                      description={`Beam the whole folder, keeping its order. A transfer includes at most ${maxItems} items.`}
                    >
                      Include everything inside
                    </Checkbox>
                    <AuthenticationFields
                      prefix="source"
                      defaultMode="anonymous"
                    />
                  </div>
                </SectionCard>

                <SectionCard
                  icon="destination"
                  title="Destination"
                  description="The container content is beamed into."
                >
                  <div className="flex flex-col gap-4">
                    <TextField
                      label="Destination container URL"
                      description="The source-relative path is appended below this container. Mr. Scotty adds ++api++ automatically."
                      name="destinationUrl"
                      type="url"
                      value={destinationUrlValue}
                      onChange={setDestinationUrlValue}
                      isRequired
                    />
                    <AuthenticationFields
                      prefix="destination"
                      defaultMode="session"
                    />
                    <div className="flex items-center gap-2 rounded-lg bg-quanta-snow px-3 py-2.5 text-xs text-quanta-pigeon">
                      <span className="truncate font-mono text-quanta-denim">
                        {sourceUrlValue || 'source URL'}
                      </span>
                      <Icon name="arrow" className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate font-mono text-quanta-denim">
                        {(destinationUrlValue || 'destination').replace(
                          /\/+$/,
                          '',
                        )}
                        /…
                      </span>
                    </div>
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
                  {policy === 'replace' ? (
                    <Button
                      type="button"
                      variant="primary"
                      accent
                      isDisabled={busy}
                      onPress={() => setConfirmOpen(true)}
                    >
                      {busy ? 'Working…' : 'Beam content'}
                    </Button>
                  ) : (
                    <Button
                      type="submit"
                      name="intent"
                      value="transfer"
                      variant="primary"
                      accent
                      isDisabled={busy}
                    >
                      {busy ? 'Working…' : 'Beam content'}
                    </Button>
                  )}
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
                <p className="mt-1">{result.error.message}</p>
                <p className="mt-2 text-xs text-quanta-pigeon">
                  Error code: {result.error.code}
                </p>
              </section>
            )}
            {hasPlan(result) && <PlanReview result={result} />}
          </TabPanel>

          <TabPanel id="activity" shouldForceMount className="p-0 inert:hidden">
            <ActivityPanel result={result} jobs={jobs} />
          </TabPanel>
        </Tabs>

        <ModalSheet
          isOpen={confirmOpen}
          onOpenChange={setConfirmOpen}
          className="[--modal-max-width:400px]"
        >
          <Heading slot="title" className="mb-2 text-xl font-bold">
            Confirm replace
          </Heading>
          <p className="text-sm text-quanta-iron">
            This transfer deletes the existing content at the source-relative
            path, with everything inside it, and recreates it. Structural
            parents and unrelated siblings are left untouched.
          </p>
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
