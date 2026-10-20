import { useEffect, useState } from 'react';
import config from '@plone/registry';
import {
  Button,
  Container,
  Dialog,
  Modal,
  Radio,
  RadioGroup,
  Select,
  SelectItem,
  Tab,
  TabList,
  TabPanel,
  TextField,
} from '@plone/quanta';
import { Tabs as RACTabs } from 'react-aria-components';
import { requireAuthCookie } from '@plone/react-router';
import {
  Form,
  data,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from 'react-router';

const FORM_ID = 'mr-scotty-transfer';
import {
  createTransferPlan,
  executeTransferPlan,
  TransferError,
  type EndpointAuth,
  type TransferPlan,
  type TransferReport,
} from '../server/transfer.server';

type AuthMode = 'anonymous' | 'session' | 'bearer' | 'basic';
type ConflictPolicy = 'fail' | 'replace';
type SubmittedForm = {
  sourceUrl: string;
  destinationUrl: string;
  overwrite: boolean;
};

type ActionResult =
  | { ok: true; intent: 'preflight'; plan: TransferPlan; form: SubmittedForm }
  | {
      ok: true;
      intent: 'transfer';
      plan: TransferPlan;
      report: TransferReport;
      form: SubmittedForm;
    }
  | { ok: false; error: { code: string; message: string } };

/**
 * Mr. Scotty can read from and write to arbitrary servers, so it is gated on
 * the Manager role rather than mere authentication. The Manager-only
 * `@controlpanels` endpoint is used as the role probe against this site's
 * configured backend.
 */
async function requireManager(request: Request): Promise<string> {
  const token = await requireAuthCookie(request);
  const apiPath = String(config.settings.apiPath).replace(/\/+$/, '');
  const response = await fetch(`${apiPath}/@controlpanels`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
    redirect: 'manual',
  });
  if (!response.ok) {
    throw new Response('Mr. Scotty requires the Manager role.', {
      status: 403,
      statusText: 'Forbidden',
    });
  }
  return token;
}

