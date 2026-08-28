const HIGHLIGHT = "#3a5c82";

/**
 * Keeps drag selection sane inside an absolutely positioned page text layer,
 * and paints the selection highlight.
 *
 * Two problems come with page text layers:
 *
 * 1. Spans sit at page coordinates, so DOM order and visual order disagree.
 *    A drag across a blank gap extends along DOM order and grabs far more text
 *    than the user aimed at. A filler element ("end of content", the trick the
 *    pdf.js viewer uses) covers the layer during a drag and sits next to the
 *    moving edge, so the browser extends along the filler instead.
 *
 *    The filler is only allowed to cover the layer while a pointer is down. It
 *    is `user-select: none`, so a pointer press that lands on an expanded
 *    filler starts no selection at all. Gating on the pointer keeps it
 *    collapsed whenever a press can begin, which no selection state can undo.
 *
 * 2. Span boxes overlap by a few pixels, and a translucent `::selection`
 *    background blends once per box, so overlaps came out visibly darker.
 *    Native selection painting stays off; every selected rectangle is filled
 *    opaque into one canvas, and the canvas carries the opacity. Coverage is
 *    therefore uniform. The rectangles come from the selection clamped to each
 *    text span, so they follow the glyphs the browser selected at any font
 *    size and never include the box of an element the selection spans.
 */
export function bindPageTextSelection(layer: HTMLElement): () => void {
  const controller = new AbortController();
  const { signal } = controller;
  // Firefox resolves the moving edge itself; moving the filler there breaks it.
  const firefox = "MozUserSelect" in layer.style;
  const filler = element("div", "end-of-content");
  // The canvas sits beside the layer, never inside it: an element box inside a
  // selection range contributes its own rectangle, and a full-layer element
  // would paint the whole page.
  const highlight = element("canvas", "selection-highlight") as HTMLCanvasElement;
  layer.append(filler);
  (layer.parentElement ?? layer).append(highlight);
  let pointerDown = false;
  let previous: Range | null = null;
  let frame = 0;

  function element(tag: string, className: string): HTMLElement {
    const node = window.document.createElement(tag);
    node.className = className;
    return node;
  }

  /** Collapses the filler, so no press can land on it. */
  function collapse() {
    layer.append(filler);
    filler.style.width = "";
    filler.style.height = "";
    layer.classList.remove("selecting");
  }

  /** Element holding the moving edge of the selection, if it is in this layer. */
  function edgeElement(range: Range, modifyStart: boolean): HTMLElement | null {
    let node: Node | null = modifyStart ? range.startContainer : range.endContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
    if (!modifyStart && range.endOffset === 0) {
      // The edge sits before the container: step back to the previous filled node.
      do {
        while (node && node !== layer && !node.previousSibling) node = node.parentNode;
        if (!node || node === layer) return null;
        node = node.previousSibling;
      } while (node && node.childNodes.length === 0);
    }
    const found = node instanceof HTMLElement ? node : null;
    return found && layer.contains(found) && found !== filler ? found : null;
  }

  /** Part of `range` that falls inside `limit`, or null when they are disjoint. */
  function clamp(range: Range, limit: Range): Range | null {
    if (range.compareBoundaryPoints(Range.START_TO_END, limit) <= 0) return null;
    if (range.compareBoundaryPoints(Range.END_TO_START, limit) >= 0) return null;
    const part = range.cloneRange();
    if (part.compareBoundaryPoints(Range.START_TO_START, limit) < 0) {
      part.setStart(limit.startContainer, limit.startOffset);
    }
    if (part.compareBoundaryPoints(Range.END_TO_END, limit) > 0) {
      part.setEnd(limit.endContainer, limit.endOffset);
    }
    return part;
  }

  function paint() {
    frame = 0;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.round(layer.clientWidth * ratio);
    const height = Math.round(layer.clientHeight * ratio);
    const context = highlight.getContext("2d");
    if (!context) return;
    if (highlight.width !== width || highlight.height !== height) {
      // Assigning the size also clears the canvas; a 10 MB buffer at retina
      // scale must not be reallocated on every selection change.
      highlight.width = width;
      highlight.height = height;
      highlight.style.width = `${layer.clientWidth}px`;
      highlight.style.height = `${layer.clientHeight}px`;
    } else {
      context.clearRect(0, 0, width, height);
    }
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;
    const origin = layer.getBoundingClientRect();
    const spanLimit = window.document.createRange();
    context.fillStyle = HIGHLIGHT;
    for (let index = 0; index < selection.rangeCount; index++) {
      const range = selection.getRangeAt(index);
      if (!range.intersectsNode(layer)) continue;
      const bounds = range.getBoundingClientRect();
      // Clamping to each span keeps the geometry on text. Rectangles taken
      // from the range as a whole would include the boxes of any element it
      // spans, and the expanded filler is one such box, the size of the page.
      for (const span of layer.querySelectorAll("span")) {
        const box = span.getBoundingClientRect();
        if (box.right < bounds.left || box.left > bounds.right) continue;
        if (box.bottom < bounds.top || box.top > bounds.bottom) continue;
        spanLimit.selectNodeContents(span);
        const part = clamp(range, spanLimit);
        if (!part) continue;
        for (const rect of part.getClientRects()) {
          if (rect.width < 0.5 || rect.height < 0.5) continue;
          // Round outwards so neighbouring lines leave no seam.
          const left = Math.floor((rect.left - origin.left) * ratio);
          const top = Math.floor((rect.top - origin.top) * ratio);
          const right = Math.ceil((rect.right - origin.left) * ratio);
          const bottom = Math.ceil((rect.bottom - origin.top) * ratio);
          context.fillRect(left, top, right - left, bottom - top);
        }
      }
    }
  }

  function schedule() {
    if (frame === 0) frame = window.requestAnimationFrame(paint);
  }

  function release() {
    pointerDown = false;
    collapse();
  }

  window.document.addEventListener("pointerdown", (event) => {
    // A press outside the layer drops the highlight with the selection.
    pointerDown = event.isPrimary;
    collapse();
  }, { capture: true, signal });
  window.document.addEventListener("pointerup", release, { signal });
  window.document.addEventListener("pointercancel", release, { signal });
  window.addEventListener("blur", release, { signal });
  window.document.addEventListener("keyup", () => {
    if (!pointerDown) collapse();
  }, { signal });

  window.document.addEventListener("selectionchange", () => {
    const selection = window.getSelection();
    const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (!range || !range.intersectsNode(layer)) {
      previous = null;
      collapse();
      schedule();
      return;
    }
    if (pointerDown && !firefox) {
      const modifyStart = previous !== null
        && (range.compareBoundaryPoints(Range.END_TO_END, previous) === 0
          || range.compareBoundaryPoints(Range.START_TO_END, previous) === 0);
      const edge = edgeElement(range, modifyStart);
      const parent = edge?.parentElement;
      if (edge && parent && layer.contains(parent)) {
        layer.classList.add("selecting");
        filler.style.width = `${layer.clientWidth}px`;
        filler.style.height = `${layer.clientHeight}px`;
        parent.insertBefore(filler, modifyStart ? edge : edge.nextSibling);
      }
      previous = range.cloneRange();
    }
    schedule();
  }, { signal });

  const observer = new ResizeObserver(schedule);
  observer.observe(layer);

  return () => {
    controller.abort();
    observer.disconnect();
    if (frame !== 0) window.cancelAnimationFrame(frame);
    previous = null;
    highlight.remove();
    filler.remove();
    layer.classList.remove("selecting");
  };
}
