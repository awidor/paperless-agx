/// <reference lib="webworker" />
import { createInkCache, cutPaper, readPageInk, type CropRequest, type CropResponse, type CropSource } from "../paperCrop";

const scope = self as DedicatedWorkerGlobalScope;
const cache = createInkCache();

async function prepare(source: CropSource, signal: AbortSignal) {
  const cached = cache.get(source.key);
  if (cached) return { page: cached };

  let blob: Blob;
  try {
    const response = await fetch(source.url, { signal });
    if (!response.ok) return null;
    blob = await response.blob();
  } catch {
    return null;
  }

  try {
    if (signal.aborted) return null;
    const bitmap = await createImageBitmap(blob);
    try {
      if (signal.aborted) return null;
      const page = readPageInk(blob, bitmap, bitmap.width, bitmap.height, new OffscreenCanvas(1, 1));
      if (!page.ink) return { blob };
      cache.set(source.key, page);
      return { page };
    } finally {
      bitmap.close();
    }
  } catch {
    return { blob };
  }
}

const jobs = new Map<number, { controller: AbortController; image: ReturnType<typeof prepare> }>();
function send(message: CropResponse) { scope.postMessage(message); }

scope.onmessage = async (event: MessageEvent<CropRequest>) => {
  const request = event.data;
  const { id } = request;
  if (request.type === "prepare") {
    const controller = new AbortController();
    jobs.set(id, { controller, image: prepare(request.source, controller.signal) });
    return;
  }
  const job = jobs.get(id);
  if (!job) return;
  if (request.type === "cancel") {
    job.controller.abort();
    jobs.delete(id);
    return;
  }
  try {
    const prepared = await job.image;
    if (job.controller.signal.aborted) return;
    if (prepared?.blob) send({ id, type: "fallback", blob: prepared.blob });
    else send({ id, type: "crop", crop: prepared ? cutPaper(prepared.page, request.geometry, request.shape) : null });
  } catch {
    if (!job.controller.signal.aborted) send({ id, type: "fallback" });
  } finally {
    jobs.delete(id);
  }
};
