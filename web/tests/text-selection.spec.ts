import { expect, test } from "@playwright/test";

test("processing errors and document facts are selectable", async ({ page }) => {
  await page.setContent(`
    <link rel="stylesheet" href="http://127.0.0.1:5173/src/styles.css">
    <div class="detail-panel">
      <section class="metadata-column">
        <div class="document-facts">
          <dl><div><dt>Status</dt><dd>failed</dd></div></dl>
          <p class="card-error">OCR page 1 exhausted the server context.</p>
        </div>
      </section>
    </div>
  `);
  const error = page.locator(".card-error");
  await expect(error).toHaveCSS("user-select", "text");
  await expect(page.locator(".document-facts dd")).toHaveCSS("user-select", "text");

  const box = await error.boundingBox();
  if (!box) throw new Error("processing error is not visible");
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selected).toContain("OCR page 1 exhausted the server context");
});
