import { useState } from 'react';
import config from '@plone/registry';
import { Button, Container, TextField } from '@plone/components/quanta';
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
import {
  createTransferPlan,
  executeTransferPlan,
  TransferError,
  type EndpointAuth,
  type TransferPlan,
  type TransferReport,
} from '../server/transfer.server';

type AuthMode = 'anonymous' | 'session' | 'bearer' | 'basic';

type ActionResult =
  | { ok: true; intent: 'preflight'; plan: TransferPlan }
  | {
      ok: true;
      intent: 'transfer';
      plan: TransferPlan;
      report: TransferReport;
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
    const input = {
      sourceUrl: requiredString(formData, 'sourceUrl'),
      destinationUrl: requiredString(formData, 'destinationUrl'),
      sourceAuth: endpointAuth(formData, 'source'),
      destinationAuth,
    };
    const intent = String(formData.get('intent') || 'preflight');
    const plan = await createTransferPlan(input);

    if (intent === 'transfer') {
      const report = await executeTransferPlan(plan, destinationAuth);
      return data({ ok: true, intent, plan, report } satisfies ActionResult);
    }

    return data({ ok: true, intent: 'preflight', plan } satisfies ActionResult);
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
    <fieldset className="space-y-3 rounded-lg border border-quanta-smoke p-4">
      <legend className="px-1 text-sm font-semibold text-quanta-space">
        {label} authentication
      </legend>
      <label className="flex flex-col gap-1 text-xs font-medium text-quanta-pigeon">
        Method
        <select
          className="h-11 rounded-lg bg-quanta-snow px-3 text-sm text-quanta-space"
          name={`${prefix}AuthMode`}
          value={mode}
          onChange={(event) => setMode(event.target.value as AuthMode)}
        >
          {prefix === 'destination' && (
            <option value="session">Aurora session</option>
          )}
          <option value="anonymous">Anonymous</option>
          <option value="bearer">Bearer token</option>
          <option value="basic">Username and password</option>
        </select>
      </label>
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
    </fieldset>
  );
}

function PlanResult({
  result,
}: {
  result: Extract<ActionResult, { ok: true }>;
}) {
  const creates = result.plan.operations.filter(
    (operation) => operation.status === 'create',
  );
  const reuses = result.plan.operations.filter(
    (operation) => operation.status === 'reuse',
  );

  return (
    <section
      className="space-y-4 rounded-xl border border-quanta-smoke bg-quanta-air p-6"
      aria-live="polite"
    >
      <div>
        <p className="text-xs font-medium tracking-wide text-quanta-pigeon uppercase">
          {result.intent === 'transfer'
            ? 'Transfer complete'
            : 'Preflight ready'}
        </p>
        <h2 className="mt-1 text-xl font-semibold text-quanta-space">
          {result.plan.destinationPath}
        </h2>
        <p className="mt-2 text-sm text-quanta-pigeon">
          {creates.length} item{creates.length === 1 ? '' : 's'} to create;{' '}
          {reuses.length} existing parent{reuses.length === 1 ? '' : 's'} to
          reuse.
        </p>
      </div>
      <ol className="space-y-2">
        {result.plan.operations.map((operation) => (
          <li
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-quanta-snow px-4 py-3 text-sm"
            key={operation.destinationUrl}
          >
            <span className="min-w-0 break-all text-quanta-space">
              {operation.destinationUrl}
            </span>
            <span className="rounded-full bg-quanta-air px-2 py-1 text-xs text-quanta-pigeon">
              {operation.status === 'reuse'
                ? 'reuse'
                : operation.kind === 'placeholder'
                  ? 'create Document'
                  : `create ${operation.type}`}
            </span>
          </li>
        ))}
      </ol>
      {result.intent === 'transfer' && (
        <p className="text-sm font-medium text-quanta-space">
          Created {result.report.created.length} item
          {result.report.created.length === 1 ? '' : 's'}. Final destination:{' '}
          <a className="underline" href={result.report.destinationUrl}>
            {result.report.destinationUrl}
          </a>
        </p>
      )}
    </section>
  );
}

export default function MrScotty() {
  const { destinationUrl } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>() as ActionResult | undefined;
  const navigation = useNavigation();
  const busy = navigation.state !== 'idle';

  return (
    <Container as="main" width="layout" className="w-full space-y-8 px-6 py-12">
      <header className="space-y-3">
        <p className="text-sm font-medium tracking-widest text-quanta-pigeon uppercase">
          Mr. Scotty
        </p>
        <h1 className="text-4xl font-semibold tracking-tight text-quanta-space">
          Beam Plone content
        </h1>
        <p className="max-w-2xl text-base text-quanta-pigeon">
          Inspect a source object, preserve its site-relative path and UUID, and
          create it below the destination path from the Aurora server.
        </p>
      </header>

      <Form
        className="space-y-6 rounded-xl border border-quanta-smoke bg-quanta-air p-6"
        method="post"
      >
        <TextField
          label="Source content URL"
          description="A complete plone.restapi content URL. Mr. Scotty adds ++api++ automatically."
          name="sourceUrl"
          type="url"
          placeholder="https://old.example/Plone/news/item"
          isRequired
        />
        <AuthenticationFields prefix="source" defaultMode="anonymous" />
        <TextField
          label="Destination container URL"
          description="The source-relative path is appended below this container. Mr. Scotty adds ++api++ automatically."
          name="destinationUrl"
          type="url"
          defaultValue={destinationUrl}
          isRequired
        />
        <AuthenticationFields prefix="destination" defaultMode="session" />
        <div className="flex flex-wrap gap-3">
          <Button
            type="submit"
            name="intent"
            value="preflight"
            isDisabled={busy}
          >
            {busy ? 'Inspecting…' : 'Inspect transfer'}
          </Button>
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
      {result?.ok === true && <PlanResult result={result} />}
    </Container>
  );
}
