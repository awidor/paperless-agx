import type { CSSProperties } from "react";
import type { OcrBlock } from "./api";

type PositionedStyle = CSSProperties & {
  "--ocr-font-size": string;
};

function blockStyle(block: OcrBlock): PositionedStyle {
  const [x0, y0, x1, y1] = block.bbox;
  const width = Math.max(1, x1 - x0);
  const height = Math.max(1, y1 - y0);
  const charactersPerLine = Math.max(8, Math.floor(width / 8));
  const lines = block.text.split("\n").reduce(
    (count, line) => count + Math.max(1, Math.ceil(line.length / charactersPerLine)),
    0,
  );
  const fontSize = Math.max(0.55, Math.min(3.2, (height / 10 / lines) * 0.78));
  return {
    left: `${x0 / 10}%`,
    top: `${y0 / 10}%`,
    width: `${width / 10}%`,
    height: `${height / 10}%`,
    "--ocr-font-size": `${fontSize}cqh`,
  };
}

export function OcrTextLayer({ blocks }: { blocks: OcrBlock[] }) {
  if (blocks.length === 0) return null;
  return (
    <div className="ocr-text-layer" aria-label="Selectable OCR text">
      {blocks.map((block, index) => (
        <span
          className="ocr-positioned-block"
          data-label={block.label}
          key={`${block.bbox.join("-")}-${index}`}
          style={blockStyle(block)}
        >
          {block.text}
        </span>
      ))}
    </div>
  );
}
