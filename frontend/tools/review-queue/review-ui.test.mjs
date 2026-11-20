// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DISPOSITION_SCHEMA, buildVerdictsDocument } from "./review-core.mjs";
import { makeQueue } from "./review-fixtures.mjs";
import { createSession, sessionKey } from "./review-session.mjs";
import { mountReviewView } from "./review-ui.mjs";

/** A `localStorage`-shaped in-memory store. */
function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    data,
  };
}

function setup({ items = makeQueue(), dispositions = [], storage = memoryStorage(), exports = {} } = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  const session = createSession(storage, sessionKey(items));
  const onExportVerdicts = exports.verdicts ?? vi.fn();
  const onExportDispositions = exports.dispositions ?? vi.fn();
  const view = mountReviewView(root, {
    items,
    dispositions,
    session,
    seed: "q2r2",
    onExportVerdicts,
    onExportDispositions,
    now: () => new Date("2026-11-19T12:00:00Z"),
  });
  return { root, session, view, onExportVerdicts, onExportDispositions, storage };
}

function rowIds(root) {
  return [...root.querySelectorAll('table[aria-labelledby="queue-heading"] tbody tr')].map(
    (row) => row.dataset.queueId,
  );
}

function rowByQueueId(root, queueId) {
  return root.querySelector(
    `table[aria-labelledby="queue-heading"] tbody tr[data-queue-id="${queueId}"]`,
  );
}

