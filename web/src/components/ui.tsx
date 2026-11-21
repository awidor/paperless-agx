import { createEffect, createSignal, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { Document } from "../client/api";
import { stage } from "../lib/format";
import { inkIn } from "../primitives/motion";
import { FileText, LoaderCircle, TriangleAlert, X } from "./Icons";

/** Keep the image in place while a document's processing status advances. */
export function Thumbnail(props: { document: Document; page?: number; priority?: boolean }) {
  const [missing, setMissing] = createSignal(false, { name: "thumbnail missing" });
  const url = () => `/api/documents/${props.document.document_id}/thumbnails/${props.page ?? 1}`;
  let image: HTMLImageElement | undefined;
  let failedStatus: Document["status"] | undefined;

  createEffect(
    () => missing() ? props.document.status : undefined,
    (status) => {
      if (!image || status === undefined || status === failedStatus) return;
      failedStatus = status;
      image.loading = "eager";
      image.src = image.src;
    },
    { name: "retry missing thumbnail" },
  );

  return <>
    <img
      ref={[(element) => { image = element; }, inkIn]}
      class="doc-image ink"
      src={url()}
      hidden={missing()}
      alt=""
      width={210}
      height={297}
      loading={props.priority ? "eager" : "lazy"}
      fetchpriority={props.priority ? "high" : undefined}
      decoding="async"
      draggable={false}
      onLoad={() => setMissing(false)}
      onError={() => {
        failedStatus = props.document.status;
        setMissing(true);
      }}
    />
    <Show when={missing()}><span class="sheet__blank" aria-hidden="true"><FileText size={20} /></span></Show>
  </>;
}

export function StageMeter(props: { document: Document; class?: string }) {
  const step = () => stage(props.document);
  return <span class={["stage", props.class]} role="status">
    <span>{step().label}</span>
    <span class="meter" aria-hidden="true"><span class="meter__fill" style={{ "--progress": String(step().progress) }} /></span>
  </span>;
}

export function Spinner(props: { size?: number; label?: string } = {}) {
  return <LoaderCircle class="spin" size={props.size ?? 16} aria-hidden={props.label ? undefined : "true"} aria-label={props.label} />;
}

export function EmptyState(props: { title: string; children?: JSX.Element; action?: JSX.Element; alert?: boolean; live?: boolean }) {
  return <div class="empty" role={props.alert ? "alert" : props.live ? "status" : undefined}>
    <h2 class="empty__title">{props.title}</h2>
    <Show when={props.children}>{(body) => <p>{body()}</p>}</Show>
    <Show when={props.action}>{(action) => <div class="empty__actions">{action()}</div>}</Show>
  </div>;
}

export function Alert(props: { message: string; onDismiss: () => void; onRetry?: () => void }) {
  return <div class="alert" role="alert">
    <TriangleAlert size={18} aria-hidden="true" />
    <p>{props.message}</p>
    <Show when={props.onRetry}><button type="button" class="btn" onClick={() => props.onRetry?.()}>Try again</button></Show>
    <button type="button" class="icon-btn" aria-label="Dismiss error" onClick={() => props.onDismiss()}><X size={16} aria-hidden="true" /></button>
  </div>;
}

export function CloseReader(props: { onClose: () => void; disabled?: boolean }) {
  return <button type="button" class="icon-btn" aria-label="Close" autofocus disabled={props.disabled} onClick={() => props.onClose()}>
    <X size={20} aria-hidden="true" />
  </button>;
}
