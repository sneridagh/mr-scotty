import {
  executeTransferPlan,
  TransferError,
  type DestinationSite,
  type EndpointAuth,
  type TransferPlan,
  type TransferProgress,
  type TypeIssue,
  type TransferReport,
} from './transfer.server';

/**
 * Transfers run as background jobs on the Aurora server, so a long one keeps
 * going while the page streams its progress. Jobs live in memory: a running
 * job and the history are lost when the server restarts, and each server
 * process only knows its own jobs.
 */

export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled';

/** What the page sees of a job: plain data, safe to serialize. */
export interface JobSnapshot {
  id: string;
  status: JobStatus;
  sourceUrl: string;
  destinationUrl: string;
  /** The sites the content is read from and written to. */
  sourceRootUrl?: string;
  destinationRootUrl?: string;
  /** Where people see the destination site, for links. */
  destinationSite?: DestinationSite;
  /** Source types beamed as other types, or skipped. */
  typeIssues?: TypeIssue[];
  startedAt: string;
  finishedAt?: string;
  progress: TransferProgress;
  report?: TransferReport;
  error?: { code: string; message: string };
}

type Listener = (job: JobSnapshot) => void;

interface Job {
  snapshot: JobSnapshot;
  controller: AbortController;
}

/** How many finished jobs are kept, newest first. */
const HISTORY_SIZE = 50;

interface Registry {
  jobs: Map<string, Job>;
  listeners: Set<Listener>;
}

// Kept on globalThis, so the development server's module reloads don't lose
// running jobs.
const REGISTRY_KEY = Symbol.for('mr-scotty.jobs');
function registry(): Registry {
  const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
  holder[REGISTRY_KEY] ??= { jobs: new Map(), listeners: new Set() };
  return holder[REGISTRY_KEY];
}

function publish(job: Job) {
  const snapshot = structuredClone(job.snapshot);
  for (const listener of registry().listeners) {
    try {
      listener(snapshot);
    } catch {
      // A broken listener must not stop the job or the other listeners.
    }
  }
}

function prune() {
  const { jobs } = registry();
  const finished = [...jobs.values()].filter(
    (job) => job.snapshot.status !== 'running',
  );
  for (const job of finished.slice(
    0,
    Math.max(0, finished.length - HISTORY_SIZE),
  )) {
    jobs.delete(job.snapshot.id);
  }
}

/** All known jobs, newest first. */
export function listJobs(): JobSnapshot[] {
  return [...registry().jobs.values()]
    .map((job) => structuredClone(job.snapshot))
    .reverse();
}

/** Calls `listener` with every job update until the returned function runs. */
export function subscribe(listener: Listener): () => void {
  const { listeners } = registry();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Starts beaming `plan` in the background and returns the new job at once.
 * `execute` is only replaced in tests.
 */
export function startJob(
  plan: TransferPlan,
  destinationAuth: EndpointAuth,
  {
    execute = executeTransferPlan,
  }: { execute?: typeof executeTransferPlan } = {},
): JobSnapshot {
  const job: Job = {
    controller: new AbortController(),
    snapshot: {
      id: crypto.randomUUID(),
      status: 'running',
      sourceUrl: plan.sourceUrl,
      destinationUrl: plan.destinationUrl,
      sourceRootUrl: plan.sourceRootUrl,
      destinationRootUrl: plan.destinationRootUrl,
      ...(plan.destinationSite
        ? { destinationSite: plan.destinationSite }
        : {}),
      ...(plan.typeIssues?.length ? { typeIssues: plan.typeIssues } : {}),
      startedAt: new Date().toISOString(),
      progress: { done: 0, total: plan.operations.length },
    },
  };
  registry().jobs.set(job.snapshot.id, job);
  prune();
  publish(job);

  void (async () => {
    try {
      const report = await execute(plan, destinationAuth, fetch, {
        signal: job.controller.signal,
        onProgress: (progress) => {
          job.snapshot.progress = progress;
          publish(job);
        },
      });
      job.snapshot.report = report;
      job.snapshot.destinationUrl = report.destinationUrl;
      job.snapshot.status = report.failed
        ? 'failed'
        : report.cancelled
          ? 'cancelled'
          : 'done';
    } catch (error) {
      job.snapshot.status = 'failed';
      job.snapshot.error =
        error instanceof TransferError
          ? { code: error.code, message: error.message }
          : {
              code: 'unexpected_error',
              message: error instanceof Error ? error.message : String(error),
            };
    }
    job.snapshot.finishedAt = new Date().toISOString();
    publish(job);
    prune();
  })();

  return structuredClone(job.snapshot);
}

/**
 * Asks a running job to stop after the item it is writing. Returns whether
 * there was a running job to cancel.
 */
export function cancelJob(id: string): boolean {
  const job = registry().jobs.get(id);
  if (!job || job.snapshot.status !== 'running') return false;
  job.controller.abort();
  return true;
}

/** Forgets every job. For tests. */
export function resetJobs() {
  const { jobs } = registry();
  for (const job of jobs.values()) job.controller.abort();
  jobs.clear();
}
