import { expect, test, type BrowserContext } from "@playwright/test";
import { pageImage, sampleDocuments, samplePage } from "./fixtures/documents";

const url = "http://127.0.0.1:5173";
const scanned = { ...sampleDocuments[0], document_id: 42, title: null, filename: "Scan 2026-11-09 10.42.00.pdf", status: "OCR", media_type: "pdf", page_count: 2 };

/** The API with a scanner; `scan` answers POST /api/scan and sees each request body. */
async function mockApi(context: BrowserContext, options: { scanner: boolean; scan?: (body: unknown) => string }) {
  await context.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/scan") {
      await route.fulfill({ contentType: "text/event-stream", body: options.scan!(route.request().postDataJSON()) });
      return;
    }
    if (path.includes("/thumbnails/") || path.endsWith("/file") || path.endsWith("/image")) {
      await route.fulfill({ contentType: "image/svg+xml", body: pageImage() });
      return;
    }
    const responses: Record<string, unknown> = {
      "/api/health": { embedding_configured: true, scanner_configured: options.scanner },
      "/api/senders": [],
      "/api/documents": { items: sampleDocuments, total: sampleDocuments.length, page: 1, page_size: 24 },
      "/api/documents/42": scanned,
      "/api/documents/42/pages": [samplePage(), samplePage()],
    };
    await route.fulfill({ json: responses[path] ?? {} });
  });
}

const events = (...items: [string, unknown][]) => items.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");

test("scans with the chosen options, shows the pages and opens the new document", async ({ page, context }) => {
  const requests: unknown[] = [];
  await mockApi(context, {
    scanner: true,
    scan: (body) => {
      requests.push(body);
      return events(["progress", { pages: 1 }], ["progress", { pages: 2 }], ["result", { document: scanned, pages: 2 }]);
    },
  });
  await page.goto(url);

  await page.getByRole("button", { name: "Scan", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Scan" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("group", { name: "Paper from" }).getByRole("button", { name: "Auto" })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByRole("group", { name: "Sides" }).getByRole("button", { name: "Single-sided" })).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("button", { name: "Feeder" }).click();
  await expect(dialog.getByText("Every sheet in the feeder becomes one document.")).toBeVisible();
  await dialog.getByRole("button", { name: "Dual-sided" }).click();
  await expect(dialog.getByRole("button", { name: "Dual-sided" })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByText("Both sides of every sheet in the feeder become one document.")).toBeVisible();
  await dialog.getByRole("button", { name: "Color", exact: true }).click();
  await dialog.getByRole("button", { name: "600 dpi" }).click();
  await dialog.getByRole("button", { name: "Scan", exact: true }).click();

  await expect(dialog).toBeHidden();
  const tray = page.getByRole("status", { name: "Scan" });
  await expect(tray.getByText("Scan added")).toBeVisible();
  await expect(tray.getByText("2 pages added and queued for reading")).toBeVisible();
  expect(requests).toEqual([{ source: "feeder", mode: "color", dpi: 600, duplex: true }]);

  await tray.getByRole("button", { name: "Open" }).click();
  await expect(page.getByRole("dialog", { name: scanned.filename })).toBeVisible();
  await page.keyboard.press("Escape");

  // The choices are remembered for the next scan, and glass disables dual-sided without losing the saved choice.
  await page.getByRole("button", { name: "Scan", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Feeder" })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByRole("button", { name: "Dual-sided" })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByRole("button", { name: "600 dpi" })).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("button", { name: "Glass" }).click();
  await expect(dialog.getByRole("button", { name: "Dual-sided" })).toBeDisabled();
  await expect(dialog.getByText("Glass scans one side at a time.")).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
});

test("a scanner problem is shown with a way to try again", async ({ page, context }) => {
  let attempts = 0;
  await mockApi(context, {
    scanner: true,
    scan: () => {
      attempts += 1;
      return events(["error", { message: "There is no paper in the feeder." }]);
    },
  });
  await page.goto(url);
  await page.getByRole("button", { name: "Scan", exact: true }).click();
  await page.getByRole("dialog", { name: "Scan" }).getByRole("button", { name: "Scan", exact: true }).click();

  const alert = page.getByRole("alert");
  await expect(alert.getByText("Scan failed")).toBeVisible();
  await expect(alert.getByText("There is no paper in the feeder.")).toBeVisible();
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => attempts).toBe(2);
});

test("there is no Scan button without a scanner", async ({ page, context }) => {
  await mockApi(context, { scanner: false });
  await page.goto(url);
  await expect(page.getByRole("button", { name: "Upload" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Scan", exact: true })).toHaveCount(0);
});
