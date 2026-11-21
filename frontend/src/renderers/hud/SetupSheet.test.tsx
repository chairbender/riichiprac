// @vitest-environment jsdom
/**
 * The 3D setup sheet (3D-H4).
 *
 * What this file proves, in DOM facts rather than pictures:
 *
 * - one trigger in the top bar opens the sheet, and closing it returns focus to
 *   that trigger;
 * - the sheet hosts the pool, the AI Hotseat form, both settings, the
 *   position controls and the table information, using the 2D components
 *   themselves (so labels and disabled states cannot drift);
 * - the pool keeps its staged draft: a tick is local until "Deal from pool",
 *   and a deal closes the sheet;
 * - the AI Hotseat row opens its form inline — one sheet, so no second scrim
 *   and no second `dialog` — and its Cancel returns to the pool;
 * - a nested Escape closes the picker panel first and the sheet second, and a
 *   deal never touches the scene.
 *
 * The rects are `hudLayout.test.ts`'s; the modal contract (focus trap, inert,
 * scroll lock) is `Sheet.test.tsx`'s. This file is the composition.
 */

import { useRef, useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SetupSheetProps } from "./SetupSheet";
import { SetupSheet, SetupTrigger } from "./SetupSheet";
import { HudLayer } from "./HudLayer";
import { clearHudAnchors, publishHudAnchors } from "./hudAnchors";
import type {
  BookSection,
  ScenarioOption,
  ScenarioSelection,
} from "../../scenarios";
import { ALL_SCENARIOS } from "../../scenarios";

const ANCHOR_OWNER = {};

const BOOK: BookSection = {
  chapter: 8,
  chapter_title: "Defense judgement",
  section: 1,
  section_title: "To push or to fold?",
  key: "ch8.1",
  label: "ch8.1 · To push or to fold?",
};

function lesson(
  id: string,
  label: string,
  extra: Partial<ScenarioOption> = {},
): ScenarioOption {
  return {
    id,
    label,
    description: `${label} description`,
    category: "defense_decision",
    tags: ["defense"],
    requires_ai: false,
    grading: "book_and_mortal",
    book: BOOK,
    ...extra,
  };
}

const SCENARIOS = [
  lesson("fold_to_riichi", "Fold to Riichi"),
  lesson("ai_hotseat", "AI Hotseat", {
    book: null,
    tags: ["ai"],
    requires_ai: true,
    grading: "mortal_only",
  }),
];

/** Every prop the sheet needs, with a settable selection callback. */
function setupProps(
  onSelectionChange: (selection: ScenarioSelection) => void,
  overrides: Partial<SetupSheetProps> = {},
): SetupSheetProps {
  return {
    scenarios: SCENARIOS,
    selection: ALL_SCENARIOS,
    onSelectionChange,
    packStatus: "ready",
    packCount: 1,
    packError: null,
    preferReplay: true,
    onPreferReplayChange: vi.fn(),
    hotseatOptions: { round: null, disparity: null, seat: null },
    hotseatBusy: false,
    onGenerateHotseat: vi.fn(),
    requireAgreement: true,
    aiStatus: "ready",
    agreementHint:
      "Deal book-graded hands only when Mortal plays the book answer.",
    onAgreementChange: vi.fn(),
    tableView: "stacked",
    viewHint: "How to draw the table.",
    onViewChange: vi.fn(),
    rendered3dExposed: false,
    threeUnavailableReason: null,
    exportImport: {
      canExport: true,
      description: "",
      onDescriptionChange: vi.fn(),
      fileError: null,
      fileNotice: null,
      onExport: vi.fn(),
      onImportFile: async () => undefined,
      onDismissNotice: vi.fn(),
    },
    tableInfo: <section aria-label="Table information">Round East 1</section>,
    notes: (
      <p role="status">The book and Mortal agree on 731 reviewed bases.</p>
    ),
    positionNote: null,
    ...overrides,
  };
}

interface HarnessProps {
  readonly initialOpen?: boolean;
  readonly overrides?: Partial<SetupSheetProps>;
  /** Records a committed pool deal, then closes the sheet like App does. */
  readonly onDeal?: (selection: ScenarioSelection) => void;
}

/**
 * The 3D branch's wiring: the top bar's trigger, the HUD layer and the stage.
 * The sheet is controlled here exactly as `App` controls it, so the trigger,
 * the Escape rules and the focus return cross the real element boundaries.
 */
