import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import type { PageInfo } from "../../client/api";
import { markedRuns } from "../../lib/evidenceHighlight";
import { blockStyle, fitTextBlocks, isImageBlock, parseReplicaBlocks, type ReplicaBlock } from "../../lib/replica";
import { createFontMetrics, fitFontSize } from "../../lib/textFit";
import { createElementSize } from "../../primitives/createElementSize";
import { inkIn } from "../../primitives/motion";

function FigureCrop(props: { block: ReplicaBlock; url: string }) {
  const dimensions = () => {
    const [x0, y0, x1, y1] = props.block.bbox;
    return {
      width: `${100_000 / (x1 - x0)}%`, height: `${100_000 / (y1 - y0)}%`,
      left: `${(-100 * x0) / (x1 - x0)}%`, top: `${(-100 * y0) / (y1 - y0)}%`,
    };
  };
  return <div class="digital-figure" data-label={props.block.label} style={blockStyle(props.block.bbox)}>
    <img ref={inkIn} class="ink" src={props.url} alt="" draggable={false} style={dimensions()} />
  </div>;
}

type Props = { documentId: number; page?: PageInfo; marks?: string[] };

export function DigitalPage(props: Props) {
  const blocks = createMemo<ReplicaBlock[]>(() => {
    const page = props.page;
    if (!page) return [];
    if (page.html) {
      const parsed = parseReplicaBlocks(page.html);
      if (parsed.length) return parsed;
    }
    return page.blocks.map((block) => ({
      label: block.label,
      bbox: [block.bbox[0] ?? 0, block.bbox[1] ?? 0, block.bbox[2] ?? 0, block.bbox[3] ?? 0],
      text: block.text,
      content: block.text,
    }));
  }, { name: "replica blocks" });

  return <Show when={blocks().length > 0} fallback={
    <article class={["ocr-text", { "evidence-match": markedRuns([props.page?.text ?? ""], props.marks).size > 0 }]}>
      {props.page?.text || "Text is not ready for this page."}
    </article>
  }>
    <ReplicaSheet documentId={props.documentId} page={props.page?.page ?? 1} blocks={blocks()} marks={props.marks} />
  </Show>;
}

function ReplicaSheet(props: { documentId: number; page: number; blocks: ReplicaBlock[]; marks?: string[] }) {
  const { size, ref } = createElementSize();
  const font = createFontMetrics();
  const textNodes = new WeakMap<ReplicaBlock, HTMLElement>();
  let sheet!: HTMLDivElement;
  const [aspect, setAspect] = createSignal<{ url: string; ratio: string }>();
  const imageUrl = () => `/api/documents/${props.documentId}/pages/${props.page}/image`;
  const marked = createMemo(() => markedRuns(props.blocks.map((block) => block.text), props.marks), { name: "replica marks" });

  createEffect(imageUrl, (url) => {
    const image = new Image();
    image.onload = () => setAspect({ url, ratio: `${image.naturalWidth} / ${image.naturalHeight}` });
    image.src = url;
    return () => { image.onload = null; };
  }, { name: "replica aspect ratio" });

  createEffect(
    () => ({ dimensions: size(), font: font(), blocks: props.blocks }),
    ({ dimensions, font, blocks }) => {
      if (!dimensions) return;
      const entries = [];
      for (const block of blocks) {
        const element = textNodes.get(block);
        if (element) entries.push({ element, size: fitFontSize(block.text, block.bbox, dimensions.width, dimensions.height, font.advance) });
      }
      fitTextBlocks(entries);
      if (!sheet.hasAttribute("data-fitted")) sheet.setAttribute("data-fitted", "");
    },
    { name: "fit replica page" },
  );

  return <div class="digital-page-wrap">
    <div ref={(element) => { sheet = element; ref(element); }} class="digital-page" style={{ "aspect-ratio": aspect()?.url === imageUrl() ? aspect()?.ratio : "210 / 297" }}
      aria-label={`Digital replica of page ${props.page}`}>
      <For each={props.blocks}>{(block, index) => isImageBlock(block)
        ? <FigureCrop block={block} url={imageUrl()} />
        : <div class={["digital-block", `digital-block--${block.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, { "evidence-match": marked().has(index()) }]}
          ref={(element) => {
            textNodes.set(block, element);
            element.append(typeof block.content === "string" ? block.content : block.content.cloneNode(true));
          }}
          data-label={block.label} style={blockStyle(block.bbox)} />}
      </For>
    </div>
  </div>;
}
