/**
 * Bootstrap for the scenario-review page (Q2r2).
 *
 * The page is static: it reads the queue and the optional disposition sidecar
 * through file inputs, keeps the new verdicts in `localStorage`, and exports
 * them for `mine_replays review --verdicts`. Nothing is uploaded and the tool
 * never writes to the data root.
 *
 *     cd frontend/tools/review-queue && python3 -m http.server 8787
 *     # then open http://localhost:8787/
 */

import { parseDispositions, parseQueue } from "./review-core.mjs";
import { createSession, sessionKey } from "./review-session.mjs";
import { mountReviewView } from "./review-ui.mjs";

const queueInput = document.querySelector("#queue-file");
const dispositionsInput = document.querySelector("#dispositions-file");
const statusLine = document.querySelector("#load-status");
const clearButton = document.querySelector("#clear-session");
const app = document.querySelector("#app");

let view = null;
/** @type {ReturnType<typeof createSession> | null} */
let session = null;

function say(message, kind = "info") {
  statusLine.textContent = message;
  statusLine.dataset.kind = kind;
}

async function readFile(input) {
  const file = input.files?.[0];
  if (!file) return null;
  return file.text();
}

async function load() {
  try {
    const queueText = await readFile(queueInput);
    if (queueText === null) {
      say("Choose a review-queue.jsonl first.", "error");
      return;
    }
    const items = parseQueue(queueText);
    let dispositions = [];
    const dispositionsText = await readFile(dispositionsInput);
    if (dispositionsText !== null) {
      dispositions = parseDispositions(dispositionsText);
    }
    const key = sessionKey(items);
    session = createSession(window.localStorage, key);
    view?.destroy();
    view = mountReviewView(app, {
      items,
      dispositions,
      session,
      seed: new URLSearchParams(window.location.search).get("seed") ?? "q2r2",
    });
    const pack = items[0]?.pack_id ?? "unknown pack";
    say(
      `Loaded ${items.length} item(s) from ${pack}` +
        (dispositions.length > 0 ? ` with ${dispositions.length} existing disposition line(s)` : "") +
        `. Session entries resume from this browser's storage (${session.entries().length} saved).`,
      "ok",
    );
    clearButton.disabled = false;
  } catch (error) {
    say(`Cannot load the queue: ${error.message}`, "error");
  }
}

queueInput.addEventListener("change", load);
dispositionsInput.addEventListener("change", load);

clearButton.addEventListener("click", () => {
  if (!session) return;
  if (!window.confirm("Clear this browser's unsaved review entries? The dispositions.jsonl on disk is not touched.")) {
    return;
  }
  session.clear();
  load();
});

say("Choose a review queue (it is never uploaded).");
