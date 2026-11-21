import { appUrl, expect, test } from "./fixtures/solid";
import { documentFixtures, mockArchive } from "./fixtures/solidApi";

test("processing documents reach their new stage while search is open", async ({ page, context }) => {
  const document: (typeof documentFixtures)[number] = { ...documentFixtures[0], status: "PREVIEWING" };
  const archive = await mockArchive(context, { documents: [document] });
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 60_000);
  await page.goto(appUrl);
  await expect(page.getByText("Rendering pages")).toBeVisible();
  const search = page.getByRole("searchbox");
  await search.fill('"electric"');
  await search.press("Enter");
  await expect(page.getByRole("heading", { name: /Search results/ })).toBeVisible();

  document.status = "READY";
  await page.clock.runFor(2_050);
  await expect.poll(() => archive.listRequests.length).toBe(2);
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(page.getByRole("button", { name: "Open Electricity statement" })).toBeVisible();
  await expect(page.getByText("Rendering pages")).toHaveCount(0);
  await page.clock.runFor(4_000);
  expect(archive.listRequests).toHaveLength(2);
});

test("identical Reader save and poll errors dismiss together and a later failure is visible", async ({ page, context }) => {
  const document: (typeof documentFixtures)[number] = { ...documentFixtures[0], status: "OCR" };
  await mockArchive(context, { documents: [document] });
  let fail = false;
  await context.route("**/api/documents/1", (route) => fail
    ? route.fulfill({ status: 503, json: { error: "Archive offline" } })
    : route.fallback());
  await page.clock.install();
  await page.clock.pauseAt(Date.now() + 60_000);
  await page.goto(appUrl + "/?document=1");
  const reader = page.getByRole("dialog");
  await expect(reader).toHaveAccessibleName("Electricity statement");
  const alert = reader.getByRole("alert");

  fail = true;
  await page.clock.runFor(2_100);
  await expect(alert).toHaveText(/Archive offline/);
  await reader.getByLabel("Title").fill("An edited title");
  const save = reader.getByRole("button", { name: "Save changes" });
  const response = page.waitForResponse((response) => response.request().method() === "PATCH");
  await save.click();
  expect((await response).status()).toBe(503);
  await expect(save).toBeEnabled();
  await alert.getByRole("button", { name: "Dismiss error" }).click();
  await expect(alert).toBeHidden();
  fail = false;
  document.title = "Recovered";
  await page.clock.runFor(2_000);
  await expect(reader).toHaveAccessibleName("Recovered");

  fail = true;
  await page.clock.runFor(2_000);
  await expect(alert).toHaveText(/Archive offline/);
});

test("a bookmarked search opens while the library is loading", async ({ page, context }) => {
  const gate = Promise.withResolvers<void>();
  await mockArchive(context, { onList: () => gate.promise });
  try {
    await page.goto(appUrl + '/?q=%22electric%22');
    await expect(page.getByRole("heading", { name: /Search results/ })).toBeVisible();
  } finally {
    gate.resolve();
  }
});
