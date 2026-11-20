/**
 * The scenario-review browser view (Q2r2).
 *
 * Plain DOM, no framework: the page loads a `review-queue.jsonl` and an optional
 * `dispositions.jsonl` from the reviewer's disk, shows the queue with
 * lesson/section/source/turn/status filters, and opens one embedded
 * `riichiprac.scenario-report` at a time. Accept/reject appends to the browser's
 * session log and the exporter turns it into the bulk `review-verdicts` document
 * that `mine_replays review --verdicts` already validates. No grading happens
 * here: the report's answer and verdict are shown, never recomputed.
 *
 * The queue contains the answer, so the list is deliberately answer-free and the
 * answer appears only in the opened report, matching the app's spoiler gate.
 */

import {
  STATUSES,
  answerText,
  buildVerdictsDocument,
  contextLine,
  dispositionsJsonl,
  filterItems,
  latestVerdicts,
  mortalRanking,
  sampleItems,
  statusOf,
  summarize,
} from "./review-core.mjs";

const LIMIT_OPTIONS = [25, 50, 100, 250, 1000];

/**
 * @param {HTMLElement} root
 * @param {{
 *   items: any[],
 *   dispositions?: any[],
 *   session: { entries: () => any[], record: (item: any, verdict: "accepted"|"rejected", note: string, now?: Date) => any, clear?: () => void },
 *   seed?: string,
 *   limit?: number,
 *   now?: () => Date,
 *   onExportVerdicts?: (document: any) => void,
 *   onExportDispositions?: (text: string) => void,
 * }} options
 */
