import type { LoaderFunctionArgs } from 'react-router';
import { requireManager } from '../server/auth.server';
import { listJobs, subscribe, type JobSnapshot } from '../server/jobs.server';

/** Keeps idle connections open through proxies. */
const HEARTBEAT_MS = 15_000;

/**
 * Streams Mr. Scotty's jobs as server-sent events: every job once on
 * connect, then each job again whenever it changes.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  await requireManager(request);

  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      const sendJob = (job: JobSnapshot) =>
        send(`event: job\ndata: ${JSON.stringify(job)}\n\n`);

      for (const job of listJobs().reverse()) sendJob(job);
      const unsubscribe = subscribe(sendJob);
      const heartbeat = setInterval(
        () => send(': heartbeat\n\n'),
        HEARTBEAT_MS,
      );
      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      request.signal.addEventListener('abort', () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Tells nginx not to buffer the stream.
      'X-Accel-Buffering': 'no',
    },
  });
}
