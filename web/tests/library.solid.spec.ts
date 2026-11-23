import { appUrl, expect, rendered, test } from "./fixtures/solid";
import { documentFixtures, mockArchive } from "./fixtures/solidApi";

test("typing stays local and switching views preserves the library", async ({ page, context, capture }) => {
  const archive = await mockArchive(context);
  await page.goto(appUrl);
  const covers = page.getByRole("button", { name: /^Open / });
  await expect(covers).toHaveCount(documentFixtures.length);
  await rendered(page);

  const search = page.getByRole("searchbox");
  await capture("search typing", async () => {
    await search.pressSequentially("electric");
    await expect(search).toHaveValue("electric");
    await expect(covers).toHaveCount(documentFixtures.length);
  });
  expect(archive.listRequests).toHaveLength(1);
  await expect(page).toHaveURL(`${appUrl}/`);

  await capture("grid to list", async () => {
    await page.getByRole("button", { name: "List", exact: true }).click();
    await expect(page.getByRole("table")).toBeVisible();
    await expect(page.locator(".ledger__row")).toHaveCount(documentFixtures.length);
    await expect(page).toHaveURL(/view=list$/);
  });
  expect(archive.listRequests).toHaveLength(1);
  await expect(search).toHaveValue("electric");
});

test("polling advances stages and retries the same image only after a failure", async ({ page, context, capture }) => {
  const documents = documentFixtures.slice(0, 2).map((doc) => ({ ...doc, status: "PREVIEWING" } as const));
  let ready = false;
  const archive = await mockArchive(context, {
    documents,
    thumbnail: (id) => id !== documents[1].document_id || ready,
  });
  await page.goto(appUrl);
  const cards = page.locator(".sheet-card");
  const first = cards.nth(0).locator("img");
  const second = cards.nth(1).locator("img");
  await expect(first).toHaveAttribute("data-inked", "");
  await expect(second).toBeHidden();
  await expect(cards.nth(1).locator(".sheet__blank")).toBeVisible();
  const loadedNode = await first.elementHandle();
  const failedNode = await second.elementHandle();
  await rendered(page);

  await capture("library poll", async () => {
    ready = true;
    for (const doc of archive.documents) doc.status = "READY";
    await expect(page.getByText("Rendering pages")).toHaveCount(0);
    await expect(second).toBeVisible();
    await expect.poll(() => archive.thumbnailRequests.filter((id) => id === documents[1].document_id).length).toBe(2);
    expect(await first.evaluate((node, original) => node === original, loadedNode)).toBe(true);
    expect(await second.evaluate((node, original) => node === original, failedNode)).toBe(true);
  });
  expect(archive.listRequests).toHaveLength(2);
  expect(archive.thumbnailRequests.filter((id) => id === documents[0].document_id)).toHaveLength(1);
  await loadedNode?.dispose();
  await failedNode?.dispose();
});

test("a slow library poll lands before the next request starts", async ({ page, context }) => {
  const gate = Promise.withResolvers<void>();
  const document: (typeof documentFixtures)[number] = { ...documentFixtures[0], status: "PREVIEWING" };
  let lists = 0;
  const archive = await mockArchive(context, {
    documents: [document],
    onList: () => { if (++lists === 2) return gate.promise; },
  });
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 60_000);
  await page.goto(appUrl);
  await expect(page.getByText("Rendering pages")).toBeVisible();

  try {
    await page.clock.runFor(2_050);
    await expect.poll(() => archive.listRequests.length).toBe(2);
    document.status = "OCR";
    await page.clock.runFor(4_000);
    await expect(page.getByText("Rendering pages")).toBeVisible();
    expect(archive.listRequests).toHaveLength(2);
  } finally {
    gate.resolve();
  }
  await expect(page.getByText("Reading the text")).toBeVisible();
  expect(archive.listRequests).toHaveLength(2);

  document.status = "READY";
  await page.clock.runFor(2_000);
  await expect(page.getByText("Reading the text")).toHaveCount(0);
  await page.clock.runFor(4_000);
  expect(archive.listRequests).toHaveLength(3);
});

