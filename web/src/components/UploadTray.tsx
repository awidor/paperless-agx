import { For, Show, useContext } from "solid-js";
import { plural } from "../lib/format";
import { AppContext } from "../state/app";
import type { UploadState } from "../state/transfers";
import { createTrayDismiss } from "./createTrayDismiss";
import { Upload, X } from "./Icons";

export function UploadTray() {
  const { transfers } = useContext(AppContext);
  return <Show when={transfers.state.upload?.job} keyed>{(_job) => <UploadStatus state={transfers.state.upload!} />}</Show>;
}

function UploadStatus(props: { state: UploadState }) {
  const { dismissUpload } = useContext(AppContext).transfers;
  const state = () => props.state;
  const failed = () => !state().active && state().failures.length > 0;
  const tray = createTrayDismiss(() => !state().active && !failed(), 6_000, dismissUpload);
  return <section
    class={["tray", "stock", { "is-leaving": tray.leaving() }]}
    role={failed() ? "alert" : "status"}
    aria-label="Uploads"
    onAnimationEnd={tray.onAnimationEnd}
    onPointerEnter={tray.onPointerEnter}
    onPointerLeave={tray.onPointerLeave}
    onFocusIn={tray.onFocusIn}
    onFocusOut={tray.onFocusOut}
  >
    <div class="tray__head">
      <Upload size={16} aria-hidden="true" />
      <p class="tray__title">{state().active ? `Uploading ${state().completed + 1} of ${state().total}` : failed() ? "Some files were not added" : "Upload finished"}</p>
      <Show when={!state().active}>
        <button type="button" class="icon-btn icon-btn--sm" aria-label="Dismiss upload status" onClick={tray.leave}><X size={16} aria-hidden="true" /></button>
      </Show>
    </div>
    <Show when={state().active} fallback={<ul class="tray__lines">
      <Show when={state().uploaded > 0}><li>{plural(state().uploaded, "file")} added and queued for reading</li></Show>
      <Show when={state().duplicates > 0}><li>{plural(state().duplicates, "file")} already in the library</li></Show>
      <For each={state().failures}>{(failure) => <li class="error-text">{failure}</li>}</For>
    </ul>}>
      <p class="tray__file">{state().current}</p>
      <span class="meter" aria-hidden="true"><span class="meter__fill" style={{ "--progress": String(state().completed / state().total) }} /></span>
    </Show>
  </section>;
}
