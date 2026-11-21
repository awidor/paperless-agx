import { createProjection, createStore, createUniqueId, For, onFlush, Show, useContext } from "solid-js";
import type { ScanMode, ScanRequest, ScanSource } from "../client/api";
import { plural } from "../lib/format";
import { createGrooveThumb } from "../primitives/motion";
import { AppContext } from "../state/app";
import { createTrayDismiss } from "./createTrayDismiss";
import { ScanLine, X } from "./Icons";
import { Spinner } from "./ui";

const storageKey = "paperless-agx-scan";
const DEFAULTS: ScanRequest = { source: "auto", mode: "gray", dpi: 300 };
const SOURCES: [ScanSource, string][] = [["auto", "Auto"], ["feeder", "Feeder"], ["glass", "Glass"]];
const MODES: [ScanMode, string][] = [["gray", "Gray"], ["color", "Color"], ["black_white", "Black & white"]];
const RESOLUTIONS = [150, 300, 600] as const;
const RESOLUTION_OPTIONS = RESOLUTIONS.map((dpi) => [dpi, `${dpi} dpi`] as const);
const SOURCE_HINTS: Record<ScanSource, string> = {
  auto: "The feeder when paper is in it, otherwise the glass.",
  feeder: "Every sheet in the feeder becomes one document.",
  glass: "One page from the glass.",
};
const RESOLUTION_HINTS: Record<number, string> = {
  150: "Quick and small; fine for plain letters.",
  300: "Right for most documents.",
  600: "For small print and photos; slow and large.",
};

function readSettings(): ScanRequest {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Partial<ScanRequest> | null;
    if (!saved) return DEFAULTS;
    return {
      source: SOURCES.find(([value]) => value === saved.source)?.[0] ?? DEFAULTS.source,
      mode: MODES.find(([value]) => value === saved.mode)?.[0] ?? DEFAULTS.mode,
      dpi: RESOLUTIONS.find((value) => value === saved.dpi) ?? DEFAULTS.dpi,
    };
  } catch {
    return DEFAULTS;
  }
}

function saveSettings(settings: ScanRequest) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(settings));
  } catch {
    // The choice still applies to this scan.
  }
}

function Choice<T extends string | number>(props: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (value: T) => void;
}) {
  const groove = createGrooveThumb(() => props.value);
  const id = createUniqueId();
  const selected = createProjection<Record<string, boolean>>(() => ({ [props.value]: true }), {}, { name: "selected scan option" });
  return <div class="field">
    <span class="field__label" id={id}>{props.label}</span>
    <div class="groove" ref={groove} role="group" aria-labelledby={id}>
      <For each={props.options}>{([option, name]) => <button
        type="button"
        class="groove__option"
        aria-pressed={selected[String(option)] ? "true" : "false"}
        onClick={() => props.onChange(option)}
      >{name}</button>}</For>
    </div>
  </div>;
}

function ScanGlyph(props: { active: boolean }) {
  return <>
    <span hidden={props.active}><ScanLine size={16} aria-hidden="true" /></span>
    <span hidden={!props.active}><Spinner /></span>
  </>;
}

export function ScanControl() {
  const { transfers } = useContext(AppContext);
  let dialog!: HTMLDialogElement;
  const [settings, setSettings] = createStore({ ...readSettings() }, { name: "scan settings" });
  const scanning = () => transfers.state.scanning;

  function open() {
    setSettings((draft) => { Object.assign(draft, readSettings()); });
    dialog.showModal();
  }

  function start(event: SubmitEvent) {
    event.preventDefault();
    const next = { ...settings };
    saveSettings(next);
    dialog.close();
    void transfers.scan(next);
  }

  return <>
    <button type="button" class="btn" disabled={scanning()} aria-busy={scanning() ? "true" : "false"} onClick={open}>
      <ScanGlyph active={scanning()} />
      <span class="btn__label">{scanning() ? "Scanning" : "Scan"}</span>
    </button>
    <dialog ref={dialog} class="scan-dialog stock" aria-labelledby="scan-title"
      onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close(); }}>
      <form method="dialog" onSubmit={start}>
        <div>
          <h2 class="scan-dialog__title" id="scan-title">Scan</h2>
          <p class="scan-dialog__lead">Samsung SL-M3870FW · A4</p>
        </div>
        <div class="scan-dialog__group">
          <Choice label="Paper from" value={settings.source} options={SOURCES} onChange={(source) => setSettings((draft) => { draft.source = source; })} />
          <p class="scan-dialog__hint">{SOURCE_HINTS[settings.source]}</p>
        </div>
        <Choice label="Color" value={settings.mode} options={MODES} onChange={(mode) => setSettings((draft) => { draft.mode = mode; })} />
        <div class="scan-dialog__group">
          <Choice label="Resolution" value={settings.dpi} options={RESOLUTION_OPTIONS} onChange={(dpi) => setSettings((draft) => { draft.dpi = dpi; })} />
          <p class="scan-dialog__hint">{RESOLUTION_HINTS[settings.dpi]}</p>
        </div>
        <div class="scan-dialog__actions">
          <button type="button" class="btn btn--text" onClick={() => dialog.close()}>Cancel</button>
          <button type="submit" class="btn btn--ink" autofocus><ScanLine size={16} aria-hidden="true" /> Scan</button>
        </div>
      </form>
    </dialog>
  </>;
}

export function ScanTray() {
  const { transfers, url } = useContext(AppContext);
  const state = () => transfers.state.scan!;
  const scanning = () => transfers.state.scanning;
  const failed = () => Boolean(state().error);

  function renderStatus(job: number) {
    const tray = createTrayDismiss(() => !scanning() && !failed(), 8_000, () => transfers.dismissScan(job));
    return <section
      class={["tray", "stock", { "is-leaving": tray.leaving() }]}
      role={failed() ? "alert" : "status"}
      aria-label="Scan"
      onAnimationEnd={tray.onAnimationEnd}
      onPointerEnter={tray.onPointerEnter}
      onPointerLeave={tray.onPointerLeave}
      onFocusIn={tray.onFocusIn}
      onFocusOut={tray.onFocusOut}
    >
      <div class="tray__head">
        <ScanGlyph active={scanning()} />
        <p class="tray__title">{scanning() ? "Scanning" : failed() ? "Scan failed" : "Scan added"}</p>
        <Show when={!scanning()}>
          <button type="button" class="icon-btn icon-btn--sm" aria-label="Dismiss scan status" onClick={tray.leave}><X size={16} aria-hidden="true" /></button>
        </Show>
      </div>
      <Show when={scanning()} fallback={<Show when={failed()} fallback={<>
        <ul class="tray__lines"><li>{plural(state().pages, "page")} added and queued for reading</li></ul>
        <Show when={state().document}>{(scanned) => <div class="tray__actions">
          <button type="button" class="btn btn--text" onClick={() => {
            onFlush(tray.leave);
            url.openDocument(scanned().document_id);
          }}>Open</button>
        </div>}</Show>
      </>}>
        <p class="error-text">{state().error}</p>
        <div class="tray__actions"><button type="button" class="btn btn--text" onClick={() => void transfers.scan(state().settings)}>Try again</button></div>
      </Show>}>
        <p class="tray__file">{state().pages === 0 ? "Waiting for the first page…" : `${plural(state().pages, "page")} scanned`}</p>
      </Show>
    </section>;
  }

  return <Show when={transfers.state.scan?.job} keyed>{renderStatus}</Show>;
}
