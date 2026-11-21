import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { assertBudgetFile, parseBudgetFile, type DiagnosticsArtifact } from "@solidjs/diagnostics";
import { captureBrowserArtifact } from "@solidjs/diagnostics/playwright";
import { expect, test as base, type Page } from "@playwright/test";

const budgets = parseBudgetFile(readFileSync(new URL("../diagnostics.budgets.json", import.meta.url), "utf8"));
type Capture = (scenario: string, interact: () => Promise<void>) => Promise<DiagnosticsArtifact>;

export const test = base.extend<{ capture: Capture }>({
  page: async ({ page }, use) => {
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(error.message));
    page.on("console", (message) => {
      if (/^\[[A-Z][A-Z_]+\]/.test(message.text())) failures.push(message.text());
    });
    await use(page);
    expect(failures).toEqual([]);
  },
  capture: async ({ page }, use, info) => {
    await use(async (scenario, interact) => {
      await page.waitForFunction(() => "__SOLID_DIAGNOSTICS__" in globalThis);
      const { artifact } = await captureBrowserArtifact(page, interact, { scenario });
      const path = info.outputPath(`${scenario.replaceAll(" ", "-")}.json`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(artifact));
      await info.attach(scenario, { path, contentType: "application/json" });
      assertBudgetFile(artifact, budgets);
      return artifact;
    });
  },
});

export { expect };
export const appUrl = "http://127.0.0.1:5173";

/** Wait for observers and font metrics to settle before measuring one interactive update. */
export async function rendered(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}
