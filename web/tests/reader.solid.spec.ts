import { appUrl, expect, rendered, test } from "./fixtures/solid";
import { documentFixtures, event, installEventStream, mockArchive, sendStream } from "./fixtures/solidApi";

test("opens a PDF, turns pages, shows the OCR replica, and saves metadata", async ({ page, context, capture }) => {
  let releasePatch!: () => void;
  const patchGate = new Promise<void>((resolve) => { releasePatch = resolve; });
  const patches: unknown[] = [];
  const pdf = { ...documentFixtures[0], media_type: "pdf" as const, page_count: 2, filename: "statement.pdf" };
  const archive = await mockArchive(context, {
    documents: [pdf, ...documentFixtures.slice(1)],
    onPatch: async (payload) => { patches.push(payload); await patchGate; },
  });
  await page.goto(appUrl);
  await expect(page.locator(".sheet-card")).toHaveCount(documentFixtures.length);
  await rendered(page);

  const dialog = page.getByRole("dialog");
  const textLayer = dialog.locator(".text-layer");
  await capture("reader open", async () => {
    await page.getByRole("button", { name: "Open Electricity statement" }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Electricity statement" })).toBeVisible();
    await expect(textLayer.getByText("Electricity statement")).toBeVisible();
    await expect(dialog.getByRole("link", { name: "Download original" })).toHaveAttribute("href", "/api/documents/1/file");
    await expect(page).toHaveURL(/document=1$/);
    await rendered(page);
  });
  expect(archive.pdfRequests).toHaveLength(1);

  await capture("reader page turn", async () => {
    await dialog.getByRole("button", { name: "Next page" }).click();
    await expect(dialog.getByText("Page 2 of 2")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Show page 2" })).toHaveAttribute("aria-pressed", "true");
    await expect(dialog.getByRole("button", { name: "Show page 1" })).toHaveAttribute("aria-pressed", "false");
    await expect(textLayer.getByText("Statement page 2")).toBeVisible();
    await expect(page).toHaveURL(/document_page=2/);
  });
  expect(archive.pdfRequests).toHaveLength(1);

  // Scrolling back up to page 1 and down to page 2 updates the active page smoothly.
  const stage = dialog.locator(".reader__stage");
  await stage.evaluate((element) => {
    element.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    element.scrollTo({ top: 0, behavior: "instant" });
  });
  await expect(dialog.getByText("Page 1 of 2")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Show page 1" })).toHaveAttribute("aria-pressed", "true");
  await stage.evaluate((element) => {
    element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
  });
  await expect(dialog.getByText("Page 2 of 2")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Show page 2" })).toHaveAttribute("aria-pressed", "true");

  await capture("reader show OCR replica", async () => {
    await dialog.getByRole("tab", { name: "OCR text" }).click();
    const replica = dialog.getByLabel("Digital replica of page 2");
    const replicaTitle = replica.locator(".digital-block--title");
    const replicaTable = replica.locator("table");
    await expect(replicaTitle).toBeVisible();
    await expect(replicaTitle).toHaveText("Electricity statement");
    await expect(replicaTable).toBeVisible();
    await expect(replicaTable).toContainText("Total due");
    await expect(replica).toHaveCSS("aspect-ratio", "100 / 140");
    await rendered(page);
  });

  const title = dialog.getByLabel("Title");
  const sender = dialog.getByLabel("Sender");
  const close = dialog.getByRole("button", { name: "Close", exact: true });
  await capture("reader edit title", async () => {
    await title.fill("Updated statement");
    await expect(title).toHaveValue("Updated statement");
    await expect(dialog.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });
  await capture("reader edit sender", async () => {
    await sender.fill("Billing department");
    await expect(sender).toHaveValue("Billing department");
  });
  await capture("reader cancel dirty close", async () => {
    const confirmation = page.waitForEvent("dialog");
    page.once("dialog", (prompt) => prompt.dismiss());
    await close.click();
    expect((await confirmation).message()).toBe("Discard your unsaved document changes?");
    await expect(title).toHaveValue("Updated statement");
    await expect(dialog).toBeVisible();
  });

  await capture("reader save metadata", async () => {
    await dialog.getByRole("button", { name: "Save changes" }).click();
    try {
      await expect(dialog.getByRole("button", { name: "Saving" })).toBeDisabled();
      await expect.poll(() => patches).toEqual([{ title: "Updated statement", sender: "Billing department", created_at: null }]);
    } finally {
      releasePatch();
    }
    await expect(dialog.getByRole("heading", { name: "Updated statement" })).toBeVisible();
    const saved = dialog.getByRole("button", { name: "Saved", exact: true });
    await expect(saved).toBeDisabled();
    await expect(saved.locator(".lucide-check")).toHaveCSS("animation-name", "pop");
    await expect(page.locator(".sheet-card__title").filter({ hasText: "Updated statement" })).toHaveCount(1);
    await rendered(page);
  });
  await capture("reader close", async () => {
    await close.click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(`${appUrl}/`);
    await expect(page.locator("dialog.reader")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open Updated statement" })).toBeVisible();
  });

  await page.getByRole("button", { name: "Open Updated statement" }).click();
  await expect(textLayer.getByText("Electricity statement")).toBeVisible();
  expect(archive.pdfRequests).toHaveLength(1);

  await dialog.getByLabel("Title").fill("Draft to discard");
  page.once("dialog", (prompt) => prompt.dismiss());
  await page.evaluate(() => history.back());
  await expect(page).toHaveURL(/document=1/);
  await expect(dialog.getByLabel("Title")).toHaveValue("Draft to discard");
  page.once("dialog", (prompt) => prompt.accept());
  await page.evaluate(() => history.back());
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(`${appUrl}/`);
});

test("switches the color theme", async ({ page, context, capture }) => {
  await mockArchive(context);
  await page.goto(appUrl);
  const theme = page.getByRole("combobox", { name: "Color theme" });
  await expect(theme).toHaveValue("system");
  await expect(page.locator(".sheet-card")).toHaveCount(documentFixtures.length);
  await rendered(page);
  await capture("theme switch", async () => {
    await theme.selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(theme).toHaveValue("dark");
    await expect(page.locator(".theme-control svg:visible")).toHaveCount(1);
    await expect(page.locator(".theme-icon--dark")).toBeVisible();
    await rendered(page);
  });
});

test("scans with the edited settings, reports progress, and opens the scanned document", async ({ page, context, capture }) => {
  const document = documentFixtures[0];
  const archive = await mockArchive(context, { scan: true });
  await installEventStream(page, "/api/scan");
  await page.goto(appUrl);
  const openScanner = page.getByRole("button", { name: "Scan", exact: true });
  const scanner = page.getByRole("dialog", { name: "Scan" });
  const feeder = scanner.getByRole("button", { name: "Feeder" });
  const tray = page.getByRole("status", { name: "Scan" });
  await expect(page.locator(".sheet-card")).toHaveCount(documentFixtures.length);
  await expect(openScanner).toBeVisible();
  await rendered(page);

  await capture("scan settings open", async () => {
    await openScanner.click();
    await expect(scanner).toBeVisible();
    await expect(scanner.getByRole("button", { name: "Auto" })).toHaveAttribute("aria-pressed", "true");
  });

  await capture("scan select feeder", async () => {
    await feeder.click();
    await expect(feeder).toHaveAttribute("aria-pressed", "true");
    await expect(scanner.getByText("Every sheet in the feeder becomes one document.")).toBeVisible();
  });

  await capture("scan start", async () => {
    await scanner.getByRole("button", { name: "Scan", exact: true }).click();
    await expect(scanner).toBeHidden();
    await expect(tray.getByText("Waiting for the first page…")).toBeVisible();
    await expect(page.getByRole("button", { name: "Scanning" })).toBeDisabled();
    expect(await page.evaluate(() => window.testStreams[0].body)).toEqual({ source: "feeder", mode: "gray", dpi: 300, duplex: false });
  });

  await capture("scan progress", async () => {
    await sendStream(page, event("progress", { pages: 1 }));
    await expect(tray.getByText("1 page scanned")).toBeVisible();
  });

  await capture("scan result", async () => {
    await sendStream(page, event("result", { document, pages: 1 }), true);
    await expect(tray.getByText("1 page added and queued for reading")).toBeVisible();
    await expect(openScanner).toBeEnabled();
    expect(archive.listRequests).toHaveLength(2);
    await rendered(page);
  });

  await capture("scan open document", async () => {
    await tray.getByRole("button", { name: "Open" }).click();
    const reader = page.getByRole("dialog", { name: "Electricity statement" });
    await expect(reader.locator(".ocr-text-layer").getByText("Electricity statement 30.09.2026")).toBeVisible();
    await expect(page.locator('.tray[aria-label="Scan"]')).toHaveCount(0);
  });
});

test("reader polling keeps edits, reprocesses the document, and deletes it", async ({ page, context, capture }) => {
  const document: (typeof documentFixtures)[number] = { ...documentFixtures[0], status: "OCR", title_source: "ai" };
  await mockArchive(context, { documents: [document] });
  await page.goto(`${appUrl}/?document=1`);
  const reader = page.getByRole("dialog");
  const title = reader.getByRole("textbox", { name: /Title/ });
  await expect(reader.locator(".facts")).toContainText("Reading the text");
  await expect(page.locator(".sheet-card .stage")).toHaveText("Reading the text");
  await rendered(page);

  await capture("reader edit title", async () => {
    await title.fill("Keep this draft");
    await expect(title).toHaveValue("Keep this draft");
    await expect(reader.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  await capture("reader poll", async () => {
    document.status = "READY";
    document.title = "Title from OCR";
    document.sender = "Sender from OCR";
    await expect(reader.getByRole("heading", { name: "Title from OCR" })).toBeVisible();
    await expect(title).toHaveValue("Keep this draft");
    await expect(reader.getByRole("combobox", { name: "Sender" })).toHaveValue("Sender from OCR");
    await expect(page.locator(".sheet-card__title")).toHaveText("Title from OCR");
    await rendered(page);
  });

  await capture("reader reprocess", async () => {
    await reader.getByRole("button", { name: "Reprocess document" }).click();
    await expect(reader.locator(".facts")).toContainText("Reading the text");
    await expect(title).toHaveValue("Keep this draft");
    await expect(page.locator(".sheet-card .stage")).toHaveText("Reading the text");
    await expect(reader.getByRole("button", { name: "Close", exact: true })).toBeEnabled();
    await rendered(page);
  });

  await capture("reader delete", async () => {
    page.once("dialog", (confirm) => confirm.accept());
    await reader.getByRole("button", { name: "Delete document" }).click();
    await expect(reader).toBeHidden();
    await expect(page.getByText("Your library is empty")).toBeVisible();
    await expect(page).toHaveURL(`${appUrl}/`);
    await rendered(page);
  });
});

test("a slow pages response lets the Reader poll finish without overlapping metadata GETs", async ({ page, context }) => {
  const gate = Promise.withResolvers<void>();
  const document: (typeof documentFixtures)[number] = { ...documentFixtures[0], status: "OCR" };
  let pages = 0;
  const archive = await mockArchive(context, {
    documents: [document],
    onPages: () => { if (++pages === 2) return gate.promise; },
  });
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 60_000);
  await page.goto(`${appUrl}/?document=1`);
  const reader = page.getByRole("dialog");
  await expect(reader.getByRole("heading", { name: "Electricity statement" })).toBeVisible();

  try {
    document.title = "Title after OCR";
    await page.clock.runFor(2_050);
    await expect.poll(() => [archive.documentRequests.length, archive.pagesRequests.length]).toEqual([2, 2]);
    await page.clock.runFor(4_000);
    await expect(reader.getByRole("heading", { name: "Electricity statement" })).toBeVisible();
    expect(archive.documentRequests).toHaveLength(2);
    expect(archive.pagesRequests).toHaveLength(2);
  } finally {
    gate.resolve();
  }
  await expect(reader.getByRole("heading", { name: "Title after OCR" })).toBeVisible();
  expect(archive.documentRequests).toHaveLength(2);
  expect(archive.pagesRequests).toHaveLength(2);

  document.status = "READY";
  await page.clock.runFor(2_000);
  await expect(reader.locator(".facts")).not.toContainText("Reading the text");
  await page.clock.runFor(4_000);
  expect(archive.documentRequests).toHaveLength(3);
  expect(archive.pagesRequests).toHaveLength(3);
});

test("keyboard paging works immediately after a delayed Reader opens", async ({ page, context }) => {
  await mockArchive(context, { documents: [{ ...documentFixtures[0], page_count: 2 }] });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await context.route("**/api/documents/1", async (route) => {
    await gate;
    await route.fallback();
  });
  await page.goto(appUrl);
  const opener = page.getByRole("button", { name: "Open Electricity statement" });
  await opener.click();
  const reader = page.getByRole("dialog");
  const close = reader.getByRole("button", { name: "Close", exact: true });
  try {
    await expect(reader).toHaveAccessibleName("Loading the document");
    await expect(close).toBeFocused();
  } finally {
    release();
  }
  await expect(reader).toHaveAccessibleName("Electricity statement");
  await expect(close).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(reader.getByText("Page 2 of 2")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(reader).toBeHidden();
  await expect(opener).toBeFocused();
});

test("a Reader retry shows loading feedback until the document arrives", async ({ page, context }) => {
  await mockArchive(context);
  let attempts = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await context.route("**/api/documents/1", async (route) => {
    if (++attempts === 1) return route.fulfill({ status: 503, json: { error: "Archive offline" } });
    await gate;
    return route.fallback();
  });
  await page.goto(appUrl + "/?document=1");
  const reader = page.getByRole("dialog");
  await reader.getByRole("button", { name: "Try again" }).click();
  try {
    await expect(reader.getByRole("status")).toHaveText("Loading the document");
  } finally {
    release();
  }
  await expect(reader).toHaveAccessibleName("Electricity statement");
});

test("cancelling Back to an unindexed entry preserves Reader close navigation", async ({ page, context }) => {
  await mockArchive(context);
  await page.goto(appUrl);
  const open = page.getByRole("button", { name: "Open Electricity statement" });
  await expect(open).toBeVisible();
  await page.evaluate(() => history.replaceState(null, "", location.href));
  await open.click();
  const reader = page.getByRole("dialog");
  const title = reader.getByLabel("Title");
  await title.fill("Unsaved");
  page.once("dialog", (confirm) => confirm.dismiss());
  const restored = page.waitForEvent("dialog");
  await page.evaluate(() => history.back());
  await restored;
  await expect(page).toHaveURL(/document=1/);
  expect(await page.evaluate(() => history.state?.paperlessReader)).toBe(true);
  page.once("dialog", (confirm) => confirm.accept());
  await reader.getByRole("button", { name: "Close", exact: true }).click();
  await expect(reader).toBeHidden();
  await expect(page).toHaveURL(appUrl + "/");
});

test("scan failure and retry stay within the reactive budget", async ({ page, context, capture }) => {
  await mockArchive(context, { scan: true });
  await installEventStream(page, "/api/scan");
  await page.goto(appUrl);
  await expect(page.locator(".sheet-card")).toHaveCount(documentFixtures.length);
  await page.getByRole("button", { name: "Scan", exact: true }).click();
  await page.getByRole("dialog", { name: "Scan" }).getByRole("button", { name: "Scan", exact: true }).click();
  await expect(page.getByText("Waiting for the first page…")).toBeVisible();
  await rendered(page);

  const alert = page.getByRole("alert");
  await capture("scan failure", async () => {
    await sendStream(page, event("error", { message: "There is no paper in the feeder." }), true);
    await expect(alert.getByText("Scan failed")).toBeVisible();
    await expect(alert.getByText("There is no paper in the feeder.")).toBeVisible();
    await rendered(page);
  });
  await capture("scan retry", async () => {
    await alert.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText("Waiting for the first page…")).toBeVisible();
    await page.waitForFunction(() => window.testStreams.length === 2);
    expect(await page.evaluate(() => window.testStreams[1].body)).toEqual({ source: "auto", mode: "gray", dpi: 300, duplex: false });
  });
});
