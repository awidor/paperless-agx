import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PageInfo } from "./api";
import { matchesEvidence } from "./evidenceHighlight";
import { fitFontSize } from "./OcrTextLayer";

/** Labels whose payload is a graphic; rendered as crops of the page image. */
const IMAGE_LABELS = new Set([
  "picture",
  "figure",
  "image",
  "logo",
  "photo",
  "icon",
  "stamp",
  "seal",
  "signature",
  "chart",
  "diagram",
  "drawing",
  "map",
  "graph",
  "barcode",
  "qrcode",
]);

/** Tags kept from the OCR HTML; everything else is unwrapped or dropped. */
const ALLOWED_TAGS: Record<string, keyof React.JSX.IntrinsicElements> = {
  P: "p",
  H1: "h1",
  H2: "h2",
  H3: "h3",
  H4: "h4",
  H5: "h5",
  H6: "h6",
  UL: "ul",
  OL: "ol",
  LI: "li",
  TABLE: "table",
  THEAD: "thead",
  TBODY: "tbody",
  TR: "tr",
  TD: "td",
  TH: "th",
  CAPTION: "caption",
  STRONG: "strong",
  B: "strong",
  EM: "em",
  I: "em",
  U: "u",
  SUP: "sup",
  SUB: "sub",
  CODE: "code",
  PRE: "pre",
  BLOCKQUOTE: "blockquote",
  BR: "br",
  HR: "hr",
  SPAN: "span",
  DIV: "div",
};

/** Elements dropped with their contents. */
const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "FORM",
  "BUTTON",
  "TEXTAREA",
  "SELECT",
  "AUDIO",
  "VIDEO",
  "CANVAS",
  "SVG",
  "IMG",
  "LINK",
  "META",
]);

type ReplicaBlock = {
  label: string;
  bbox: [number, number, number, number];
  text: string;
  content: ReactNode;
};

function parseBbox(value: string | null): [number, number, number, number] | null {
  if (!value) return null;
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
  const [x0, y0, x1, y1] = parts.map((part) => Math.min(1000, Math.max(0, part)));
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return [x0, y0, x1, y1];
}

function childrenToReact(element: Element): ReactNode[] {
  return Array.from(element.childNodes).map((node, index) => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const child = node as Element;
    if (SKIP_TAGS.has(child.tagName)) return null;
    if (child.tagName === "INPUT") {
      const checked = child.hasAttribute("checked");
      return <span key={index} className={`digital-checkbox${checked ? " checked" : ""}`} aria-hidden="true" />;
    }
    const tag = ALLOWED_TAGS[child.tagName];
    if (!tag) return childrenToReact(child);
    if (tag === "br") return <br key={index} />;
    if (tag === "hr") return <hr key={index} />;
    const props: { colSpan?: number; rowSpan?: number } = {};
    if (tag === "td" || tag === "th") {
      const colSpan = Number(child.getAttribute("colspan"));
      const rowSpan = Number(child.getAttribute("rowspan"));
      if (Number.isInteger(colSpan) && colSpan > 1) props.colSpan = colSpan;
      if (Number.isInteger(rowSpan) && rowSpan > 1) props.rowSpan = rowSpan;
    }
    // The tag name comes from the static allowlist; children are sanitized recursively.
    const Tag = tag;
    return <Tag key={index} {...props}>{childrenToReact(child)}</Tag>;
  });
}

/** Top-level positioned OCR blocks, with sanitized inner markup. */
function parseReplicaBlocks(html: string): ReplicaBlock[] {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const positioned = Array.from(parsed.querySelectorAll("[data-bbox]")).filter(
    (element) => !element.parentElement?.closest("[data-bbox]"),
  );
  const blocks: ReplicaBlock[] = [];
  for (const element of positioned) {
    const bbox = parseBbox(element.getAttribute("data-bbox"));
    if (!bbox) continue;
    blocks.push({
      label: element.getAttribute("data-label")?.trim() || "Text",
      bbox,
      text: element.textContent ?? "",
      content: childrenToReact(element),
    });
  }
  return blocks;
}

function isImageBlock(block: ReplicaBlock): boolean {
  return IMAGE_LABELS.has(block.label.toLowerCase()) || block.text.trim() === "";
}

function blockStyle(bbox: [number, number, number, number]): React.CSSProperties {
  const [x0, y0, x1, y1] = bbox;
  return {
    left: `${x0 / 10}%`,
    top: `${y0 / 10}%`,
    width: `${(x1 - x0) / 10}%`,
    height: `${(y1 - y0) / 10}%`,
  };
}

const MIN_FONT_SIZE = 4;
const SHRINK_STEP = 0.93;
const SHRINK_LIMIT = 24;

/**
 * A positioned text block, shrunk to fit its box. The fitted size is only an
 * estimate from the character count, and markup the estimate cannot see —
 * forced breaks, list items, table rows — pushes the real content past the
 * box, where `overflow: hidden` would swallow it. So the rendered height is
 * measured and the font stepped down until the content is inside its box.
 */
