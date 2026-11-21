import { createInkCache, cutPaper, readPageInk, type Crop, type CropGeometry, type CropRequest, type CropResponse, type CropSource } from "./paperCrop";
import type { FrameShape } from "./evidenceHighlight";

export function createCropClient() {
  const cache = createInkCache();
  const jobs = new Map<number, (response: CropResponse) => void>();
  let nextId = 0;
  let worker: Worker | null | undefined;

  function dispose() {
    worker?.terminate();
    worker = null;
    for (const [id, reply] of jobs) reply({ id, type: "fallback" });
    jobs.clear();
    cache.clear();
  }

  function getWorker() {
    if (worker !== undefined) return worker;
    if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") return worker = null;
    try {
      worker = new Worker(new URL("./workers/paperCrop.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = ({ data }: MessageEvent<CropResponse>) => jobs.get(data.id)?.(data);
      worker.onerror = (event) => {
        event.preventDefault();
        dispose();
      };
    } catch {
      worker = null;
    }
    return worker;
  }

  async function prepareInBrowser(source: CropSource, signal: AbortSignal, received?: Blob) {
    const cached = cache.get(source.key);
    if (cached) return cached;

    try {
      let blob = received;
      if (!blob) {
        const response = await fetch(source.url, { signal });
        if (!response.ok) return null;
        blob = await response.blob();
      }
      signal.throwIfAborted();
      const image = new Image();
      const url = URL.createObjectURL(blob);
      const stop = () => { image.removeAttribute("src"); };
      signal.addEventListener("abort", stop, { once: true });
      try {
        image.src = url;
        await image.decode();
        signal.throwIfAborted();
        const page = readPageInk(blob, image, image.naturalWidth, image.naturalHeight, document.createElement("canvas"));
        cache.set(source.key, page);
        return page;
      } finally {
        signal.removeEventListener("abort", stop);
        URL.revokeObjectURL(url);
      }
    } catch {
      return null;
    }
  }

  async function crop(source: CropSource, shape: FrameShape, geometry: Promise<CropGeometry>, signal: AbortSignal): Promise<Crop | null> {
    const active = getWorker();
    if (!active) {
      const [page, data] = await Promise.all([prepareInBrowser(source, signal), geometry]);
      return page ? cutPaper(page, data, shape) : null;
    }

    const id = ++nextId;
    const send = (message: CropRequest) => active.postMessage(message);
    const response = new Promise<CropResponse>((resolve) => jobs.set(id, resolve));
    const cancel = () => {
      if (worker === active) send({ type: "cancel", id });
      jobs.get(id)?.({ id, type: "crop", crop: null });
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      send({ type: "prepare", id, source });
      const data = await geometry;
      if (signal.aborted) return null;
      if (worker === active) send({ type: "frame", id, geometry: data, shape });
      const result = await response;
      if (result.type === "crop") return result.crop;
      if (signal.aborted) return null;
      const page = await prepareInBrowser(source, signal, result.blob);
      return page ? cutPaper(page, data, shape) : null;
    } finally {
      cancel();
      signal.removeEventListener("abort", cancel);
      jobs.delete(id);
    }
  }

  return { crop, dispose };
}
