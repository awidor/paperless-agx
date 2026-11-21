import { appUrl, expect, test } from "./fixtures/solid";
import { documentFixtures, mockArchive } from "./fixtures/solidApi";

const pdfModule = "/src/lib/pdf.ts";

declare global {
  interface Window { pdfPageLog: { painted: number[]; cleaned: number[] } }
}

test("turning and closing the Reader clean inactive PDF pages while keeping the file cached", async ({ page, context }) => {
  const pdf = { ...documentFixtures[0], media_type: "pdf" as const, page_count: 3 };
  const archive = await mockArchive(context, { documents: [pdf] });
  await page.goto(appUrl);
  const opener = page.getByRole("button", { name: "Open Electricity statement" });
  await expect(opener).toBeVisible();

  await page.evaluate(async ({ pdfModule, id }) => {
    const { acquirePdf, pdfPage } = await import(pdfModule) as typeof import("../src/lib/pdf");
    const file = await acquirePdf(`/api/documents/${id}/file`, new AbortController().signal);
    const log = window.pdfPageLog = { painted: [], cleaned: [] } as Window["pdfPageLog"];
    try {
      for (const number of [1, 2, 3]) {
        const proxy = await pdfPage(file.document, number);
        const render = proxy.render.bind(proxy);
        const cleanup = proxy.cleanup.bind(proxy);
        proxy.render = (params) => {
          const task = render(params);
          void task.promise.then(() => log.painted.push(number), () => {});
          return task;
        };
        proxy.cleanup = (resetStats) => {
          const cleared = cleanup(resetStats);
          if (cleared) log.cleaned.push(number);
          return cleared;
        };
      }
    } finally {
      file.release();
    }
  }, { pdfModule, id: pdf.document_id });

  const painted = () => page.evaluate(() => window.pdfPageLog.painted);
  const cleaned = () => page.evaluate(() => [...new Set(window.pdfPageLog.cleaned)].sort());
  const reader = page.getByRole("dialog");
  await opener.click();
  await expect.poll(painted).toContain(1);
  expect(await cleaned()).toEqual([]);

  for (const number of [2, 3]) {
    await reader.getByRole("button", { name: "Next page" }).click();
    await expect(reader.locator(".text-layer").getByText(`Statement page ${number}`)).toBeVisible();
    await expect.poll(painted).toContain(number);
    await expect.poll(cleaned).toEqual(Array.from({ length: number - 1 }, (_, index) => index + 1));
  }

  await reader.getByRole("button", { name: "Close", exact: true }).click();
  await expect(reader).toBeHidden();
  await expect.poll(cleaned).toEqual([1, 2, 3]);
  const firstPaints = (await painted()).filter((number) => number === 1).length;
  await opener.click();
  await expect(reader.locator(".text-layer").getByText("Electricity statement")).toBeVisible();
  await expect.poll(async () => (await painted()).filter((number) => number === 1).length).toBeGreaterThan(firstPaints);
  expect(archive.pdfRequests).toEqual([pdf.document_id]);
});

test("eviction and close honor concurrent PDF render and crop work", async ({ page, context }) => {
  const documents = Array.from({ length: 6 }, (_, index) => ({
    ...documentFixtures[0], document_id: 101 + index, media_type: "pdf" as const,
  }));
  const archive = await mockArchive(context, { documents });
  await page.goto(appUrl);

  const result = await page.evaluate(async ({ pdfModule, ids }) => {
    const { acquirePdf, pdfPage, pdfText, renderPdfPage } = await import(pdfModule) as typeof import("../src/lib/pdf");
    const acquire = (id: number, controller = new AbortController()) => acquirePdf(`/api/documents/${id}/file`, controller.signal);
    const retained = await Promise.all(ids.slice(0, 4).map((id) => acquire(id)));
    const viewController = new AbortController();
    const cropController = new AbortController();
    const [view, crop] = await Promise.all([acquire(ids[4], viewController), acquire(ids[4], cropController)]);
    const shared = view.document === crop.document;
    const task = view.document.loadingTask;
    const proxy = await pdfPage(view.document, 1);
    const renderStarted = Promise.withResolvers<void>();
    const textGate = Promise.withResolvers<void>();
    const log: string[] = [];
    let started = 0;

    const render = proxy.render.bind(proxy);
    proxy.render = (params) => {
      const paint = render(params);
      paint.onContinue = () => { if (++started === 2) renderStarted.resolve(); };
      void paint.promise.then(() => log.push("painted"), () => log.push("cancelled"));
      return paint;
    };
    const cleanup = proxy.cleanup.bind(proxy);
    proxy.cleanup = (resetStats) => {
      log.push("cleanup");
      return cleanup(resetStats);
    };
    const getText = proxy.getTextContent.bind(proxy);
    proxy.getTextContent = async (params) => {
      await textGate.promise;
      return getText(params);
    };

    const viewport = proxy.getViewport({ scale: 1 });
    function startPaint() {
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      return renderPdfPage(view, proxy, { canvas, viewport });
    }
    const paint = startPaint();
    const secondPaint = startPaint();
    const text = pdfText(crop, proxy);
    await renderStarted.promise;
    viewController.abort();
    paint.release();
    await paint.promise.catch(() => {});
    const retainedDuringSecondPaint = !log.includes("cleanup");
    secondPaint.release();
    await secondPaint.promise.catch(() => {});
    const cleanedAfterRendering = log.indexOf("cleanup") > log.lastIndexOf("cancelled");
    const openForCrop = !task.destroyed;

    cropController.abort();
    const openUntilTextSettles = !task.destroyed;
    textGate.resolve();
    const extracted = (await text).runs.map((run) => run.text);
    const overflowClosed = task.destroyed;

    retained[1].release();
    const replacement = await acquire(ids[5]);
    const evictedIdleOnly = retained[1].document.loadingTask.destroyed
      && retained.filter((_, index) => index !== 1).every((file) => !file.document.loadingTask.destroyed);
    for (const file of retained) file.release();
    replacement.release();

    return { shared, openForCrop, retainedDuringSecondPaint, cleanedAfterRendering, openUntilTextSettles, overflowClosed, evictedIdleOnly, extracted };
  }, { pdfModule, ids: documents.map(({ document_id }) => document_id) });

  expect(result).toEqual({
    shared: true, openForCrop: true, retainedDuringSecondPaint: true, cleanedAfterRendering: true,
    openUntilTextSettles: true, overflowClosed: true, evictedIdleOnly: true,
    extracted: expect.arrayContaining(["Electricity statement"]),
  });
  expect(archive.pdfRequests.filter((id) => id === documents[4].document_id)).toHaveLength(1);
});