function Harness({ initialOpen = true, overrides = {}, onDeal }: HarnessProps) {
  const [sheetOpen, setSheetOpen] = useState(initialOpen);
  const [page, setPage] = useState<"settings" | "pool">("settings");
  const stageRef = useRef<HTMLElement>(null);
  const props = setupProps(
    (selection) => {
      onDeal?.(selection);
      setSheetOpen(false);
    },
    {
      page,
      onNavigatePool: () => setPage("pool"),
      onBackToSettings: () => setPage("settings"),
      ...overrides,
    },
  );
  // Escape, a scrim tap or the header's close step back one page first.
  const close = () => {
    if (sheetOpen && page === "pool") {
      setPage("settings");
      return;
    }
    setSheetOpen(false);
  };

  return (
    <div className="app-shell app-shell--3d">
      <HudLayer
        shellRef={{ current: null }}
        stageRef={stageRef}
        onNextScenario={() => undefined}
        setupTrigger={
          <SetupTrigger
            onOpen={() => setSheetOpen(true)}
            expanded={sheetOpen}
          />
        }
        sheet={
          sheetOpen
            ? {
                title: page === "pool" ? "Scenario pool" : "Setup",
                body: <SetupSheet {...props} />,
              }
            : null
        }
        onCloseSheet={close}
      />
      <main className="table-3d" ref={stageRef}>
        <div data-testid="canvas" />
      </main>
    </div>
  );
}

beforeEach(() => {
  publishHudAnchors(ANCHOR_OWNER, {
    handBand: { left: 300, top: 600, width: 400, height: 60 },
    compass: null,
  });
});

afterEach(() => {
  cleanup();
  clearHudAnchors(ANCHOR_OWNER);
});

/**
 * Navigate to the pool page. It is a page, not a popover: the sheet's title
 * changes and the picker's list fills the pane.
 */
function openPool() {
  fireEvent.click(
    screen.getByTitle(
      "Choose one lesson, all scenarios, or a pool to randomise between",
    ),
  );
  return screen.getByRole("group", { name: "Scenario pool" });
}

