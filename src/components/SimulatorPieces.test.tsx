import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CacheModeSelector, ScenarioCard, SpeedSelector } from "./SimulatorPieces";

function pressedButtons(markup: string) {
  return [...markup.matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>(.*?)<\/button>/g)].map(
    ([, pressed, body]) => ({ pressed: pressed === "true", text: body.replace(/<[^>]+>/g, "") })
  );
}

describe("toggle controls expose their selected state", () => {
  it("marks only the active playback speed as pressed", () => {
    const buttons = pressedButtons(renderToStaticMarkup(<SpeedSelector speed={4} onSpeed={() => {}} />));
    expect(buttons).toEqual([
      { pressed: false, text: "1×" },
      { pressed: false, text: "2×" },
      { pressed: true, text: "4×" },
      { pressed: false, text: "8×" }
    ]);
  });

  it("marks only the active cache mode as pressed", () => {
    const buttons = pressedButtons(renderToStaticMarkup(<CacheModeSelector mode="off" onMode={() => {}} />));
    expect(buttons).toEqual([
      { pressed: false, text: "runtime" },
      { pressed: false, text: "force on" },
      { pressed: true, text: "off" }
    ]);
  });

  it("marks the selected scenario card as pressed", () => {
    const card = (active: boolean) =>
      renderToStaticMarkup(
        <ScenarioCard title="Chatbot" sub="3 turns" type="chatbot" active={active} onClick={() => {}} />
      );
    expect(card(true)).toContain('aria-pressed="true"');
    expect(card(false)).toContain('aria-pressed="false"');
  });
});
