import { waitUntil } from "@vercel/functions";

// Runs a task past the HTTP response so a long sync can't hold the request
// open (which would hang the client's spinner). On Vercel, waitUntil keeps the
// serverless function alive until the task settles, up to the route's
// maxDuration. Locally — a long-lived node server with no Vercel request
// context — waitUntil throws, so the detached promise just runs on its own.
export function runInBackground(task: () => Promise<unknown>): void {
  const promise = Promise.resolve()
    .then(task)
    .catch((error) => {
      console.error("Background analytics sync failed:", error);
    });
  try {
    waitUntil(promise);
  } catch {
    // Non-Vercel runtime (local dev): nothing to do — the promise runs detached.
  }
}