export async function loader({ request }: LoaderFunctionArgs) {
  await requireManager(request);
  return { destinationUrl: config.settings.apiPath };
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

  try {
    assertSessionDestination(formData);
    const destinationAuth = endpointAuth(formData, 'destination', sessionToken);
    const sourceUrl = requiredString(formData, 'sourceUrl');
    const destinationUrl = requiredString(formData, 'destinationUrl');
    const overwrite = formData.has('overwrite');
    const input = {
      sourceUrl,
      destinationUrl,
      sourceAuth: endpointAuth(formData, 'source'),
      destinationAuth,
      overwrite,
    };
    const form = { sourceUrl, destinationUrl, overwrite };
    const intent = String(formData.get('intent') || 'preflight');
    const plan = await createTransferPlan(input);

    if (intent === 'transfer') {
      const report = await executeTransferPlan(plan, destinationAuth);
      return data({
        ok: true,
        intent,
        plan,
        report,
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

type IconName =
  | 'beam'
  | 'source'
  | 'destination'
  | 'options'
  | 'link'
  | 'info'
  | 'warning'
  | 'arrow'
  | 'check'
  | 'close';

function Icon({ name, className }: { name: IconName; className?: string }) {
  const paths: Record<IconName, React.ReactNode> = {
    beam: (
      <>
        <path d="M12 2v6" />
        <path d="M5.5 10.5 12 8l6.5 2.5" />
        <path d="M4 13.5c0 4.5 3.6 8 8 8s8-3.5 8-8l-8-3-8 3Z" />
        <path d="M12 10.5v11" />
      </>
    ),
    source: (
      <>
        <rect x="3" y="7" width="18" height="12" rx="2" />
        <path d="M4 7V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2" />
        <path d="M7 12h10" />
      </>
    ),
    destination: (
      <>
        <path d="M12 3v12" />
        <path d="m7 10 5 5 5-5" />
        <path d="M5 21h14" />
      </>
    ),
    options: (
      <>
        <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
        <path d="M1 14h6M9 8h6M17 16h6" />
      </>
    ),
    link: (
      <>
        <path d="M9 17H7A5 5 0 0 1 7 7h2" />
        <path d="M15 7h2a5 5 0 0 1 0 10h-2" />
        <path d="M8 12h8" />
      </>
    ),
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 8h.01M11 12h1v4h1" />
      </>
    ),
    warning: (
      <>
        <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
        <path d="M12 9v4M12 17h.01" />
      </>
    ),
    arrow: (
      <>
        <path d="M5 12h14" />
        <path d="m13 6 6 6-6 6" />
      </>
    ),
    check: <path d="M20 6 9 17l-5-5" />,
    close: (
      <>
        <path d="M18 6 6 18" />
        <path d="m6 6 12 12" />
      </>
    ),
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {paths[name]}
    </svg>
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
          <h2 className="text-base font-semibold text-quanta-space">{title}</h2>
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

const STATUS_TAG: Record<string, string> = {
  create: 'bg-green-100 text-green-700',
  reuse: 'bg-quanta-snow text-quanta-pigeon',
  replace: 'bg-quanta-ballet text-quanta-candy',
};

function StatusTag({ status }: { status: string }) {
  return (
    <span
      className={`inline-block rounded-md px-2 py-0.5 text-[11px] font-semibold tracking-wide uppercase ${
        STATUS_TAG[status] ?? 'bg-quanta-snow text-quanta-pigeon'
      }`}
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
    info: 'bg-quanta-azure/10 text-quanta-space',
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

function PlanReview({
  result,
}: {
  result: Extract<ActionResult, { ok: true }>;
}) {
  const { plan } = result;
  const creates = plan.operations.filter((o) => o.status === 'create');
  const reuses = plan.operations.filter((o) => o.status === 'reuse');
  const replacements = plan.operations.filter((o) => o.status === 'replace');
  const dependencies = plan.operations.filter((o) => isDependency(plan, o));
  const transferReport =
    result.intent === 'transfer' ? result.report : undefined;
  const failed = transferReport?.failed;

  return (
    <section
      className="overflow-hidden rounded-xl border border-quanta-smoke bg-quanta-air"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-quanta-smoke px-6 py-4">
        <h2 className="text-base font-semibold text-quanta-space">
          {transferReport
            ? failed
              ? 'Transfer incomplete'
              : 'Transfer complete'
            : 'Transfer plan'}
        </h2>
        <div className="flex flex-wrap gap-2">
          <StatPill
            count={creates.length}
            label="create"
            className="bg-green-100 text-green-700"
          />
          <StatPill
            count={replacements.length}
            label="replace"
            className="bg-quanta-ballet text-quanta-candy"
          />
          <StatPill
            count={reuses.length}
            label="reuse"
            className="bg-quanta-snow text-quanta-pigeon"
          />
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

      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] border-collapse text-sm">
          <thead>
            <tr className="text-left text-[11px] tracking-wide text-quanta-pigeon uppercase">
              <th className="px-6 py-2 font-semibold">Destination path</th>
              <th className="px-3 py-2 font-semibold">Type</th>
              <th className="px-6 py-2 font-semibold">Action</th>
            </tr>
          </thead>
          <tbody>
            {plan.operations.map((operation) => {
              const dependency = isDependency(plan, operation);
              return (
                <tr
                  key={operation.destinationUrl}
                  className={`border-t border-quanta-smoke ${
                    operation.status === 'replace' ? 'bg-quanta-ballet/60' : ''
                  }`}
                >
                  <td className="px-6 py-2.5">
                    <span className="flex items-center gap-2 font-mono text-[13px] break-all text-quanta-space">
                      {dependency && (
                        <Icon
                          name="link"
                          className="h-3.5 w-3.5 shrink-0 text-quanta-sapphire"
                        />
                      )}
                      {operation.destinationUrl}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-quanta-pigeon">
                    {operationType(plan, operation)}
                  </td>
                  <td className="px-6 py-2.5">
                    <StatusTag status={operation.status} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
        {replacements.length > 0 && !transferReport && (
          <Callout tone="warning">
            <b className="font-semibold">Replace</b> deletes the existing item
            at its path before recreating it. You confirm this before anything
            is written.
          </Callout>
        )}
        {transferReport && !failed && (
          <p className="text-sm font-medium text-quanta-space">
            Created {transferReport.created.length} item
            {transferReport.created.length === 1 ? '' : 's'} and replaced{' '}
            {transferReport.replaced.length} item
            {transferReport.replaced.length === 1 ? '' : 's'}. Final
            destination:{' '}
            <a
              className="text-quanta-sapphire underline"
              href={transferReport.destinationUrl}
            >
              {transferReport.destinationUrl}
            </a>
          </p>
        )}
        {failed && transferReport && (
          <Callout tone="warning">
            <span className="font-semibold">Stopped before finishing.</span>{' '}
            Created {transferReport.created.length}, replaced{' '}
            {transferReport.replaced.length} before{' '}
            <span className="font-mono break-all">{failed.destinationUrl}</span>{' '}
            failed: {failed.message}
            {failed.restored !== undefined && (
              <span className="mt-1 block text-xs">
                {failed.restored
                  ? 'The original content at that path was restored.'
                  : 'The original content at that path could not be restored.'}
              </span>
            )}
            <span className="mt-1 block text-xs">
              Error code: {failed.code}
            </span>
          </Callout>
        )}
      </div>
    </section>
  );
}

function ActivityEmpty({ hint }: { hint: string }) {
  return (
    <div className="rounded-xl border border-dashed border-quanta-smoke bg-quanta-air p-8 text-center">
      <span className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-quanta-snow text-quanta-pigeon">
        <Icon name="beam" className="h-5 w-5" />
      </span>
      <p className="text-sm font-medium text-quanta-space">No transfers yet</p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-quanta-pigeon">{hint}</p>
    </div>
  );
}

function JobCard({
  tone,
  title,
  children,
}: {
  tone: 'done' | 'failed';
  title: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-quanta-smoke bg-quanta-air p-5">
      <div className="flex items-start gap-3">
        <span
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
            tone === 'failed'
              ? 'bg-quanta-ballet text-quanta-candy'
              : 'bg-green-100 text-green-700'
          }`}
        >
          <Icon
            name={tone === 'failed' ? 'close' : 'check'}
            className="h-4 w-4"
          />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold break-words text-quanta-space">
            {title}
          </p>
          {children}
        </div>
      </div>
    </div>
  );
}

function ActivityPanel({ result }: { result: ActionResult | undefined }) {
  function body() {
    if (!result) {
      return (
        <ActivityEmpty hint="Runs you start appear here with their report." />
      );
    }
    if (result.ok === false) {
      return (
        <JobCard tone="failed" title="Transfer failed to start">
          <p className="mt-1 text-sm text-quanta-space">
            {result.error.message}
          </p>
          <p className="mt-1 text-xs text-quanta-pigeon">
            Error code: {result.error.code}
          </p>
        </JobCard>
      );
    }
    if (result.intent !== 'transfer') {
      return (
        <ActivityEmpty hint="Preflight ran, but nothing has been beamed yet. Completed transfers show up here." />
      );
    }

    const failed = result.report.failed;
    return (
      <JobCard
        tone={failed ? 'failed' : 'done'}
        title={`${failed ? 'Partially beamed' : 'Beamed'} ${result.form.sourceUrl}`}
      >
        <p className="mt-1 font-mono text-xs break-all text-quanta-pigeon">
          {result.form.sourceUrl} → {result.report.destinationUrl}
        </p>
        <p className="mt-2 text-sm text-quanta-pigeon">
          Created {result.report.created.length}, replaced{' '}
          {result.report.replaced.length}, reused {result.report.reused.length}.{' '}
          <a
            className="text-quanta-sapphire underline"
            href={result.report.destinationUrl}
          >
            Open destination
          </a>
        </p>
        {failed && (
          <p className="mt-2 text-xs text-quanta-candy">
            Stopped at {failed.destinationUrl}: {failed.message}
          </p>
        )}
      </JobCard>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {body()}
      <p className="text-center text-xs text-quanta-pigeon">
        Live progress, cancellation, and run history arrive with persistent
        jobs.
      </p>
    </div>
  );
}

export default function MrScotty() {
  const { destinationUrl } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>() as ActionResult | undefined;
  const navigation = useNavigation();
  const busy = navigation.state !== 'idle';

  const [tab, setTab] = useState<'new' | 'activity'>('new');
  const [policy, setPolicy] = useState<ConflictPolicy>('fail');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sourceUrlValue, setSourceUrlValue] = useState(
    result?.ok ? result.form.sourceUrl : '',
  );
  const [destinationUrlValue, setDestinationUrlValue] =
    useState(destinationUrl);

  useEffect(() => {
    if (!result?.ok) return;
    setPolicy(result.form.overwrite ? 'replace' : 'fail');
    setSourceUrlValue(result.form.sourceUrl);
    setDestinationUrlValue(result.form.destinationUrl);
    if (result.intent === 'transfer') setTab('activity');
  }, [result]);

  return (
    <Container as="main" width="layout" className="w-full px-6 py-12">
      <header className="mb-6 flex items-start gap-4">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-quanta-sapphire to-[#0a5fa6] text-white shadow-sm">
          <Icon name="beam" className="h-6 w-6" />
        </span>
        <div className="min-w-0">
          <p className="text-xs font-medium tracking-widest text-quanta-pigeon uppercase">
            Site Setup · Content
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-quanta-space">
            Mr. Scotty
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-quanta-pigeon">
            Beam content between any <code>plone.restapi</code> servers. Paths
            and UUIDs are preserved, structure is recreated, and internal image
            dependencies travel with their content.
          </p>
        </div>
      </header>

      <RACTabs
        selectedKey={tab}
        onSelectionChange={(key) => setTab(key as 'new' | 'activity')}
      >
        <TabList
          aria-label="Mr. Scotty"
          className="mb-6 border-b border-quanta-smoke"
        >
          <Tab id="new">New transfer</Tab>
          <Tab id="activity">Activity</Tab>
        </TabList>

        <TabPanel id="new" shouldForceMount className="flex flex-col gap-6">
          <Form id={FORM_ID} method="post" noValidate>
            {policy === 'replace' && (
              <input type="hidden" name="overwrite" value="true" />
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
                    <span className="truncate font-mono text-quanta-space">
                      {sourceUrlValue || 'source URL'}
                    </span>
                    <Icon name="arrow" className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate font-mono text-quanta-space">
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
                  <Radio
                    value="fail"
                    className={({ isSelected }: { isSelected: boolean }) =>
                      `w-full items-start rounded-lg border p-3 ${
                        isSelected
                          ? 'border-quanta-sapphire bg-quanta-azure/10'
                          : 'border-quanta-smoke'
                      }`
                    }
                  >
                    <span className="flex flex-col">
                      <span className="flex items-center gap-2 font-medium text-quanta-space">
                        Fail
                        <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-green-700 uppercase">
                          safe
                        </span>
                      </span>
                      <span className="mt-0.5 text-xs text-quanta-pigeon">
                        Abort before any write when the path or a UUID collides.
                        The default.
                      </span>
                    </span>
                  </Radio>
                  <Radio
                    value="replace"
                    className={({ isSelected }: { isSelected: boolean }) =>
                      `w-full items-start rounded-lg border p-3 ${
                        isSelected
                          ? 'border-quanta-sapphire bg-quanta-azure/10'
                          : 'border-quanta-smoke'
                      }`
                    }
                  >
                    <span className="flex flex-col">
                      <span className="flex items-center gap-2 font-medium text-quanta-space">
                        Replace existing content
                        <span className="rounded bg-quanta-ballet px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-quanta-candy uppercase">
                          destructive
                        </span>
                      </span>
                      <span className="mt-0.5 text-xs text-quanta-pigeon">
                        Delete the item at the source-relative path, then
                        recreate it. Unrelated siblings and parents are
                        preserved. Confirmed before it runs.
                      </span>
                    </span>
                  </Radio>
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
              className="rounded-xl border border-quanta-candy bg-quanta-ballet p-5 text-sm text-quanta-space"
              role="alert"
            >
              <p className="font-semibold">Transfer could not start</p>
              <p className="mt-1">{result.error.message}</p>
              <p className="mt-2 text-xs text-quanta-pigeon">
                Error code: {result.error.code}
              </p>
            </section>
          )}
          {result?.ok === true && <PlanReview result={result} />}
        </TabPanel>

        <TabPanel id="activity" shouldForceMount>
          <ActivityPanel result={result} />
        </TabPanel>
      </RACTabs>

      <Modal isOpen={confirmOpen} onOpenChange={setConfirmOpen} isDismissable>
        <Dialog className="max-w-md p-6 outline-none">
          <h2 className="text-lg font-semibold text-quanta-space">
            Confirm replace
          </h2>
          <p className="mt-2 text-sm text-quanta-pigeon">
            This transfer deletes the existing content at the source-relative
            path and recreates it. Structural parents and unrelated siblings are
            left untouched.
          </p>
          <div className="mt-5 flex justify-end gap-3">
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
        </Dialog>
      </Modal>
    </Container>
  );
}
