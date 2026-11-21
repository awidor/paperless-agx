import { createMemo, createProjection, createSignal, from, onCleanup, onSettled, Show, useContext } from "solid-js";
import { getPages, type Document } from "../../client/api";
import { EvidenceMarks } from "../../components/EvidenceMarks";
import { FileText } from "../../components/Icons";
import { locateEvidence, type FrameShape, type Run } from "../../lib/evidenceHighlight";
import type { Crop } from "../../lib/paperCrop";
import { acquirePdf, pdfPage, pdfText } from "../../lib/pdf";
import { plural } from "../../lib/format";
import { inkIn } from "../../primitives/motion";
import { AppContext } from "../../state/app";

type Props = {
  document: Document;
  page: number;
  terms: string[];
  exact: boolean;
  summary: boolean;
  shape: FrameShape;
  label: string;
};
type Strip = { pending: boolean; missing: boolean; crop: Crop | null; matches: number };

async function printedRuns(id: number, page: number, signal: AbortSignal) {
  const pdf = await acquirePdf(`/api/documents/${id}/file`, signal);
  try {
    const proxy = await pdfPage(pdf.document, page);
    signal.throwIfAborted();
    return (await pdfText(pdf, proxy)).runs;
  } finally {
    pdf.release();
  }
}

async function ocrRuns(id: number, page: number, signal: AbortSignal): Promise<Run[]> {
  const pages = await getPages(id, signal);
  return (pages.find((candidate) => candidate.page === page)?.blocks ?? []).map((block) => ({
    text: block.text,
    box: [block.bbox[0] / 1000, block.bbox[1] / 1000, block.bbox[2] / 1000, block.bbox[3] / 1000],
  }));
}

async function evidence(id: number, page: number, media: Document["media_type"], terms: string[], signal: AbortSignal) {
  let runs: Run[] = media === "pdf" ? await printedRuns(id, page, signal).catch(() => []) : [];
  signal.throwIfAborted();
  let match = locateEvidence(runs, terms);
  if (terms.length && !match.groups.length) {
    const blocks = await ocrRuns(id, page, signal).catch(() => []);
    signal.throwIfAborted();
    const fallback = locateEvidence(blocks, terms);
    if (fallback.groups.length) {
      runs = blocks;
      match = fallback;
    }
  }
  return { ...match, boxes: runs.map((run) => run.box) };
}

function Caption(props: { page: number; pageCount: number; summary: boolean; exact: boolean; matches: number }) {
  return <Show when={props.pageCount > 1 && !props.summary}>
    <figcaption class="source__where">
      {props.exact && props.matches > 0
        ? `${plural(props.matches, "match", "matches")} on page ${props.page} of ${props.pageCount}`
        : `Page ${props.page} of ${props.pageCount}`}
    </figcaption>
  </Show>;
}

function FramedCrop(props: { crop: Crop; label: string }) {
  const url = createMemo(() => {
    const value = URL.createObjectURL(props.crop.blob);
    onCleanup(() => URL.revokeObjectURL(value));
    return value;
  }, { name: "strip image URL" });
  const frame = () => props.crop.frame;
  return <div class="paper" style={{ "aspect-ratio": ((frame().width * props.crop.pageAspect) / frame().height).toFixed(4) }} role="img" aria-label={props.label}>
    <div class="paper__plane" style={{
      width: `${100 / frame().width}%`,
      "aspect-ratio": String(props.crop.pageAspect),
      transform: `translate(${-frame().x * 100}%, ${-frame().y * 100}%)`,
    }}>
      <img ref={inkIn} class="doc-image ink" src={url()} alt="" draggable={false} />
      <EvidenceMarks boxes={frame().marks} />
    </div>
  </div>;
}

/** Starts reading the original page only when its strip is close to the viewport. */
export function PaperCrop(props: Props) {
  const { crops } = useContext(AppContext);
  let host!: HTMLElement;
  const [visible, setVisible] = createSignal(false, { name: "strip near viewport" });
  onSettled(() => {
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      setVisible(true);
    }, { rootMargin: "200px" });
    observer.observe(host);
    return () => observer.disconnect();
  });

  const seed: Strip = { pending: false, missing: false, crop: null, matches: 0 };
  const strip = createProjection<Strip>(() => {
    if (!visible()) return;
    const { page, shape } = props;
    const terms = [...props.terms];
    const { document_id: id, updated_at, media_type } = props.document;

    return from<Strip>((next, _error, complete) => {
      const controller = new AbortController();
      const { signal } = controller;
      next({ ...seed, pending: true });

      const geometry = evidence(id, page, media_type, terms, signal);
      const frame = crops.crop({
        key: `${id}:${page}:${updated_at}`,
        url: `/api/documents/${id}/pages/${page}/image`,
      }, shape, geometry, signal);

      function finish(crop: Crop | null, places = 0) {
        if (signal.aborted) return;
        next({ pending: false, missing: !crop, crop, matches: crop && places > crop.frame.marks.length ? places : 0 });
        complete();
      }

      void Promise.all([geometry, frame]).then(([{ places }, crop]) => finish(crop, places), () => finish(null));
      return () => controller.abort();
    });
  }, { ...seed }, { name: "evidence strip" });

  return <figure class="source__paper" ref={host} aria-busy={strip.pending ? "true" : undefined}>
    <Show when={strip.crop} keyed fallback={
      <div class={["paper", { "paper--loading": !strip.missing, "paper--blank": strip.missing }]}
        style={{ "aspect-ratio": String(props.shape.maxAspect) }}
        role={strip.missing ? "img" : undefined}
        aria-label={strip.missing ? props.label : undefined}
        aria-hidden={strip.missing ? undefined : "true"}>
        <Show when={strip.missing}><FileText size={22} aria-hidden="true" /></Show>
      </div>
    }>
      {(crop) => <FramedCrop crop={crop} label={props.label} />}
    </Show>
    <Caption page={props.page} pageCount={props.document.page_count} exact={props.exact} summary={props.summary} matches={strip.matches} />
  </figure>;
}
