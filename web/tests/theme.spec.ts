import { expect, test } from "@playwright/test";
import { pageImage, sampleDocuments, samplePage, samplePdf } from "./fixtures/documents";

const url = "http://127.0.0.1:5173";
const sampleDocument = sampleDocuments[0];
const darkFilter = "invert(0.9) hue-rotate(180deg)";

test.beforeEach(async ({ context }) => {
  await context.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const document = sampleDocuments.find((item) => item.document_id === Number(path.split("/")[3])) ?? sampleDocument;
    if (path.includes("/thumbnails/") || path.endsWith("/file") || path.endsWith("/image")) {
      await route.fulfill({ contentType: "image/svg+xml", body: pageImage(document) });
      return;
    }
    const responses: Record<string, unknown> = {
      "/api/health": { ocr_configured: false, embedding_configured: false },
      "/api/senders": sampleDocuments.map((item) => item.sender),
      "/api/documents": { items: sampleDocuments, total: sampleDocuments.length, page: 1, page_size: 24 },
      [`/api/documents/${document.document_id}`]: document,
      [`/api/documents/${document.document_id}/pages`]: [samplePage(document)],
      "/api/search": { items: [], total: 0, interpretation: {} },
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
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#181818");

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
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await expect(page.locator(".document-card").first()).toHaveCSS("background-color", "rgb(34, 34, 34)");
  await expect(page.locator(".thumbnail-wrap img").first()).toHaveCSS("filter", darkFilter);
  await expect(page.getByLabel("From", { exact: true })).toHaveCSS("color-scheme", "dark");
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: testInfo.outputPath("dark-library.png"), fullPage: false, animations: "disabled" });
  await page.getByRole("combobox", { name: "Color theme" }).selectOption("light");
  await expect(page.locator(".thumbnail-wrap img").first()).toHaveCSS("filter", "none");
  await page.screenshot({ path: testInfo.outputPath("light-library.png"), fullPage: false, animations: "disabled" });
  await page.getByRole("combobox", { name: "Color theme" }).selectOption("dark");
  await page.getByRole("button", { name: "Open Electricity statement" }).click();
  await expect(page.locator(".metadata-column input").first()).toHaveCSS("color", "rgb(230, 230, 227)");
  await expect(page.locator(".image-page-frame > img")).toHaveCSS("filter", darkFilter);
  await expect(page.locator(".ocr-text-layer")).toHaveCSS("filter", "none");
  await page.screenshot({ path: testInfo.outputPath("dark-image.png"), fullPage: false });
  await page.getByRole("tab", { name: "OCR text" }).click();
  await expect(page.locator(".digital-page")).toHaveCSS("background-color", "rgb(26, 26, 26)");
  await expect(page.locator(".digital-block--title")).toHaveCSS("color", "rgb(214, 214, 214)");
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
  await expect(page.locator(".result-heading img").first()).toHaveCSS("filter", darkFilter);
  await expect(page.locator(".evidence-page .image-page-frame > img")).toHaveCSS("filter", darkFilter);
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
  await expect(page.locator(".health-pill")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await page.screenshot({ path: testInfo.outputPath("dark-mobile.png"), fullPage: false, animations: "disabled" });
  await theme.selectOption("light");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(250, 250, 249)");
  await page.screenshot({ path: testInfo.outputPath("light-mobile.png"), fullPage: false, animations: "disabled" });
});
