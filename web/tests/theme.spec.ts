import { expect, test, type Page } from "@playwright/test";
import { pageImage, sampleDocuments, samplePage, samplePdf } from "./fixtures/documents";

const url = "http://127.0.0.1:5173";
const sampleDocument = sampleDocuments[0];
const darkFilter = "invert(0.9) hue-rotate(180deg)";

/** The computed value of a colour token, resolved the way the browser paints it. */
async function token(page: Page, name: string): Promise<string> {
  return page.evaluate((property) => {
    const probe = document.createElement("div");
    probe.style.color = `var(${property})`;
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, name);
}

test.beforeEach(async ({ context }) => {
  await context.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const document = sampleDocuments.find((item) => item.document_id === Number(path.split("/")[3])) ?? sampleDocument;
    if (path.includes("/thumbnails/") || path.endsWith("/file") || path.endsWith("/image")) {
      await route.fulfill({ contentType: "image/svg+xml", body: pageImage(document) });
      return;
    }
    if (path === "/api/search/agent") {
      const step = { kind: "search", label: "Searching “statement”" };
      const result = {
        answer: null,
        citations: [],
        results: [{
          document,
          reason: "The monthly electricity statement.",
          passage: { chunk_id: 1, page: 1, char_start: 0, char_end: 0, snippet: "", score: 0, kind: "page" },
        }],
      };
      await route.fulfill({
        contentType: "text/event-stream",
        body: `event: progress\ndata: ${JSON.stringify(step)}\n\nevent: result\ndata: ${JSON.stringify(result)}\n\n`,
      });
      return;
    }
    const responses: Record<string, unknown> = {
      "/api/health": { ocr_configured: false, embedding_configured: false },
      "/api/senders": sampleDocuments.map((item) => item.sender),
      "/api/documents": { items: sampleDocuments, total: sampleDocuments.length, page: 1, page_size: 24 },
      [`/api/documents/${document.document_id}`]: document,
      [`/api/documents/${document.document_id}/pages`]: [samplePage(document)],
    };
    await route.fulfill({ json: responses[path] ?? {} });
  });
});

test("system preference follows changes; manual choices persist and sync across tabs", async ({ page, context }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(url);
  const theme = page.getByRole("combobox", { name: "Color theme" });
  await expect(theme).toHaveValue("system");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await theme.selectOption("dark");
  await page.reload();
  await expect(theme).toHaveValue("dark");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  const darkPaper = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--color-paper").trim());
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", darkPaper);

  const other = await context.newPage();
  await other.emulateMedia({ colorScheme: "dark" });
  await other.goto(url);
  await theme.selectOption("light");
  await expect(other.getByRole("combobox", { name: "Color theme" })).toHaveValue("light");
  await expect(other.locator("html")).toHaveAttribute("data-theme", "light");
  await theme.selectOption("system");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(other.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("saved dark theme is applied before the application loads", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.addInitScript(() => localStorage.setItem("paperless-agx-theme", "dark"));
  await page.route("**/src/main.tsx", (route) => route.abort());
  await page.goto(url);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("theme switching works without browser storage", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", { get() { throw new Error("Storage unavailable"); } });
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(url);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("combobox", { name: "Color theme" }).selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("dark library, image previews and OCR pages share a neutral palette", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(url);
  await expect(page.locator(".sheet--thumb").first()).toHaveCSS("background-color", await token(page, "--color-sheet"));
  await expect(page.locator(".sheet--thumb img").first()).toHaveCSS("filter", darkFilter);
  await expect(page.getByLabel("From", { exact: true })).toHaveCSS("color-scheme", "dark");
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: testInfo.outputPath("dark-library.png"), fullPage: false, animations: "disabled" });
  await page.getByRole("combobox", { name: "Color theme" }).selectOption("light");
  await expect(page.locator(".sheet--thumb img").first()).toHaveCSS("filter", "none");
  await page.screenshot({ path: testInfo.outputPath("light-library.png"), fullPage: false, animations: "disabled" });
  await page.getByRole("combobox", { name: "Color theme" }).selectOption("dark");
  await page.getByRole("button", { name: "Open Electricity statement" }).click();
  await expect(page.locator(".reader__info input").first()).toHaveCSS("color", await token(page, "--color-ink"));
  await expect(page.locator(".image-page-frame > img")).toHaveCSS("filter", darkFilter);
  await expect(page.locator(".ocr-text-layer")).toHaveCSS("filter", "none");
  await page.screenshot({ path: testInfo.outputPath("dark-image.png"), fullPage: false });
  await page.getByRole("tab", { name: "OCR text" }).click();
  await expect(page.locator(".digital-page")).toHaveCSS("background-color", await token(page, "--color-sheet"));
  await expect(page.locator(".digital-block--title")).toHaveCSS("color", await token(page, "--color-sheet-ink"));
  await page.screenshot({ path: testInfo.outputPath("dark-document.png"), fullPage: false });
});

test("PDF pages are dark while text selection and original file downloads remain intact", async ({ page }, testInfo) => {
  await page.route("**/api/documents/1", (route) => route.fulfill({ json: { ...sampleDocument, media_type: "pdf" } }));
  await page.route("**/api/documents/1/file", (route) => route.fulfill({ contentType: "application/pdf", body: samplePdf() }));
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`${url}/?document=1`);
  await expect(page.locator(".pdf-canvas")).toHaveCSS("filter", darkFilter);
  const text = page.locator(".text-layer span").filter({ hasText: "Electricity statement" });
  await expect(text).toBeVisible();
  const box = await text.boundingBox();
  if (!box) throw new Error("PDF text was not rendered");
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toContain("Electricity statement");
  await expect(page.getByRole("link", { name: "Download original" })).toHaveAttribute("href", "/api/documents/1/file");
  await page.screenshot({ path: testInfo.outputPath("dark-pdf.png"), fullPage: false });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("combobox", { name: "Color theme" }).selectOption("light");
  await page.getByRole("button", { name: "Open Electricity statement" }).click();
  await expect(page.locator(".pdf-canvas")).toHaveCSS("filter", "none");
});

test("search evidence and thumbnails also use dark document colors", async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`${url}/?q=statement`);
  await expect(page.locator(".result .sheet--mini img").first()).toHaveCSS("filter", darkFilter);
  await expect(page.locator(".evidence__desk .image-page-frame > img")).toHaveCSS("filter", darkFilter);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: testInfo.outputPath("dark-search.png"), fullPage: false });
});

test("theme selector remains keyboard accessible at mobile widths", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto(url);
  const theme = page.getByRole("combobox", { name: "Color theme" });
  await theme.focus();
  await page.keyboard.press("d");
  await page.keyboard.press("Enter");
  await expect(theme).toHaveValue("dark");
  await expect(theme).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator(".health")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await page.screenshot({ path: testInfo.outputPath("dark-mobile.png"), fullPage: false, animations: "disabled" });
  await theme.selectOption("light");
  await expect(page.locator("body")).toHaveCSS("background-color", await token(page, "--color-desk"));
  await page.screenshot({ path: testInfo.outputPath("light-mobile.png"), fullPage: false, animations: "disabled" });
});
