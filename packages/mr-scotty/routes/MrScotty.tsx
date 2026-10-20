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
  Separator,
  TextField,
} from '@plone/quanta';
import { Tabs as RACTabs } from 'react-aria-components';
import { Tab, TabList, TabPanel } from '@plone/quanta';
import { getAuthFromRequest, requireAuthCookie } from '@plone/react-router';
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

export async function loader({ request }: LoaderFunctionArgs) {
  await requireAuthCookie(request);
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
  await requireAuthCookie(request);
  const sessionToken = await getAuthFromRequest(request);
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
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-quanta-smoke bg-quanta-air p-6">
      <header className="mb-4">
        <h2 className="text-base font-semibold text-quanta-space">{title}</h2>
        <p className="mt-0.5 text-sm text-quanta-pigeon">{description}</p>
      </header>
      {children}
    </section>
  );
}

const STATUS_BADGE: Record<string, string> = {
  create: 'bg-green-100 text-green-700',
  reuse: 'bg-quanta-snow text-quanta-pigeon',
  replace: 'bg-quanta-ballet text-quanta-candy',
};

function operationLabel(operation: TransferPlan['operations'][number]): string {
  if (operation.status === 'reuse') return 'Reuse';
  if (operation.status === 'replace') return `Replace ${operation.type}`;
  return operation.kind === 'placeholder'
    ? 'Create Document'
    : `Create ${operation.type}`;
}

function CountChip({ label, className }: { label: string; className: string }) {
  return (
    <span
      className={`rounded-full px-2.5 py-1 text-xs font-medium ${className}`}
    >
      {label}
    </span>
  );
}

