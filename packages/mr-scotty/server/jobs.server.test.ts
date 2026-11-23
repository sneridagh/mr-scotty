import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  cancelJob,
  listJobs,
  resetJobs,
  startJob,
  subscribe,
  type JobSnapshot,
} from './jobs.server';
import type {
  ExecuteOptions,
  TransferPlan,
  TransferReport,
} from './transfer.server';

const plan = {
  sourceUrl: 'https://old.example/Plone/news',
  destinationUrl: 'https://new.example/Plone',
  operations: [{}, {}, {}],
} as unknown as TransferPlan;

const report: TransferReport = {
  created: [],
  replaced: [],
  updated: [],
  reused: [],
  skipped: [],
  warnings: [],
  destinationUrl: 'https://new.example/Plone/news',
};

/** Resolves once every job in the registry has finished. */
async function settled() {
  await vi.waitFor(() => {
    expect(listJobs().every((job) => job.status !== 'running')).toBe(true);
  });
}

afterEach(() => resetJobs());

describe('jobs', () => {
  test('runs a transfer in the background and keeps its report', async () => {
    const execute = vi.fn(async () => report);
    const job = startJob(plan, { type: 'anonymous' }, { execute });

    expect(job.status).toBe('running');
    expect(job.progress).toEqual({ done: 0, total: 3 });
    await settled();

    const [done] = listJobs();
    expect(done.status).toBe('done');
    expect(done.report).toEqual(report);
    expect(done.destinationUrl).toBe('https://new.example/Plone/news');
    expect(done.finishedAt).toBeDefined();
  });

  test('publishes progress to subscribers', async () => {
    const updates: JobSnapshot[] = [];
    const unsubscribe = subscribe((job) => updates.push(job));
    const execute = vi.fn(
      async (
        _plan: TransferPlan,
        _auth: unknown,
        _fetch: unknown,
        options?: ExecuteOptions,
      ) => {
        options?.onProgress?.({ done: 1, total: 3 });
        options?.onProgress?.({ done: 3, total: 3 });
        return report;
      },
    );
    startJob(plan, { type: 'anonymous' }, { execute });
    await settled();
    unsubscribe();

    expect(updates.map((job) => [job.status, job.progress.done])).toEqual([
      ['running', 0],
      ['running', 1],
      ['running', 3],
      ['done', 3],
    ]);
  });

  test('cancels a running job through its signal', async () => {
    let signal: AbortSignal | undefined;
    const execute = vi.fn(
      async (
        _plan: TransferPlan,
        _auth: unknown,
        _fetch: unknown,
        options?: ExecuteOptions,
      ) => {
        signal = options?.signal;
        await vi.waitFor(() => expect(signal?.aborted).toBe(true));
        return { ...report, cancelled: true };
      },
    );
    const job = startJob(plan, { type: 'anonymous' }, { execute });

    expect(cancelJob(job.id)).toBe(true);
    await settled();
    expect(listJobs()[0].status).toBe('cancelled');
    expect(cancelJob(job.id)).toBe(false);
  });

  test('records a job that throws as failed', async () => {
    const execute = vi.fn(async () => {
      throw new Error('boom');
    });
    startJob(plan, { type: 'anonymous' }, { execute });
    await settled();

    expect(listJobs()[0]).toMatchObject({
      status: 'failed',
      error: { code: 'unexpected_error', message: 'boom' },
    });
  });

  test('lists jobs newest first and keeps the last 50', async () => {
    const execute = vi.fn(async () => report);
    const ids = Array.from(
      { length: 55 },
      () => startJob(plan, { type: 'anonymous' }, { execute }).id,
    );
    await settled();

    const listed = listJobs().map((job) => job.id);
    expect(listed).toHaveLength(50);
    expect(listed[0]).toBe(ids.at(-1));
    expect(listed).not.toContain(ids[0]);
  });
});