function TextBlock({ block, fontSize, highlight }: { block: ReplicaBlock; fontSize: number; highlight?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const fit = () => {
      let size = fontSize;
      element.style.fontSize = `${size}px`;
      for (let step = 0; step < SHRINK_LIMIT && size > MIN_FONT_SIZE; step += 1) {
        if (element.scrollHeight <= element.clientHeight + 1 && element.scrollWidth <= element.clientWidth + 1) break;
        size = Math.max(MIN_FONT_SIZE, size * SHRINK_STEP);
        element.style.fontSize = `${size}px`;
      }
    };
    fit();
    let live = true;
    // The first pass may measure a fallback face; refit once the real one lands.
    window.document.fonts?.ready.then(() => live && fit());
    return () => {
      live = false;
    };
  }, [block, fontSize]);

  return (
    <div
      ref={ref}
      className={`digital-block digital-block--${block.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}${matchesEvidence(block.text, highlight) ? " evidence-match" : ""}`}
      data-label={block.label}
      style={{ ...blockStyle(block.bbox), fontSize: `${fontSize.toFixed(2)}px` }}
    >
      {block.content}
    </div>
  );
}

/**
 * Crops the page render to the block's box with pure percentage geometry: the
 * image is scaled up so it covers the whole sheet, then shifted so the block's
 * slice sits in the frame. Works at any sheet size without measuring pixels.
 */
function FigureCrop({ block, imageUrl }: { block: ReplicaBlock; imageUrl: string }) {
  const [x0, y0, x1, y1] = block.bbox;
  const width = x1 - x0;
  const height = y1 - y0;
  return (
    <div className="digital-figure" data-label={block.label} style={blockStyle(block.bbox)}>
      <img
        src={imageUrl}
        alt=""
        draggable={false}
        style={{
          width: `${100_000 / width}%`,
          height: `${100_000 / height}%`,
          left: `${(-100 * x0) / width}%`,
          top: `${(-100 * y0) / height}%`,
        }}
      />
    </div>
  );
}

/**
 * Renders an OCR'd page as a digital twin of the original: every block sits at
 * its page position with a font size fitted to its box, and graphic blocks show
 * the matching crop of the page render. Falls back to flat positioned blocks
 * for pages OCR'd before HTML was stored, and to plain text before layout data
 * exists at all.
 */
export function DigitalPage({ documentId, page, highlight }: { documentId: number; page: PageInfo | undefined; highlight?: string }) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  const [aspect, setAspect] = useState<{ width: number; height: number } | null>(null);
  const imageUrl = page ? `/api/documents/${documentId}/pages/${page.page}/image` : null;

  const blocks = useMemo<ReplicaBlock[]>(() => {
    if (!page) return [];
    if (page.html) {
      const parsed = parseReplicaBlocks(page.html);
      if (parsed.length > 0) return parsed;
    }
    return page.blocks.map((block) => ({
      label: block.label,
      bbox: [block.bbox[0] ?? 0, block.bbox[1] ?? 0, block.bbox[2] ?? 0, block.bbox[3] ?? 0],
      text: block.text,
      content: block.text,
    }));
  }, [page]);

  useEffect(() => {
    if (!imageUrl) return;
    setAspect(null);
    const image = new Image();
    image.onload = () => setAspect({ width: image.naturalWidth, height: image.naturalHeight });
    image.src = imageUrl;
    return () => {
      image.onload = null;
    };
  }, [imageUrl]);

  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width < 1 || rect.height < 1) return;
      setBox((current) =>
        current && Math.abs(current.width - rect.width) < 2 && Math.abs(current.height - rect.height) < 2
          ? current
          : { width: rect.width, height: rect.height },
      );
    });
    observer.observe(sheet);
    return () => observer.disconnect();
  }, [blocks.length]);

  if (!page || blocks.length === 0) {
    return <article className={`ocr-text${matchesEvidence(page?.text ?? "", highlight) ? " evidence-match" : ""}`}>{page?.text || "Text is not ready for this page."}</article>;
  }

  return (
    <div className="digital-page-wrap">
      <div
        ref={sheetRef}
        className="digital-page"
        style={{ aspectRatio: aspect ? `${aspect.width} / ${aspect.height}` : "210 / 297" }}
        aria-label={`Digital replica of page ${page.page}`}
      >
        {box && imageUrl && blocks.map((block, index) =>
          isImageBlock(block) ? (
            <FigureCrop key={`${block.bbox.join("-")}-${index}`} block={block} imageUrl={imageUrl} />
          ) : (
            <TextBlock
              key={`${block.bbox.join("-")}-${index}`}
              block={block}
              fontSize={fitFontSize(block.text, block.bbox, box.width, box.height)}
              highlight={highlight}
            />
          ),
        )}
      </div>
    </div>
  );
}
