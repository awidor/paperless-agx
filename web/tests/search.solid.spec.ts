import type { Page } from "@playwright/test";
import { appUrl, expect, rendered, test } from "./fixtures/solid";
import { documentFixtures, event, installEventStream, mockArchive, passage, sendStream } from "./fixtures/solidApi";

test("exact search sends the unquoted text and outlines evidence without OffscreenCanvas", async ({ page, context, capture }) => {
  const requests: unknown[] = [];
  const document = documentFixtures[0];
  const response = Promise.withResolvers<void>();
  await mockArchive(context, { onExact: async (body) => {
    requests.push(body);
    await response.promise;
    return { items: [{ document, passages: [passage()] }] };
  } });
  await page.addInitScript(() => Object.defineProperty(window, "OffscreenCanvas", { value: undefined, configurable: true }));
  await page.goto(appUrl);
  await expect(page.locator(".sheet-card")).toHaveCount(documentFixtures.length);
  const search = page.getByRole("searchbox");
  await search.fill('"30.09.2026"');
  await rendered(page);
  try {
    await capture("exact search submit", async () => {
      await search.press("Enter");
      await expect(page.getByText("Looking for “30.09.2026” as written")).toBeVisible();
      await expect(page).toHaveURL(/q=%2230.09.2026%22/);
    });

    await capture("exact search result", async () => {
      response.resolve();
      await expect(page.getByText(/1 document contains/)).toBeVisible();
      await expect(page.locator(".source .paper .doc-image")).toBeVisible();
      await expect(page.locator(".source .paper .evidence-mark")).toBeVisible();
      await rendered(page);
    });
  } finally {
    response.resolve();
  }
  expect(requests).toEqual([expect.objectContaining({ query: "30.09.2026", exact: true })]);

  await capture("exact search clear", async () => {
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
  });
  await capture("exact search history", async () => {
    await page.goBack();
    await expect(page.getByText(/1 document contains/)).toBeVisible();
    await expect(page.locator(".source .paper .evidence-mark")).toBeVisible();
  });
});

async function nearStripsReady(page: Page) {
  // Source entrances move the figures across the evidence observer's preload margin.
  await page.locator(".results .source").evaluateAll(async (sources) => {
    await Promise.allSettled(sources.flatMap((source) => source.getAnimations().map((animation) => animation.finished)));
  });
  await rendered(page);
  await page.waitForFunction(() => Array.from(document.querySelectorAll(".source__paper:has(.paper--loading)")).every((strip) => {
    const rect = strip.getBoundingClientRect();
    return rect.top > innerHeight + 200 || rect.bottom < -200;
  }));
}

