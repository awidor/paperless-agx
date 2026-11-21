import { frameEvidence, type Box, type Frame, type FrameShape, type Ink } from "./evidenceHighlight";

export type CropSource = { key: string; url: string };
export type CropGeometry = { groups: Box[][]; boxes: Box[] };
type PageInk = { blob: Blob; aspect: number; ink?: Ink };
export type Crop = { blob: Blob; pageAspect: number; frame: Frame };
export type CropRequest =
  | { type: "prepare"; id: number; source: CropSource }
  | { type: "frame"; id: number; geometry: CropGeometry; shape: FrameShape }
  | { type: "cancel"; id: number };
export type CropResponse = { id: number } & (
  | { type: "crop"; crop: Crop | null }
  | { type: "fallback"; blob?: Blob }
);

const MAX_PAGES = 24;
const MAX_BYTES = 24 * 1024 * 1024;
const MAX_INK_PIXELS = 1_000_000;
const INK_WIDTH = 800;

export function createInkCache() {
  const pages = new Map<string, PageInk>();
  const bytesOf = (page: PageInk) => page.blob.size + (page.ink?.data.byteLength ?? 0);
  let bytes = 0;
  return {
    get(key: string) {
      const page = pages.get(key);
      if (page) {
        pages.delete(key);
        pages.set(key, page);
      }
      return page;
    },
    set(key: string, page: PageInk) {
      const size = bytesOf(page);
      if (size > MAX_BYTES || pages.has(key)) return;
      while (pages.size >= MAX_PAGES || bytes + size > MAX_BYTES) {
        const oldest = pages.entries().next().value;
        if (!oldest) break;
        bytes -= bytesOf(oldest[1]);
        pages.delete(oldest[0]);
      }
      pages.set(key, page);
      bytes += size;
    },
    clear() {
      pages.clear();
      bytes = 0;
    },
  };
}

/** Downsample the page to an 8-bit darkness map, with a pixel cap for unusually tall pages. */
export function readPageInk(
  blob: Blob,
  image: CanvasImageSource,
  naturalWidth: number,
  naturalHeight: number,
  surface: HTMLCanvasElement | OffscreenCanvas,
): PageInk {
  const aspect = naturalWidth / naturalHeight;
  const width = Math.max(1, Math.floor(Math.min(INK_WIDTH, Math.sqrt(MAX_INK_PIXELS * aspect))));
  const height = Math.max(1, Math.min(Math.floor(MAX_INK_PIXELS / width), Math.round(width / aspect)));
  surface.width = width;
  surface.height = height;
  const context = surface.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!context) return { blob, aspect };
  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data;
  const data = new Uint8Array(width * height);
  for (let index = 0, at = 0; index < data.length; index += 1, at += 4) {
    data[index] = 255 - Math.round(0.299 * pixels[at] + 0.587 * pixels[at + 1] + 0.114 * pixels[at + 2]);
  }
  return { blob, aspect, ink: { width, height, data } };
}

export function cutPaper(page: PageInk, geometry: CropGeometry, shape: FrameShape): Crop {
  return {
    blob: page.blob,
    pageAspect: page.aspect,
    frame: frameEvidence(geometry.groups, geometry.boxes, page.aspect, shape, page.ink),
  };
}