describe("Setup sheet: the trigger and the modal", () => {
  it("opens from the top bar trigger and closes back to it", () => {
    render(<Harness initialOpen={false} />);
    const trigger = screen.getByRole("button", { name: "Setup" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("dialog")).toBeNull();

    trigger.focus();
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const dialog = screen.getByRole("dialog", { name: "Setup" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    // §6.5.5: focus returns to the element that opened the sheet.
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps the scene mounted and inert behind the sheet", () => {
    const { container } = render(<Harness />);
    const canvas = screen.getByTestId("canvas");
    expect(canvas).toBeTruthy();
    const stage = container.querySelector("main.table-3d") as HTMLElement;
    expect(stage.hasAttribute("inert")).toBe(true);
    // The sheet is a sibling of the stage in the HUD layer, never inside it.
    expect(stage.querySelector(".hud-sheet")).toBeNull();
    expect(container.querySelector(".hud-root .hud-sheet")).not.toBeNull();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByTestId("canvas")).toBe(canvas);
    expect(stage.hasAttribute("inert")).toBe(false);
  });
});

describe("Setup sheet: everything but the hand", () => {
  it("hosts the pool, both settings, the position controls and the table info", () => {
    render(<Harness />);
    const dialog = screen.getByRole("dialog", { name: "Setup" });

    // Every section is a heading of the dialog's outline.
    for (const name of ["Scenario", "Settings", "Position", "Table info"]) {
      expect(
        within(dialog).getByRole("heading", { name, level: 3 }),
        name,
      ).toBeTruthy();
    }

    // The pool's own trigger (its selection label), not a second picker UI.
    expect(
      within(dialog).getByRole("button", { name: /All scenarios/i }),
    ).toBeTruthy();

    // The two settings, labelled exactly as the 2D header labels them.
    const agreement = within(dialog).getByRole("checkbox", {
      name: "Mortal must agree",
    }) as HTMLInputElement;
    expect(agreement.checked).toBe(true);
    expect(agreement.disabled).toBe(false);
    const view = within(dialog).getByRole("combobox") as HTMLSelectElement;
    expect(view.value).toBe("stacked");
    expect([...view.options].map((option) => option.value)).toEqual([
      "stacked",
      "topdown",
    ]);

    // Position and table: the same 2D blocks, re-hosted.
    within(dialog).getByRole("button", { name: "Export" });
    within(dialog).getByRole("button", { name: "Import" });
    expect(
      dialog.querySelector('[aria-label="Table information"]'),
    ).not.toBeNull();
    expect(within(dialog).getByRole("status").textContent).toContain(
      "731 reviewed bases",
    );
  });

  it("disables the agreement filter while Mortal is not ready", () => {
    render(
      <Harness
        overrides={{
          aiStatus: "loading",
          agreementHint: "Waiting for the Mortal model to load…",
        }}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Setup" });
    expect(
      (
        within(dialog).getByRole("checkbox", {
          name: "Mortal must agree",
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    // The header's own tooltip text is shown inline, as the sheet's hint.
    expect(
      within(dialog).getByText(/Waiting for the Mortal model to load/),
    ).toBeTruthy();
  });

  it("offers the 3D view only when it is exposed, with its reason", () => {
    const { rerender } = render(<Harness />);
    let view = screen.getByRole("combobox") as HTMLSelectElement;
    expect([...view.options].map((option) => option.value)).toEqual([
      "stacked",
      "topdown",
    ]);

    rerender(
      <Harness
        overrides={{
          rendered3dExposed: true,
          threeUnavailableReason:
            "3D view unavailable: WebGL2 is not supported.",
        }}
      />,
    );
    view = screen.getByRole("combobox") as HTMLSelectElement;
    const option = [...view.options].find(
      (entry) => entry.value === "rendered3d",
    );
    expect(option?.disabled).toBe(true);
    expect(option?.textContent).toBe("3D (unavailable)");
    expect(option?.title).toBe("3D view unavailable: WebGL2 is not supported.");
  });
});

describe("Setup sheet: the pool keeps its draft", () => {
  it("does not apply a tick until a deal, and a deal closes the sheet", async () => {
    const user = userEvent.setup();
    const deals: ScenarioSelection[] = [];
    render(
      <Harness
        overrides={{ selection: { kind: "selected", ids: ["fold_to_riichi"] } }}
        onDeal={(selection) => deals.push(selection)}
      />,
    );

    const panel = openPool();
    const hotseatBox = within(panel).getByRole("checkbox", {
      name: /AI Hotseat/i,
    }) as HTMLInputElement;
    // A tick is a local draft: the table (and App) sees nothing.
    await user.click(hotseatBox);
    expect(hotseatBox.checked).toBe(true);
    expect(deals).toHaveLength(0);
    expect(screen.getByRole("dialog", { name: "Scenario pool" })).toBeTruthy();

    // Cancel discards the draft and returns to the settings page.
    await user.click(within(panel).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog", { name: "Setup" })).toBeTruthy();
    openPool();
    expect(
      (
        screen.getByRole("checkbox", {
          name: /AI Hotseat/i,
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
    expect(deals).toHaveLength(0);

    // Re-tick and deal: exactly one committed pool, and the sheet closes.
    await user.click(screen.getByRole("checkbox", { name: /AI Hotseat/i }));
    await user.click(screen.getByRole("button", { name: /Deal from pool/i }));
    expect(deals).toEqual([
      { kind: "selected", ids: ["fold_to_riichi", "ai_hotseat"] },
    ]);
    expect(screen.queryByRole("dialog", { name: "Setup" })).toBeNull();
  }, 60000);

  it("steps back to the settings page on the first Escape, then closes", () => {
    render(<Harness />);
    openPool();
    expect(screen.getByRole("dialog", { name: "Scenario pool" })).toBeTruthy();

    // 2026-11-21: the pool is a page, so Escape navigates back to the settings
    // page (the same as Back and a scrim tap) before it closes the sheet.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Scenario pool" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Setup" })).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("Setup sheet: the AI Hotseat form", () => {
  it("opens in place, with no second dialog or scrim", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const panel = openPool();

    await user.click(
      within(panel)
        .getByRole("checkbox", { name: /AI Hotseat/i })
        .closest("li")!
        .querySelector("button") as HTMLButtonElement,
    );

    /*
     * The hotseat form opens **inside** the pool page (2026-11-21): the picker
     * is a page of the sheet, not a nested dialog, so the only dialog is the
     * sheet itself and the page keeps its heading.
     */
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: "Scenario pool" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Scenario pool" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "AI Hotseat self-play", level: 3 }),
    ).toBeTruthy();
    // The three starting conditions are the 2D card's rows.
    for (const name of ["Round", "Point disparity", "Your seat"]) {
      expect(screen.getByRole("group", { name }), name).toBeTruthy();
    }
    expect(document.querySelector(".hotseat-backdrop")).toBeNull();
  }, 60000);

  it("returns to the pool on Cancel, and generates the chosen options", async () => {
    const user = userEvent.setup();
    const onGenerateHotseat = vi.fn();
    render(<Harness overrides={{ onGenerateHotseat }} />);

    let panel = openPool();
    await user.click(
      within(panel)
        .getByRole("checkbox", { name: /AI Hotseat/i })
        .closest("li")!
        .querySelector("button") as HTMLButtonElement,
    );
    // The form's own Cancel, not the page's: both are on the pool page now.
    await user.click(
      within(
        screen.getByRole("region", { name: "AI Hotseat self-play" }),
      ).getByRole("button", { name: "Cancel" }),
    );
    expect(
      screen.queryByRole("heading", { name: "AI Hotseat self-play" }),
    ).toBeNull();
    // The pool page is still the current page, with its list back.
    expect(screen.getByRole("group", { name: "Scenario pool" })).toBeTruthy();
    expect(
      screen.getByRole("checkbox", { name: /All scenarios/i }),
    ).toBeTruthy();

    // Open the form again, pin a round, and play.
    panel = screen.getByRole("group", { name: "Scenario pool" });
    await user.click(
      within(panel)
        .getByRole("checkbox", { name: /AI Hotseat/i })
        .closest("li")!
        .querySelector("button") as HTMLButtonElement,
    );
    await user.click(
      within(panel)
        .getByRole("checkbox", { name: /AI Hotseat/i })
        .closest("li")!
        .querySelector("button") as HTMLButtonElement,
    );
    await user.click(
      within(screen.getByRole("group", { name: "Round" })).getByRole(
        "checkbox",
        { name: "Random" },
      ),
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Round" }),
      "east_2",
    );
    await user.click(screen.getByRole("button", { name: "Play the round" }));

    expect(onGenerateHotseat).toHaveBeenCalledWith({
      round: "east_2",
      disparity: null,
      seat: null,
    });
  }, 60000);
});

describe("Setup sheet: the pool is a page (2026-11-21)", () => {
  it("navigates to the pool from the settings page and back again", () => {
    render(<Harness />);
    // The settings page shows the staged pool and a way in, not the list.
    const dialog = screen.getByRole("dialog", { name: "Setup" });
    expect(
      within(dialog).getByRole("button", { name: /All scenarios/i }),
    ).toBeTruthy();
    expect(
      within(dialog).queryByRole("group", { name: "Scenario pool" }),
    ).toBeNull();

    fireEvent.click(
      screen.getByTitle(
        "Choose one lesson, all scenarios, or a pool to randomise between",
      ),
    );

    // The pool is a page of the same sheet: its title changes and the list
    // fills the pane instead of hanging under a 300 px popover.
    const poolDialog = screen.getByRole("dialog", { name: "Scenario pool" });
    expect(poolDialog).toBe(dialog);
    expect(screen.getByRole("group", { name: "Scenario pool" })).toBeTruthy();
    // The settings sections are not on this page.
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Export" })).toBeNull();

    // Cancel returns to the settings page; the sheet stays open.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("dialog", { name: "Setup" })).toBeTruthy();
    expect(screen.getByRole("combobox")).toBeTruthy();
  });

  it("keeps the deal footer and scrolls the lesson list, not the page", () => {
    render(<Harness />);
    openPool();
    // The list is the scroll container; the footer with Deal/Back is outside it.
    const list = document.querySelector(".scenario-group-list") as HTMLElement;
    const footer = document.querySelector(
      ".scenario-picker-footer",
    ) as HTMLElement;
    expect(list).not.toBeNull();
    expect(footer).not.toBeNull();
    expect(list.contains(footer)).toBe(false);
    // The page itself is the pane: its own scroll is disabled by the stylesheet
    // so the footer cannot scroll away.
    expect(document.querySelector(".hud-setup-sheet--pool")).not.toBeNull();
  });
});
