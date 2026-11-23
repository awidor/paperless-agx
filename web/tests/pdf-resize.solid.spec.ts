import { appUrl, expect, rendered, test } from "./fixtures/solid";
import { documentFixtures, mockArchive } from "./fixtures/solidApi";

test("resizing a PDF keeps the same text span and active selection", async ({ page, context }) => {
  const pdf = { ...documentFixtures[0], media_type: "pdf" as const, page_count: 3 };
  await mockArchive(context, { documents: [pdf] });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${appUrl}/?document=${pdf.document_id}`);
  const reader = page.getByRole("dialog");
  const text = reader.locator(".text-layer").getByText("Electricity statement", { exact: true });
  await expect(text).toBeVisible();
  await rendered(page);

  const span = await text.elementHandle();
  const initialWidth = await span.evaluate((element) => {
    const node = element.firstChild!;
    window.getSelection()!.setBaseAndExtent(node, 0, node, node.textContent!.length);
    return element.getBoundingClientRect().width;
  });

  await reader.locator(".pdf-viewer").evaluate((viewer) => {
    viewer.style.width = `${Math.floor(viewer.clientWidth * 0.7)}px`;
  });
  await expect.poll(async () => (await text.boundingBox())?.width ?? initialWidth).toBeLessThan(initialWidth * 0.9);
  expect(await text.evaluate((element, original) => {
    const selection = window.getSelection()!;
    return {
      sameSpan: element === original,
      anchorInSpan: selection.anchorNode === element.firstChild,
      focusInSpan: selection.focusNode === element.firstChild,
      text: selection.toString(),
    };
  }, span)).toEqual({ sameSpan: true, anchorInSpan: true, focusInSpan: true, text: "Electricity statement" });

  await reader.getByRole("button", { name: "Show page 3" }).click();
  await expect(reader.locator(".text-layer").getByText("Statement page 3")).toBeVisible();
  await expect(text).toHaveCount(0);
  expect(await span.evaluate((element) => element.isConnected)).toBe(false);
});

test("a pending PDF text render uses the latest viewport and is cleaned up when offscreen", async ({ page, context }) => {
  const pdf = { ...documentFixtures[0], media_type: "pdf" as const, page_count: 3 };
  await mockArchive(context, { documents: [pdf] });
  await page.goto(appUrl);

  const lifecycle = await page.evaluateHandle(async ({ modulePath, id }) => {
    const { acquirePdf, pdfPage } = await import(modulePath) as typeof import("../src/lib/pdf");
    const file = await acquirePdf(`/api/documents/${id}/file`, new AbortController().signal);
    const first = Promise.withResolvers<void>();
    const log = { renders: 0, updates: new Map<string, number>(), cancelled: [] as string[], finishFirst: first.resolve };
    try {
      await Promise.all([1, 2, 3].map((number) => pdfPage(file.document, number)));
      const prototype = file.module.TextLayer.prototype;
      const { render, update, cancel } = prototype;
      prototype.render = function () {
        const number = ++log.renders;
        const task = render.call(this);
        return number === 1 ? task.then(() => first.promise) : task;
      };
      prototype.update = function (options) {
        log.updates.set(this.textContentItemsStr[0], options.viewport.scale);
        update.call(this, options);
      };
      prototype.cancel = function () {
        log.cancelled.push(this.textContentItemsStr[0]);
        cancel.call(this);
      };
    } finally {
      file.release();
    }
    return log;
  }, { modulePath: "/src/lib/pdf.ts", id: pdf.document_id });

  await page.getByRole("button", { name: "Open Electricity statement" }).click();
  const reader = page.getByRole("dialog");
  const layer = reader.locator(".text-layer");
  const first = layer.getByText("Electricity statement", { exact: true });
  await expect(first).toHaveCount(1);
  await expect(first).toBeHidden();
  const firstSpan = await first.elementHandle();
  const width = 620;
  await reader.locator(".pdf-viewer").evaluate((viewer, width) => { viewer.style.width = `${width}px`; }, width);
  await expect.poll(() => reader.getByLabel("PDF page 1").evaluate((canvas) => canvas.style.width)).toBe(`${width}px`);
  expect(await lifecycle.evaluate(({ renders }) => renders)).toBe(1);
  await lifecycle.evaluate(({ finishFirst }) => finishFirst());
  await expect(first).toBeVisible();
  expect(await first.evaluate((element, original) => element === original, firstSpan)).toBe(true);
  expect(await lifecycle.evaluate(({ updates }) => updates.get("Electricity statement"))).toBeCloseTo(width / 600);

  await reader.getByRole("button", { name: "Show page 3" }).click();
  await expect(layer.getByText("Statement page 3", { exact: true })).toBeVisible();
  await expect(first).toHaveCount(0);
  expect(await lifecycle.evaluate(({ cancelled }) => cancelled)).toContain("Electricity statement");
});
