// @vitest-environment jsdom
/**
 * The About panel's copy and its modal contract.
 *
 * The copy is checked as text because the task fixes the first two paragraphs
 * verbatim; the rest is the attribution the book's CC BY-NC licence asks for.
 * The dialog checks are DOM facts: dialog semantics, Escape, focus return and
 * the page scroll lock. The 3D shell reuses `AboutContent` inside the HUD's
 * `Sheet`, whose own tests already pin the same contract.
 */

import { useRef, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  AboutButton,
  AboutContent,
  AboutDialog,
  APP_LICENSE_URL,
  APP_SOURCE_URL,
  BOOK_LICENSE_URL,
} from "./AboutPanel";

afterEach(() => {
  cleanup();
});

function normalise(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function AboutHarness() {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <AboutButton
        buttonRef={buttonRef}
        onOpen={() => setOpen(true)}
        expanded={open}
      />
      {open && (
        <AboutDialog
          onClose={() => setOpen(false)}
          returnFocusRef={buttonRef}
        />
      )}
    </>
  );
}

describe("AboutContent: the required copy", () => {
  it('states the scenario sources, then the "not an expert" caveat verbatim', () => {
    const { container } = render(<AboutContent />);
    const paragraphs = [
      ...container.querySelectorAll<HTMLParagraphElement>(".about-content p"),
    ];
    expect(paragraphs).toHaveLength(4);
    expect(normalise(paragraphs[0].textContent ?? "")).toBe(
      "Practice the strategies in Riichi Book I through randomized scenarios. " +
        "Replay scenarios are generated from a large corpus of AI self-play " +
        "matches for realism. Generated scenarios are built procedurally, but " +
        "may lack realism.",
    );
    expect(normalise(paragraphs[1].textContent ?? "")).toBe(
      "I am not a riichi expert. I have not reviewed every single scenario, " +
        "there may be bad suggestions. Riichi strategy is all exceptions and " +
        "exceptions to exceptions, take these scenarios with a grain of salt.",
    );
  });

  it("attributes Riichi Book 1 to Daina Chiba under CC BY-NC 3.0", () => {
    const { container } = render(<AboutContent />);
    const attribution = normalise(
      container.querySelectorAll<HTMLParagraphElement>(".about-content p")[2]
        .textContent ?? "",
    );
    expect(attribution).toContain("Riichi Book 1");
    expect(attribution).toContain("Daina Chiba");
    expect(attribution).toContain("main inspiration");
    expect(attribution).toContain(
      "Creative Commons Attribution-NonCommercial 3.0 Unported License",
    );
    // No wording that suggests review or endorsement.
    expect(attribution).not.toMatch(/reviewed by|endorsed by Daina/i);
    expect(attribution).toContain("has not reviewed or endorsed");

    const licence = screen.getByRole("link", {
      name: "Creative Commons Attribution-NonCommercial 3.0 Unported License",
    });
    expect(licence.getAttribute("href")).toBe(BOOK_LICENSE_URL);
  });

  it("keeps the app's AGPL licence separate from the book's licence", () => {
    render(<AboutContent />);
    const appLicence = screen.getByRole("link", { name: "AGPL-3.0-or-later" });
    expect(appLicence.getAttribute("href")).toBe(APP_LICENSE_URL);
    const source = screen.getByRole("link", {
      name: "github.com/chairbender/riichiprac",
    });
    expect(source.getAttribute("href")).toBe(APP_SOURCE_URL);
  });
});

describe("AboutDialog: the modal contract", () => {
  it("opens as a named dialog from the ? button", () => {
    render(<AboutHarness />);
    const button = screen.getByRole("button", { name: "About riichiprac" });
    expect(button.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(button);
    const dialog = screen.getByRole("dialog", { name: "About riichiprac" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(
      screen.getByRole("button", { name: "About riichiprac" }).getAttribute(
        "aria-expanded",
      ),
    ).toBe("true");
  });

  it("moves focus to the heading, locks the page, and restores both on Escape", () => {
    render(<AboutHarness />);
    const button = screen.getByRole("button", { name: "About riichiprac" });
    fireEvent.click(button);

    const heading = screen.getByRole("heading", {
      name: "About riichiprac",
    });
    expect(document.activeElement).toBe(heading);
    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);
    expect(document.body.style.overflow).toBe("");
  });

  it("closes on a backdrop tap but not on a tap inside the panel", () => {
    const { container } = render(<AboutHarness />);
    fireEvent.click(screen.getByRole("button", { name: "About riichiprac" }));

    const panel = screen.getByRole("dialog");
    fireEvent.click(panel);
    expect(screen.queryByRole("dialog")).not.toBeNull();

    const backdrop = container.querySelector(".about-backdrop");
    if (!backdrop) throw new Error("the backdrop is missing");
    fireEvent.click(backdrop);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
