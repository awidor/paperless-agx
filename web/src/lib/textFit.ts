import { createSignal, onSettled } from "solid-js";

export const MIN_FONT_SIZE = 4;
const LINE_HEIGHT = 1.15;
const WRAP_SLACK = 1.06;
const SAMPLE = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789,.-";

function advanceRatio(): number {
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return 0.5;
  const family = getComputedStyle(document.documentElement).getPropertyValue("--font-body").trim() || "sans-serif";
  context.font = `400 100px ${family}`;
  return context.measureText(SAMPLE).width / SAMPLE.length / 100;
}

/** Measure again after fonts load, even when the measured average did not change. */
export function createFontMetrics() {
  const [metrics, setMetrics] = createSignal({ advance: 0.5 }, { name: "page font metrics" });
  onSettled(() => {
    let live = true;
    setMetrics({ advance: advanceRatio() });
    if (document.fonts?.status === "loading") {
      void document.fonts.ready.then(() => {
        if (live) setMetrics({ advance: advanceRatio() });
      });
    }
    return () => { live = false; };
  });
  return metrics;
}

/** Estimate the largest font that fits the two line counts around the area estimate. */
export function fitFontSize(text: string, bbox: number[], boxWidth: number, boxHeight: number, advance: number): number {
  const [x0, y0, x1, y1] = bbox;
  const width = (Math.max(1, x1 - x0) / 1000) * boxWidth;
  const height = (Math.max(1, y1 - y0) / 1000) * boxHeight;
  const lineAdvance = Math.max(1, text.length) * advance * WRAP_SLACK;
  const estimate = Math.sqrt((width * height) / (lineAdvance * LINE_HEIGHT));
  const exact = height / (estimate * LINE_HEIGHT);
  let size = 0;
  for (const lines of [Math.floor(exact), Math.ceil(exact)]) {
    if (lines > 0) size = Math.max(size, Math.min((width * lines) / lineAdvance, height / (lines * LINE_HEIGHT)));
  }
  return Math.max(MIN_FONT_SIZE, Math.min(size, 96));
}
