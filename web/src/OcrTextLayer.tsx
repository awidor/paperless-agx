import { useEffect, useRef, useState } from "react";
import type { OcrBlock } from "./api";
import { bindPageTextSelection } from "./pageTextSelection";

const LINE_HEIGHT = 1.15;
const FONT = '"Archivo Variable", Archivo, sans-serif';
const SAMPLE = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789,.-";

let advance = 0;

/** Average character advance of the overlay font, as a fraction of the font size. */
function advanceRatio(): number {
  if (advance > 0) return advance;
  const context = window.document.createElement("canvas").getContext("2d");
  if (!context) return 0.5;
  context.font = `400 100px ${FONT}`;
  advance = context.measureText(SAMPLE).width / SAMPLE.length / 100;
  return advance;
}

/**
 * Fits a block of collapsed OCR text into its bounding box. Wrapped text of
 * `characters` glyphs needs `characters * ratio * size` of advance and
 * `lines * size * LINE_HEIGHT` of height, so the box area gives the size
 * directly. The box height caps the result for single-line blocks.
 */
function fontSize(block: OcrBlock, boxWidth: number, boxHeight: number): number {
  const [x0, y0, x1, y1] = block.bbox;
  const width = (Math.max(1, x1 - x0) / 1000) * boxWidth;
  const height = (Math.max(1, y1 - y0) / 1000) * boxHeight;
  const characters = Math.max(1, block.text.length);
  const area = Math.sqrt((width * height) / (characters * advanceRatio() * LINE_HEIGHT));
  return Math.max(4, Math.min(area, height / LINE_HEIGHT, 96));
}

export function OcrTextLayer({ blocks }: { blocks: OcrBlock[] }) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    return bindPageTextSelection(layer);
  }, []);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width < 1 || rect.height < 1) return;
      setBox((current) =>
        current && Math.abs(current.width - rect.width) < 2 && Math.abs(current.height - rect.height) < 2
          ? current
          : { width: rect.width, height: rect.height },
      );
    });
    observer.observe(layer);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="ocr-text-layer" ref={layerRef} aria-label="Selectable OCR text">
      {box && blocks.map((block, index) => (
        <span
          className="ocr-positioned-block"
          data-label={block.label}
          key={`${block.bbox.join("-")}-${index}`}
          style={{
            left: `${block.bbox[0] / 10}%`,
            top: `${block.bbox[1] / 10}%`,
            width: `${Math.max(1, block.bbox[2] - block.bbox[0]) / 10}%`,
            height: `${Math.max(1, block.bbox[3] - block.bbox[1]) / 10}%`,
            fontSize: `${fontSize(block, box.width, box.height).toFixed(2)}px`,
          }}
        >
          {block.text}
        </span>
      ))}
    </div>
  );
}