describe("review view", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("lists the queue without the answer and reveals it only in an opened report", () => {
    const { root } = setup();
    expect(rowIds(root)).toEqual(["q-001", "q-002", "q-003"]);
    const table = root.querySelector('table[aria-labelledby="queue-heading"]');
    expect(table).not.toBeNull();
    expect(table.textContent).not.toContain("fold 3m");
    expect(root.querySelector("#report-answer")).toBeNull();
    expect(root.querySelector("#report-heading").textContent).toBe("Report");

    root.querySelector('button[aria-label="Open report for q-001"]').click();
    expect(root.querySelector("#report-heading").textContent).toBe("Report · q-001");
    expect(root.querySelector("#report-answer").textContent).toBe("Correct answer: fold 3m");
  });

  it("opens a different row's report", () => {
    const { root } = setup();
    root.querySelector('button[aria-label="Open report for q-002"]').click();
    expect(root.querySelector("#report-heading").textContent).toBe("Report · q-002");
    expect(rowByQueueId(root, "q-002").getAttribute("aria-current")).toBe("true");
  });

  it("filters by section and by status", () => {
    const { root } = setup();
    const section = root.querySelector("#filter-section");
    section.value = "ch8.3";
    section.dispatchEvent(new Event("change"));
    expect(rowIds(root)).toEqual(["q-002"]);

    section.value = "";
    section.dispatchEvent(new Event("change"));
    const accepted = root.querySelector("#status-accepted");
    accepted.checked = true;
    accepted.dispatchEvent(new Event("change"));
    expect(rowIds(root)).toEqual([]);
    expect(root.querySelector("#review-progress").textContent).toContain("showing 0 of 0 filtered");
  });

  it("records accept and reject as append-only session entries", () => {
    const { root, session } = setup();
    root.querySelector('button[aria-label="Open report for q-001"]').click();
    root.querySelector("#accept-item").click();
    expect(session.entries()).toHaveLength(1);
    expect(session.entries()[0]).toMatchObject({
      schema: DISPOSITION_SCHEMA,
      queue_id: "q-001",
      verdict: "accepted",
      reviewed_at: "20261119-120000",
    });
    expect(root.querySelector("#report-status").textContent).toBe("accepted");
    expect(rowByQueueId(root, "q-001").querySelector("[data-status]").textContent).toBe("accepted");
    expect(root.querySelector("#review-progress").textContent).toContain("1 accepted");

    root.querySelector('button[aria-label="Open report for q-002"]').click();
    root.querySelector("#reject-item").click();
    expect(session.entries().map((entry) => entry.verdict)).toEqual(["accepted", "rejected"]);
    expect(rowByQueueId(root, "q-002").querySelector("[data-status]").textContent).toBe("rejected");
  });

  it("keeps a note with the verdict and shows the latest note", () => {
    const { root, session } = setup();
    root.querySelector('button[aria-label="Open report for q-001"]').click();
    root.querySelector("#verdict-note").value = "kabe read is correct";
    root.querySelector("#accept-item").click();
    expect(session.entries()[0].note).toBe("kabe read is correct");
    root.querySelector('button[aria-label="Open report for q-001"]').click();
    expect(root.querySelector("#verdict-note").value).toBe("kabe read is correct");
    const notes = [...root.querySelectorAll(".provenance dd")].map((node) => node.textContent);
    expect(notes).toContain("kabe read is correct");
  });

  it("resumes from a saved session and from on-disk dispositions", () => {
    const items = makeQueue();
    const storage = memoryStorage();
    const first = createSession(storage, sessionKey(items));
    first.record(items[0], "rejected", "saved earlier", new Date("2026-11-19T11:00:00Z"));
    const dispositions = [
      {
        schema: DISPOSITION_SCHEMA,
        version: 1,
        queue_id: "q-002",
        decision_id: items[1].decision_id,
        verdict: "accepted",
        reviewed_at: "20261119-100000",
      },
    ];

    const { root, session } = setup({ items, storage, dispositions });
    expect(session.entries()).toHaveLength(1);
    expect(rowByQueueId(root, "q-001").querySelector("[data-status]").textContent).toBe("rejected");
    expect(rowByQueueId(root, "q-002").querySelector("[data-status]").textContent).toBe("accepted");
    expect(root.querySelector("#review-progress").textContent).toContain("1 accepted");
    expect(root.querySelector("#review-progress").textContent).toContain("1 rejected");
    expect(root.querySelector("#review-progress").textContent).toContain("1 pending");
  });

  it("samples deterministically and never leaves the filtered pool", () => {
    const { root } = setup();
    const lesson = root.querySelector("#filter-lesson");
    lesson.value = "fold_to_riichi";
    lesson.dispatchEvent(new Event("change"));
    const size = root.querySelector("#sample-size");
    size.value = "1";
    root.querySelector("#apply-sample").click();
    expect(rowIds(root)).toHaveLength(1);
    expect(["q-001", "q-003"]).toContain(rowIds(root)[0]);
    const captionAfterSample = root.querySelector("caption").textContent;
    expect(captionAfterSample).toContain("seed q2r2");

    root.querySelector("#clear-sample").click();
    expect(rowIds(root)).toEqual(["q-001", "q-003"]);
  });

  it("moves with j/k and decides with a/r", () => {
    const { root, session } = setup();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    expect(root.querySelector("#report-heading").textContent).toBe("Report · q-001");
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(session.entries()[0]).toMatchObject({ queue_id: "q-001", verdict: "accepted" });
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    expect(root.querySelector("#report-heading").textContent).toBe("Report · q-002");
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true }));
    expect(session.entries().map((entry) => entry.verdict)).toEqual(["accepted", "rejected"]);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true }));
    expect(root.querySelector("#report-heading").textContent).toBe("Report · q-001");
  });

  it("exports the round-trippable bulk verdicts document and the JSONL log", () => {
    const { root, session, onExportVerdicts, onExportDispositions } = setup();
    expect(root.querySelector("#export-verdicts").disabled).toBe(true);
    root.querySelector('button[aria-label="Open report for q-001"]').click();
    root.querySelector("#accept-item").click();
    root.querySelector('button[aria-label="Open report for q-002"]').click();
    root.querySelector("#reject-item").click();

    root.querySelector("#export-verdicts").click();
    expect(onExportVerdicts).toHaveBeenCalledTimes(1);
    const document_ = onExportVerdicts.mock.calls[0][0];
    expect(document_).toEqual(buildVerdictsDocument(session.entries()));
    expect(document_.verdicts).toEqual([
      { queue_id: "q-001", verdict: "accepted" },
      { queue_id: "q-002", verdict: "rejected" },
    ]);

    root.querySelector("#export-dispositions").click();
    expect(onExportDispositions).toHaveBeenCalledTimes(1);
    const lines = onExportDispositions.mock.calls[0][0].trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).queue_id).toBe("q-001");
    root.querySelector("#export-verdicts").click();
    expect(root.querySelector("#export-verdicts").disabled).toBe(false);
  });

  it("exposes accessible names, a status region and a labelled table", () => {
    const { root } = setup();
    const status = root.querySelector("#review-progress");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(root.querySelector('section[aria-labelledby="filters-heading"]')).not.toBeNull();
    expect(root.querySelector('fieldset legend').textContent).toBe("Status");
    expect(root.querySelector('button[aria-label="Open report for q-003"]')).not.toBeNull();
    root.querySelector('button[aria-label="Open report for q-001"]').click();
    expect(root.querySelector("#accept-item").textContent).toBe("Accept q-001");
    expect(root.querySelector("#reject-item").textContent).toBe("Reject q-001");
    expect(root.querySelector('section[aria-labelledby="report-heading"]').getAttribute("tabindex")).toBe(
      "-1",
    );
  });

  it("detaches its keyboard listener when destroyed", () => {
    const { root, view, session } = setup();
    root.querySelector('button[aria-label="Open report for q-002"]').click();
    expect(root.querySelector("#report-heading").textContent).toBe("Report · q-002");

    view.destroy();
    expect(root.childElementCount).toBe(0);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(session.entries()).toHaveLength(0);
  });
});