export function mountReviewView(root, options) {
  const doc = root.ownerDocument;
  const items = options.items;
  const session = options.session;
  const now = options.now ?? (() => new Date());
  const onExportVerdicts =
    options.onExportVerdicts ??
    ((document_) => download(doc, "review-verdicts.json", JSON.stringify(document_, null, 2), "application/json"));
  const onExportDispositions =
    options.onExportDispositions ??
    ((text) => download(doc, "dispositions.jsonl", text, "application/x-ndjson"));

  /** @type {Map<string, any>} */
  let latest = latestVerdicts([
    ...(options.dispositions ?? []),
    ...session.entries(),
  ]);
  /** @type {{lesson: string, section: string, family: string, turn: string, status: string}} */
  const filter = { lesson: "", section: "", family: "", turn: "", status: "all" };
  let seed = options.seed ?? "q2r2";
  let sampleSize = 0;
  let limit = options.limit ?? 50;
  /** @type {string | null} */
  let selected = null;
  /** @type {any[]} */
  let visible = [];

  root.classList.add("review-view");
  root.replaceChildren();

  const byId = new Map(items.map((item) => [item.queue_id, item]));
  const el = (tag, attrs = {}, text) => {
    const node = doc.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else node.setAttribute(key, String(value));
    }
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // --- Header -------------------------------------------------------------
  const header = el("header", { class: "review-header" });
  header.append(el("h1", {}, "Scenario review"));
  const progress = el("p", { id: "review-progress", role: "status", "aria-live": "polite" });
  header.append(progress);
  const actions = el("div", { class: "review-actions", role: "group", "aria-label": "Session exports" });
  const exportVerdictsButton = el("button", { type: "button", id: "export-verdicts" }, "Export verdicts JSON");
  exportVerdictsButton.addEventListener("click", () => {
    onExportVerdicts(buildVerdictsDocument(session.entries()));
  });
  const exportDispositionsButton = el(
    "button",
    { type: "button", id: "export-dispositions" },
    "Export dispositions JSONL",
  );
  exportDispositionsButton.addEventListener("click", () => {
    onExportDispositions(dispositionsJsonl(session.entries()));
  });
  actions.append(exportVerdictsButton, exportDispositionsButton);
  header.append(actions);
  root.append(header);

  // --- Filters ------------------------------------------------------------
  const filterSection = el("section", { class: "review-filters", "aria-labelledby": "filters-heading" });
  filterSection.append(el("h2", { id: "filters-heading" }, "Filters"));
  const select = (id, label, values, placeholder, onChange) => {
    const wrapper = el("label", { class: "filter-field", for: id });
    wrapper.append(el("span", { class: "filter-label" }, label));
    const control = el("select", { id });
    control.append(el("option", { value: "" }, placeholder));
    for (const value of values) {
      control.append(el("option", { value }, value));
    }
    control.addEventListener("change", () => onChange(control.value));
    wrapper.append(control);
    return wrapper;
  };
  const unique = (field) =>
    [...new Set(items.map((item) => item[field]).filter((value) => typeof value === "string" && value !== ""))].sort();
  filterSection.append(
    select("filter-lesson", "Lesson", unique("lesson"), "All lessons", (value) => {
      filter.lesson = value;
      render();
    }),
    select("filter-section", "Section", unique("book_section"), "All sections", (value) => {
      filter.section = value;
      render();
    }),
    select("filter-family", "Source", unique("replay_family"), "All sources", (value) => {
      filter.family = value;
      render();
    }),
    select("filter-turn", "Turn", ["early", "mid", "late"], "All turns", (value) => {
      filter.turn = value;
      render();
    }),
  );

  const statusFieldset = el("fieldset", { class: "filter-status" });
  statusFieldset.append(el("legend", {}, "Status"));
  for (const status of ["all", ...STATUSES]) {
    const label = el("label", { for: `status-${status}` });
    const radio = el("input", {
      type: "radio",
      name: "review-status",
      id: `status-${status}`,
      value: status,
    });
    if (status === "all") radio.checked = true;
    radio.addEventListener("change", () => {
      filter.status = status;
      render();
    });
    label.append(radio, el("span", {}, status === "all" ? "All" : status));
    statusFieldset.append(label);
  }
  filterSection.append(statusFieldset);

  const sampleField = el("div", { class: "filter-sample", role: "group", "aria-labelledby": "sample-heading" });
  sampleField.append(el("h3", { id: "sample-heading" }, "Spot-check sample"));
  const sampleLabel = el("label", { for: "sample-size" });
  sampleLabel.append(el("span", { class: "filter-label" }, "Size"));
  const sampleInput = el("input", { type: "number", id: "sample-size", min: "0", step: "1", value: "0" });
  sampleLabel.append(sampleInput);
  const seedLabel = el("label", { for: "sample-seed" });
  seedLabel.append(el("span", { class: "filter-label" }, "Seed"));
  const seedInput = el("input", { type: "text", id: "sample-seed", value: seed });
  seedInput.addEventListener("change", () => {
    seed = seedInput.value.trim() || "q2r2";
  });
  seedLabel.append(seedInput);
  const sampleButton = el("button", { type: "button", id: "apply-sample" }, "Sample");
  sampleButton.addEventListener("click", () => {
    const parsed = Number.parseInt(sampleInput.value, 10);
    sampleSize = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    selected = null;
    render();
  });
  const clearSampleButton = el("button", { type: "button", id: "clear-sample" }, "Show all");
  clearSampleButton.addEventListener("click", () => {
    sampleSize = 0;
    sampleInput.value = "0";
    render();
  });
  sampleField.append(sampleLabel, seedLabel, sampleButton, clearSampleButton);
  filterSection.append(sampleField);

  const limitLabel = el("label", { class: "filter-field", for: "row-limit" });
  limitLabel.append(el("span", { class: "filter-label" }, "Rows per page"));
  const limitSelect = el("select", { id: "row-limit" });
  for (const value of LIMIT_OPTIONS) {
    const option = el("option", { value: String(value) }, String(value));
    if (value === limit) option.selected = true;
    limitSelect.append(option);
  }
  limitSelect.addEventListener("change", () => {
    limit = Number.parseInt(limitSelect.value, 10);
    render();
  });
  limitLabel.append(limitSelect);
  filterSection.append(limitLabel);
  root.append(filterSection);

  // --- Queue table and report panel --------------------------------------
  const main = el("div", { class: "review-main" });
  const queueSection = el("section", { class: "review-queue", "aria-labelledby": "queue-heading" });
  const queueHeading = el("h2", { id: "queue-heading" }, "Queue");
  const queueHint = el(
    "p",
    { class: "review-hint" },
    "The list never shows the answer; open a row to read its report. j/k move, a accepts, r rejects.",
  );
  const table = el("table", { "aria-labelledby": "queue-heading" });
  const caption = el("caption");
  const thead = el("thead");
  const headRow = el("tr");
  for (const heading of ["Queue id", "Lesson", "Section", "Turn", "Source", "Hand", "Status"]) {
    headRow.append(el("th", { scope: "col" }, heading));
  }
  thead.append(headRow);
  const tbody = el("tbody");
  table.append(caption, thead, tbody);
  queueSection.append(queueHeading, queueHint, table);
  main.append(queueSection);

  const reportSection = el("section", { class: "review-report", "aria-labelledby": "report-heading", tabindex: "-1" });
  main.append(reportSection);
  root.append(main);

  // --- Rendering ----------------------------------------------------------
  function currentFilter() {
    return {
      lessons: filter.lesson ? [filter.lesson] : [],
      sections: filter.section ? [filter.section] : [],
      families: filter.family ? [filter.family] : [],
      turns: filter.turn ? [filter.turn] : [],
      statuses: filter.status === "all" ? [] : [filter.status],
    };
  }

  function syncLatest() {
    latest = latestVerdicts([...(options.dispositions ?? []), ...session.entries()]);
  }

  function renderProgress(shown, filtered) {
    const summary = summarize(items, latest);
    const done = summary.accepted + summary.rejected;
    const percent = summary.total === 0 ? 0 : (100 * done) / summary.total;
    progress.textContent =
      `${summary.total} item(s) · ${summary.accepted} accepted · ${summary.rejected} rejected · ` +
      `${summary.pending} pending · ${percent.toFixed(1)}% dispositioned · ` +
      `showing ${shown} of ${filtered} filtered`;
  }

  function renderRows() {
    const filtered = filterItems(items, latest, currentFilter());
    const sampled = sampleSize > 0 ? sampleItems(filtered, sampleSize, seed) : filtered;
    visible = sampled.slice(0, limit);
    tbody.replaceChildren();
    for (const item of visible) {
      const row = el("tr", { "data-queue-id": item.queue_id });
      const idCell = el("td");
      const open = el(
        "button",
        {
          type: "button",
          class: "queue-id",
          "aria-label": `Open report for ${item.queue_id}`,
        },
        item.queue_id,
      );
      if (item.queue_id === selected) {
        row.setAttribute("aria-current", "true");
        row.classList.add("selected");
      }
      open.addEventListener("click", () => selectItem(item.queue_id));
      idCell.append(open);
      row.append(
        idCell,
        el("td", {}, item.lesson ?? "-"),
        el("td", {}, item.book_section ?? "-"),
        el("td", {}, `${item.turn_bucket ?? "?"} ${item.turn ?? "?"}`),
        el("td", {}, item.replay_family ?? "-"),
        el("td", { class: "hand", "data-hand": "1" }, item.review?.table?.hand_string ?? "?"),
        el("td", { class: "status", "data-status": statusOf(item, latest) }, statusOf(item, latest)),
      );
      tbody.append(row);
    }
    caption.textContent =
      `${visible.length} row(s) shown` +
      (sampled.length > visible.length ? ` of ${sampled.length} matching` : "") +
      `; seed ${seed}`;
    renderProgress(visible.length, filtered.length);
  }

  function renderReport() {
    reportSection.replaceChildren();
    const item = selected ? byId.get(selected) : null;
    reportSection.append(el("h2", { id: "report-heading" }, item ? `Report · ${item.queue_id}` : "Report"));
    if (!item) {
      reportSection.append(el("p", { class: "review-hint" }, "Select a queue row to read its report."));
      return;
    }
    const report = item.review ?? {};
    const table_ = report.table ?? {};
    const status = statusOf(item, latest);
    const verdictNote = latest.get(item.queue_id)?.note;

    const verdictLine = el("p", { class: "report-verdict" });
    verdictLine.append(
      el("strong", {}, item.decision?.prompt ?? report.decision?.prompt ?? "Decision"),
      el("span", { class: `badge badge-${status}`, id: "report-status" }, status),
    );
    reportSection.append(verdictLine);
    reportSection.append(
      el("p", { class: "report-answer", id: "report-answer" }, `Correct answer: ${answerText(table_.correct_action)}`),
    );
    reportSection.append(el("p", { class: "report-context" }, contextLine(table_)));
    if (table_.scenario_note) {
      reportSection.append(el("p", { class: "report-note" }, table_.scenario_note));
    }

    const tableHeading = el("h3", {}, "Table");
    const snapshot = el("ul", { class: "table-snapshot" });
    const human = (table_.players ?? []).find((player) => player.is_human) ?? {};
    snapshot.append(
      el("li", {}, `Hand: ${(human.hand ?? table_.tiles ?? []).join(" ")}${human.draw ? ` + ${human.draw}` : ""}`),
      el("li", {}, `Shanten: ${table_.shanten ?? "?"}; ukeire: ${table_.ukeire_total ?? "?"}`),
      el("li", {}, `Dora: ${(table_.dora_indicators ?? []).join(" ") || "-"}`),
    );
    reportSection.append(tableHeading, snapshot);

    const players = el("table", { class: "players" });
    const playersHead = el("tr");
    for (const heading of ["Player", "Wind", "Score", "Riichi", "River", "Melds"]) {
      playersHead.append(el("th", { scope: "col" }, heading));
    }
    const playersHeadGroup = el("thead");
    playersHeadGroup.append(playersHead);
    players.append(playersHeadGroup);
    const playersBody = el("tbody");
    for (const player of table_.players ?? []) {
      const row = el("tr");
      row.append(
        el("td", {}, player.is_human ? "You" : (player.name ?? "?")),
        el("td", {}, player.wind ?? "?"),
        el("td", {}, String(player.score ?? "?")),
        el("td", {}, player.is_riichi ? "yes" : "no"),
        el("td", { class: "river" }, (player.discards ?? []).map((discard) => discard.tile ?? discard).join(" ")),
        el("td", {}, String((player.melds ?? []).length)),
      );
      playersBody.append(row);
    }
    players.append(playersBody);
    reportSection.append(players);

    const ranking = mortalRanking(item);
    if (ranking.length > 0) {
      reportSection.append(el("h3", {}, "Mortal ranking"));
      const mortalTable = el("table", { class: "mortal-ranking" });
      const mortalHead = el("tr");
      mortalHead.append(el("th", { scope: "col" }, "Action"), el("th", { scope: "col" }, "Probability"));
      const mortalHeadGroup = el("thead");
      mortalHeadGroup.append(mortalHead);
      mortalTable.append(mortalHeadGroup);
      const mortalBody = el("tbody");
      for (const entry of ranking) {
        const row = el("tr");
        row.append(el("td", {}, entry.label), el("td", {}, entry.probability.toFixed(3)));
        mortalBody.append(row);
      }
      mortalTable.append(mortalBody);
      reportSection.append(mortalTable);
    }

    const provenance = el("dl", { class: "provenance" });
    const define = (term, value) => {
      provenance.append(el("dt", {}, term), el("dd", {}, String(value ?? "-")));
    };
    define("Decision", item.decision_id);
    define("Replay", item.replay_id);
    define("Source family", item.replay_family);
    define("Event index", item.event_index);
    define("Selection reason", item.selection_reason);
    define("Label", `${item.label_kind ?? "?"} / ${item.label_stability ?? "?"} (${item.label_model ?? "?"})`);
    define("Report", `${report.report_id ?? "?"} · ${report.created_at ?? "?"}`);
    define("Report app", `${report.app?.app_version ?? "?"} @ ${report.app?.commit ?? "?"}`);
    if (verdictNote) define("Last note", verdictNote);
    reportSection.append(el("h3", {}, "Provenance"), provenance);

    const controls = el("div", { class: "verdict-controls", role: "group", "aria-label": "Record a disposition" });
    const noteLabel = el("label", { for: "verdict-note" });
    noteLabel.append(el("span", { class: "filter-label" }, "Note"));
    const noteInput = el("input", { type: "text", id: "verdict-note", value: verdictNote ?? "" });
    noteLabel.append(noteInput);
    const accept = el("button", { type: "button", id: "accept-item", class: "accept" }, `Accept ${item.queue_id}`);
    accept.addEventListener("click", () => decide(item, "accepted", noteInput.value));
    const reject = el("button", { type: "button", id: "reject-item", class: "reject" }, `Reject ${item.queue_id}`);
    reject.addEventListener("click", () => decide(item, "rejected", noteInput.value));
    controls.append(noteLabel, accept, reject);
    reportSection.append(controls);
  }

  function selectItem(queueId) {
    selected = queueId;
    render();
    reportSection.focus();
  }

  function decide(item, verdict, note) {
    session.record(item, verdict, note, now());
    syncLatest();
    render();
  }

  function step(direction) {
    if (visible.length === 0) return;
    const index = visible.findIndex((item) => item.queue_id === selected);
    const next = index === -1 ? 0 : Math.min(visible.length - 1, Math.max(0, index + direction));
    selectItem(visible[next].queue_id);
  }

  function syncExportButtons() {
    const hasEntries = session.entries().length > 0;
    exportVerdictsButton.disabled = !hasEntries;
    exportDispositionsButton.disabled = !hasEntries;
  }

  function render() {
    syncLatest();
    renderRows();
    renderReport();
    syncExportButtons();
  }

  const onKeyDown = (event) => {
    const target = event.target;
    const tag = target?.tagName?.toLowerCase();
    if (tag === "input" || tag === "select" || tag === "textarea") return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const item = selected ? byId.get(selected) : null;
    if (event.key === "j" || event.key === "ArrowDown") {
      event.preventDefault();
      step(1);
    } else if (event.key === "k" || event.key === "ArrowUp") {
      event.preventDefault();
      step(-1);
    } else if (item && event.key === "a") {
      event.preventDefault();
      decide(item, "accepted", doc.querySelector("#verdict-note")?.value ?? "");
    } else if (item && event.key === "r") {
      event.preventDefault();
      decide(item, "rejected", doc.querySelector("#verdict-note")?.value ?? "");
    }
  };
  doc.addEventListener("keydown", onKeyDown);

  // Start with no report open: the queue carries the answer, and opening a row
  // is the reviewer's deliberate "reveal" action.
  render();
  return {
    /** Recompute and re-render (also called after every verdict). */
    refresh() {
      render();
    },
    /** The rows currently on screen. */
    visible: () => visible.slice(),
    /** Detach the document-level keyboard shortcuts. */
    destroy() {
      doc.removeEventListener("keydown", onKeyDown);
      root.replaceChildren();
    },
  };
}

/**
 * Trigger a download without a server round-trip.
 *
 * @param {Document} doc
 * @param {string} filename
 * @param {string} text
 * @param {string} type
 */
export function download(doc, filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = doc.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  doc.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
