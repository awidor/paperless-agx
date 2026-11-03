import { expect, test } from "@playwright/test";

test("processing errors and document facts are selectable", async ({ page }) => {
  await page.setContent(`
    <link rel="stylesheet" href="http://127.0.0.1:5173/src/styles.css">
    <aside class="reader__info">
      <section class="panel-section facts">
        <dl><div><dt>Status</dt><dd>Failed</dd></div></dl>
        <p class="error-text">OCR page 1 exhausted the server context.</p>
      </section>
    </aside>
  `);
  const error = page.locator(".error-text");
  await expect(error).toHaveCSS("user-select", "text");
  await expect(page.locator(".facts dd")).toHaveCSS("user-select", "text");

  const box = await error.boundingBox();
  if (!box) throw new Error("processing error is not visible");
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selected).toContain("OCR page 1 exhausted the server context");
});
