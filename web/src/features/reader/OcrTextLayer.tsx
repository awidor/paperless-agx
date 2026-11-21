import { createMemo, For, onSettled, Show } from "solid-js";
import type { OcrBlock } from "../../client/api";
import { EvidenceMarks } from "../../components/EvidenceMarks";
import { markBoxes } from "../../lib/evidenceHighlight";
import { bindPageTextSelection } from "../../lib/pageTextSelection";
import { createFontMetrics, fitFontSize } from "../../lib/textFit";
import { createElementSize, type ElementSize } from "../../primitives/createElementSize";

export function OcrTextLayer(props: { blocks: OcrBlock[]; marks?: string[] }) {
  const { size, ref } = createElementSize();
  const font = createFontMetrics();
  let layer!: HTMLDivElement;
  onSettled(() => bindPageTextSelection(layer));

  const evidence = createMemo(() => props.marks?.length ? markBoxes(props.blocks.map((block) => ({
    text: block.text, box: [block.bbox[0] / 1_000, block.bbox[1] / 1_000, block.bbox[2] / 1_000, block.bbox[3] / 1_000],
  })), props.marks).flat() : [], { name: "OCR evidence" });

  return <div class="ocr-text-layer" ref={[(element) => { layer = element; }, ref]} aria-label="Selectable OCR text">
    <Show when={evidence().length > 0}>
      <div class="page-marks" aria-hidden="true"><EvidenceMarks boxes={evidence()} /></div>
    </Show>
    <Show when={size()}>{(box) =>
      <For each={props.blocks}>{(block) => <OcrSpan block={block} box={box()} advance={font().advance} />}</For>
    }</Show>
  </div>;
}

function OcrSpan(props: { block: OcrBlock; box: ElementSize; advance: number }) {
  const style = () => {
    const { bbox, text } = props.block;
    const { width, height } = props.box;
    return {
      left: `${bbox[0] / 10}%`, top: `${bbox[1] / 10}%`,
      width: `${Math.max(1, bbox[2] - bbox[0]) / 10}%`, height: `${Math.max(1, bbox[3] - bbox[1]) / 10}%`,
      "font-size": `${fitFontSize(text, bbox, width, height, props.advance).toFixed(2)}px`,
    };
  };
  return <span class="ocr-positioned-block" data-label={props.block.label} style={style()}>{props.block.text}</span>;
}