test("filters, sorts, infinite-scrolls, and restores library URLs", async ({ page, context, capture }) => {
  const documents = [...documentFixtures, ...Array.from({ length: 20 }, (_, index) => ({
    ...documentFixtures[index % documentFixtures.length], document_id: 100 + index, sender: "Bulk",
    title: `Work order ${index + 1}`,
  }))];
  const archive = await mockArchive(context, { documents });
  await page.goto(`${appUrl}/?view=list`);
  const rows = page.locator(".ledger__row");
  const titles = page.locator(".ledger__title");
  await expect(rows).toHaveCount(24);
  await expect(page.getByRole("button", { name: "Next" })).toHaveCount(0);
  await rendered(page);

  await capture("library next page", async () => {
    await page.locator(".library-more").scrollIntoViewIfNeeded();
    await expect(rows).toHaveCount(documents.length);
  });

  await capture("library sort", async () => {
    await page.getByLabel("Sort").selectOption("title_asc");
    await expect(rows).toHaveCount(24);
    await expect(titles.first()).toHaveText("Annual account summary");
  });

  const sender = page.getByPlaceholder("All senders");
  await capture("library sender filter", async () => {
    await sender.fill("City Utilities");
    await sender.press("Tab");
    await expect(rows).toHaveCount(1);
    await expect(titles).toHaveText("Electricity statement");
    await expect(page).toHaveURL(/sender=City\+Utilities.*sort=title_asc/);
  });

  await capture("library date filter", async () => {
    await page.getByLabel("From", { exact: true }).fill("2026-09-09");
    await expect(page.getByText("No documents match these filters")).toBeVisible();
    await expect(page).toHaveURL(/from=2026-09-09/);
  });
  await capture("library reset filters", async () => {
    await page.getByRole("button", { name: "Reset filters" }).click();
    await expect(rows).toHaveCount(24);
  });
  expect(archive.listRequests.some((params) => params.get("page") === "2")).toBe(true);
  expect(archive.listRequests.some((params) => params.has("created_from"))).toBe(true);
  await page.reload();
  await expect(page.getByRole("button", { name: "List", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("a failed filter request can be retried without showing rows from the previous query", async ({ page, context }) => {
  await mockArchive(context);
  let failures = 0;
  await context.route((url) => url.pathname === "/api/documents" && url.searchParams.has("sender"), async (route) => {
    if (++failures <= 2) return route.fulfill({ status: 503, json: { error: "Archive offline" } });
    return route.fallback();
  });
  await page.goto(appUrl);
  await expect(page.locator(".sheet-card")).toHaveCount(documentFixtures.length);
  const sender = page.getByPlaceholder("All senders");
  await sender.fill("City Utilities");
  await sender.press("Tab");
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Archive offline");
  await expect(page.locator(".sheet-card")).toHaveCount(0);
  const retry = alert.getByRole("button", { name: "Try again" });
  await retry.click();
  await expect.poll(() => failures).toBe(2);
  await expect(alert).toContainText("Archive offline");
  await retry.click();
  await expect(alert).toBeHidden();
  await expect(page.locator(".sheet-card")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Open Electricity statement" })).toBeVisible();
});

test("dismissing a polling error only dismisses that failure", async ({ page, context }) => {
  const document = { ...documentFixtures[0], status: "PREVIEWING" as const };
  await mockArchive(context, { documents: [document] });
  let requests = 0;
  await context.route((url) => url.pathname === "/api/documents", (route) => {
    if (++requests === 1) return route.fallback();
    return route.fulfill({ status: 503, json: { error: "Archive offline" } });
  });
  await page.goto(appUrl);
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("Archive offline");
  await alert.getByRole("button", { name: "Dismiss error" }).click();
  await expect(alert).toBeHidden();
  await expect(alert).toContainText("Archive offline");
  await expect(alert.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Electricity statement" })).toBeVisible();
});