function PlanReview({
  result,
}: {
  result: Extract<ActionResult, { ok: true }>;
}) {
  const creates = result.plan.operations.filter((o) => o.status === 'create');
  const reuses = result.plan.operations.filter((o) => o.status === 'reuse');
  const replacements = result.plan.operations.filter(
    (o) => o.status === 'replace',
  );

  return (
    <section
      className="rounded-xl border border-quanta-smoke bg-quanta-air p-6"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 className="text-base font-semibold text-quanta-space">
          {result.intent === 'transfer'
            ? 'Transfer complete'
            : 'Preflight ready'}
        </h2>
        <div className="flex flex-wrap gap-2">
          <CountChip
            label={`${creates.length} create`}
            className="bg-green-100 text-green-700"
          />
          <CountChip
            label={`${replacements.length} replace`}
            className="bg-quanta-ballet text-quanta-candy"
          />
          <CountChip
            label={`${reuses.length} reuse`}
            className="bg-quanta-snow text-quanta-pigeon"
          />
        </div>
      </div>
      <p className="mt-1 font-mono text-sm break-all text-quanta-pigeon">
        {result.plan.destinationPath}
      </p>

      <Separator className="my-4 bg-quanta-smoke" />

      <ol className="flex flex-col gap-2">
        {result.plan.operations.map((operation) => (
          <li
            key={operation.destinationUrl}
            className={`flex flex-wrap items-center justify-between gap-3 rounded-lg px-4 py-3 text-sm ${
              operation.status === 'replace'
                ? 'bg-quanta-ballet'
                : 'bg-quanta-snow'
            }`}
          >
            <span className="min-w-0 break-all text-quanta-space">
              {operation.destinationUrl}
            </span>
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                STATUS_BADGE[operation.status]
              }`}
            >
              {operationLabel(operation)}
            </span>
          </li>
        ))}
      </ol>

      {result.intent === 'transfer' && (
        <p className="mt-4 text-sm font-medium text-quanta-space">
          Created {result.report.created.length} item
          {result.report.created.length === 1 ? '' : 's'} and replaced{' '}
          {result.report.replaced.length} item
          {result.report.replaced.length === 1 ? '' : 's'}. Final destination:{' '}
          <a
            className="text-quanta-sapphire underline"
            href={result.report.destinationUrl}
          >
            {result.report.destinationUrl}
          </a>
        </p>
      )}
    </section>
  );
}

function ActivityPanel({ result }: { result: ActionResult | undefined }) {
  if (!result) {
    return (
      <p className="rounded-xl border border-dashed border-quanta-smoke bg-quanta-air p-6 text-sm text-quanta-pigeon">
        No transfers yet. Runs you start appear here with their report. Live
        progress and history arrive with persistent jobs.
      </p>
    );
  }

  if (result.ok === false) {
    return (
      <div className="rounded-xl border border-quanta-smoke bg-quanta-air p-5">
        <p className="text-sm font-semibold text-quanta-candy">
          Transfer failed
        </p>
        <p className="mt-1 text-sm text-quanta-space">{result.error.message}</p>
        <p className="mt-2 text-xs text-quanta-pigeon">
          Error code: {result.error.code}
        </p>
      </div>
    );
  }

  if (result.intent !== 'transfer') {
    return (
      <p className="rounded-xl border border-dashed border-quanta-smoke bg-quanta-air p-6 text-sm text-quanta-pigeon">
        Preflight ran, but nothing has been beamed yet. Completed transfers show
        up here.
      </p>
    );
  }

  return (
    <div className="rounded-xl border border-quanta-smoke bg-quanta-air p-5">
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 rounded-full bg-green-500" />
        <p className="text-sm font-semibold text-quanta-space">
          Beamed {result.form.sourceUrl}
        </p>
      </div>
      <p className="mt-1 text-sm text-quanta-pigeon">
        Created {result.report.created.length}, replaced{' '}
        {result.report.replaced.length}, reused {result.report.reused.length}.{' '}
        <a
          className="text-quanta-sapphire underline"
          href={result.report.destinationUrl}
        >
          Open destination
        </a>
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

  useEffect(() => {
    if (!result?.ok) return;
    setPolicy(result.form.overwrite ? 'replace' : 'fail');
    if (result.intent === 'transfer') setTab('activity');
  }, [result]);

  return (
    <Container as="main" width="layout" className="w-full px-6 py-12">
      <header className="mb-6 flex flex-col gap-2">
        <p className="text-xs font-medium tracking-widest text-quanta-pigeon uppercase">
          Site Setup · Content
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-quanta-space">
          Mr. Scotty
        </h1>
        <p className="max-w-2xl text-sm text-quanta-pigeon">
          Beam content between any <code>plone.restapi</code> servers. Paths and
          UUIDs are preserved, structure is recreated, and internal image
          dependencies travel with their content.
        </p>
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
                    defaultValue={
                      result?.ok ? result.form.sourceUrl : undefined
                    }
                    isRequired
                  />
                  <AuthenticationFields
                    prefix="source"
                    defaultMode="anonymous"
                  />
                </div>
              </SectionCard>

              <SectionCard
                title="Destination"
                description="The container content is beamed into."
              >
                <div className="flex flex-col gap-4">
                  <TextField
                    label="Destination container URL"
                    description="The source-relative path is appended below this container. Mr. Scotty adds ++api++ automatically."
                    name="destinationUrl"
                    type="url"
                    defaultValue={destinationUrl}
                    isRequired
                  />
                  <AuthenticationFields
                    prefix="destination"
                    defaultMode="session"
                  />
                </div>
              </SectionCard>

              <SectionCard
                title="Options"
                description="How Mr. Scotty resolves a path that already exists."
              >
                <RadioGroup
                  aria-label="Conflict policy"
                  value={policy}
                  onChange={(value) => setPolicy(value as ConflictPolicy)}
                  isDisabled={busy}
                >
                  <Radio value="fail">
                    <span className="flex flex-col">
                      <span className="font-medium text-quanta-space">
                        Fail
                      </span>
                      <span className="text-xs text-quanta-pigeon">
                        Abort before any write when the path or a UUID collides.
                        The safe default.
                      </span>
                    </span>
                  </Radio>
                  <Radio value="replace">
                    <span className="flex flex-col">
                      <span className="font-medium text-quanta-space">
                        Replace existing content
                      </span>
                      <span className="text-xs text-quanta-pigeon">
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