test("streams agent lookups and highlights one citation in the worker-backed results", async ({ page, context, capture }) => {
  const archive = await mockArchive(context);
  await installEventStream(page, "/api/search/agent");
  const workers: string[] = [];
  page.on("worker", (worker) => workers.push(worker.url()));
  await page.goto(appUrl);
  await expect(page.locator(".sheet-card")).toHaveCount(documentFixtures.length);
  const search = page.getByRole("searchbox");
  await search.fill("When is the statement due?");
  await rendered(page);

  await capture("agent search submit", async () => {
    await search.press("Enter");
    await expect(page.getByText("Starting the search")).toBeVisible();
    await page.waitForFunction(() => window.testStreams.length === 1);
  });

  const first = event("progress", { kind: "search", label: "Finding statements" }).replaceAll("\n", "\r\n");
  await capture("agent first lookup", async () => {
    const split = Math.floor(first.length / 2);
    await sendStream(page, first.slice(0, split));
    await sendStream(page, first.slice(split));
    await expect(page.locator(".trail summary")).toContainText("Finding statements");
  });

  const steps = page.locator(".trail__steps li");
  await capture("agent open trail", async () => {
    await page.locator(".trail summary").click();
    await expect(steps).toHaveText(["Finding statements"]);
  });

  await capture("agent append lookups", async () => {
    const firstStep = await steps.first().elementHandle();
    await sendStream(page, event("progress", { kind: "read", label: "Reading the due date" })
      + event("progress", { kind: "read", label: "Checking the second result" }));
    await expect(steps).toHaveText(["Finding statements", "Reading the due date", "Checking the second result"]);
    expect(await steps.first().evaluate((node, original) => node === original, firstStep)).toBe(true);
    await firstStep?.dispose();
  });

  await capture("agent search result", async () => {
    await sendStream(page, event("result", {
      answer: "The payment is due on 30.09.2026.",
      citations: [0],
      results: documentFixtures.map((document) => ({ document, reason: "Due on 30.09.2026", passage: passage() })),
    }), true);
    await expect(page.locator(".answer__text")).toContainText("The payment is due on 30.09.2026.");
    await expect(page.locator(".trail[open]")).toBeVisible();
    await expect(page.locator(".source .paper .evidence-mark").first()).toBeVisible();
    await nearStripsReady(page);
    expect(workers.some((url) => url.includes("paperCrop.worker.ts"))).toBe(true);
  });

  const citation = page.getByRole("button", { name: /Source 1: open Electricity statement/ });
  await expect(citation).toBeInViewport();
  await capture("citation hover", async () => {
    await citation.hover();
    await expect(citation).toHaveClass(/is-hinted/);
    await expect(page.locator(".source.is-hinted .source__title")).toContainText("Electricity statement");
    await expect(page.locator(".source.is-hinted")).toHaveCount(1);
  });
  expect(archive.imageRequests.filter((documentId) => documentId === documentFixtures[0].document_id)).toHaveLength(1);
  expect(archive.imageRequests).not.toContain(documentFixtures.at(-1)!.document_id);
  const last = page.getByRole("button", { name: "Open Heating service report at page 1" });
  await capture("agent scroll evidence", async () => {
    await last.scrollIntoViewIfNeeded();
    await expect(last.locator("..").locator(".paper .doc-image")).toBeVisible();
    await nearStripsReady(page);
  });
});

test("replacing and clearing a query cancel the active agent stream", async ({ page, context, capture }) => {
  await mockArchive(context);
  await installEventStream(page, "/api/search/agent");
  await page.goto(appUrl);
  const search = page.getByRole("searchbox");
  await search.fill("First query");
  await search.press("Enter");
  await page.waitForFunction(() => window.testStreams.length === 1);
  await sendStream(page, event("progress", { kind: "search", label: "Looking for the first query" }));
  await expect(page.locator(".trail__current")).toHaveText("Looking for the first query");
  await search.fill("Replacement query");

  await capture("agent replace query", async () => {
    await search.press("Enter");
    await page.waitForFunction(() => window.testStreams.length === 2 && window.testStreams[0].signal?.aborted);
    await expect(page.getByText("Starting the search")).toBeVisible();
    await expect(page.locator(".trail__steps li")).toHaveCount(0);
  });

  await capture("agent clear query", async () => {
    await page.getByRole("button", { name: "Clear search" }).click();
    await page.waitForFunction(() => window.testStreams[1].signal?.aborted);
    await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
  });
});

test("the Reader leases the PDF already opened by the evidence crop", async ({ page, context, capture }) => {
  const pdf = { ...documentFixtures[0], media_type: "pdf" as const, filename: "statement.pdf" };
  const archive = await mockArchive(context, {
    documents: [pdf],
    onExact: () => ({ items: [{ document: pdf, passages: [passage()] }] }),
  });
  await page.goto(`${appUrl}/?q=%22Electricity+statement%22`);
  await expect(page.locator(".source .paper .doc-image")).toBeVisible();
  expect(archive.pdfRequests).toEqual([pdf.document_id]);

  await capture("reader from PDF evidence", async () => {
    await page.getByRole("button", { name: "Open Electricity statement at page 1" }).click();
    await expect(page.locator(".text-layer").getByText("Electricity statement")).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Electricity statement" })).toBeVisible();
  });
  expect(archive.pdfRequests).toEqual([pdf.document_id]);
});
