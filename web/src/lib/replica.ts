import { MIN_FONT_SIZE } from "./textFit";

const IMAGE_LABELS = new Set([
  "picture", "figure", "image", "logo", "photo", "icon", "stamp", "seal", "signature",
  "chart", "diagram", "drawing", "map", "graph", "barcode", "qrcode",
]);

const ALLOWED_TAGS = new Map([
  ["P", "p"], ["H1", "h1"], ["H2", "h2"], ["H3", "h3"], ["H4", "h4"], ["H5", "h5"], ["H6", "h6"],
  ["UL", "ul"], ["OL", "ol"], ["LI", "li"], ["TABLE", "table"], ["THEAD", "thead"], ["TBODY", "tbody"],
  ["TR", "tr"], ["TD", "td"], ["TH", "th"], ["CAPTION", "caption"], ["STRONG", "strong"], ["B", "strong"],
  ["EM", "em"], ["I", "em"], ["U", "u"], ["SUP", "sup"], ["SUB", "sub"], ["CODE", "code"], ["PRE", "pre"],
  ["BLOCKQUOTE", "blockquote"], ["BR", "br"], ["HR", "hr"], ["SPAN", "span"], ["DIV", "div"],
]);

const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "FORM", "BUTTON", "TEXTAREA", "SELECT", "AUDIO",
  "VIDEO", "CANVAS", "SVG", "MATH", "IMG", "LINK", "META", "TEMPLATE", "NOSCRIPT",
]);

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
type Bounds = [number, number, number, number];

export type ReplicaBlock = {
  label: string;
  bbox: Bounds;
  text: string;
  content: DocumentFragment | string;
};

function parseBbox(value: string | null): Bounds | null {
  if (!value) return null;
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return null;
  const [x0, y0, x1, y1] = parts.map((part) => Math.min(1000, Math.max(0, part)));
  return x1 - x0 >= 1 && y1 - y0 >= 1 ? [x0, y0, x1, y1] : null;
}

function skip(element: Element): boolean {
  return element.namespaceURI !== HTML_NAMESPACE || SKIP_TAGS.has(element.tagName);
}

function copySpan(source: Element, target: HTMLElement, attribute: "colspan" | "rowspan", max: number) {
  const value = source.getAttribute(attribute)?.trim();
  if (!value || !/^\d+$/.test(value)) return;
  const number = Number(value);
  if (Number.isSafeInteger(number) && number > 1 && number <= max) target.setAttribute(attribute, String(number));
}

function appendSanitized(source: Element, parent: DocumentFragment | HTMLElement, target: Document) {
  for (const node of source.childNodes) {
    if (node.nodeType === 3) {
      parent.append(target.createTextNode(node.textContent ?? ""));
      continue;
    }
    if (node.nodeType !== 1) continue;
    const child = node as Element;
    if (skip(child)) continue;
    if (child.tagName === "INPUT") {
      if (child.getAttribute("type")?.toLowerCase() !== "checkbox") continue;
      const checkbox = target.createElement("span");
      checkbox.className = child.hasAttribute("checked") ? "digital-checkbox checked" : "digital-checkbox";
      checkbox.setAttribute("aria-hidden", "true");
      parent.append(checkbox);
      continue;
    }

    const tag = ALLOWED_TAGS.get(child.tagName);
    if (!tag) {
      appendSanitized(child, parent, target);
      continue;
    }
    const element = target.createElement(tag);
    if (tag === "td" || tag === "th") {
      copySpan(child, element, "colspan", 1_000);
      copySpan(child, element, "rowspan", 65_534);
    }
    appendSanitized(child, element, target);
    parent.append(element);
  }
}

export function buildSanitizedFragment(element: Element, target = document): DocumentFragment {
  const fragment = target.createDocumentFragment();
  if (!skip(element)) appendSanitized(element, fragment, target);
  return fragment;
}

/** Parse in an inert template and collect the outermost positioned blocks. */
export function parseReplicaBlocks(html: string, target = document): ReplicaBlock[] {
  const template = target.createElement("template");
  template.innerHTML = html;
  const blocks: ReplicaBlock[] = [];

  function visit(parent: DocumentFragment | Element) {
    for (const element of parent.children) {
      if (skip(element)) continue;
      if (!element.hasAttribute("data-bbox")) {
        visit(element);
        continue;
      }
      const bbox = parseBbox(element.getAttribute("data-bbox"));
      if (!bbox) continue;
      const content = buildSanitizedFragment(element, target);
      blocks.push({
        label: element.getAttribute("data-label")?.trim() || "Text",
        bbox,
        text: content.textContent ?? "",
        content,
      });
    }
  }

  visit(template.content);
  return blocks;
}

export function isImageBlock(block: ReplicaBlock): boolean {
  // Checkbox-only blocks still have selectable replica markup.
  return IMAGE_LABELS.has(block.label.toLowerCase())
    || (!block.text.trim() && (typeof block.content === "string" || !block.content.querySelector(".digital-checkbox, hr")));
}

export function blockStyle([x0, y0, x1, y1]: Bounds) {
  return {
    left: `${x0 / 10}%`,
    top: `${y0 / 10}%`,
    width: `${(x1 - x0) / 10}%`,
    height: `${(y1 - y0) / 10}%`,
  };
}

/** One initial measurement and six binary-search measurements for the entire page. */
export function fitTextBlocks(entries: { element: HTMLElement; size: number }[]) {
  const fits = (element: HTMLElement) => element.scrollHeight <= element.clientHeight + 1
    && element.scrollWidth <= element.clientWidth + 1;

  for (const { element, size } of entries) element.style.fontSize = `${size}px`;
  const overflowing = entries.filter(({ element, size }) => size > MIN_FONT_SIZE && !fits(element))
    .map(({ element, size }) => ({ element, low: MIN_FONT_SIZE, high: size, mid: size }));

  for (let pass = 0; pass < 6 && overflowing.length; pass += 1) {
    for (const block of overflowing) {
      block.mid = (block.low + block.high) / 2;
      block.element.style.fontSize = `${block.mid}px`;
    }
    for (const block of overflowing) {
      if (fits(block.element)) block.low = block.mid;
      else block.high = block.mid;
    }
  }
  for (const { element, low } of overflowing) element.style.fontSize = `${low}px`;
}
