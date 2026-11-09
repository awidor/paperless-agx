import { useEffect, useRef, useState } from "react";
import { ScanLine, X } from "lucide-react";
import type { Document, ScanMode, ScanRequest, ScanSource } from "./api";
import { plural } from "./format";
import { useGrooveThumb } from "./motion";
import { Spinner } from "./ui";

export type ScanState = {
  active: boolean;
  settings: ScanRequest;
  pages: number;
  document: Document | null;
  error: string;
};

const storageKey = "paperless-agx-scan";
const DEFAULTS: ScanRequest = { source: "auto", mode: "gray", dpi: 300 };
const SOURCES: [ScanSource, string][] = [["auto", "Auto"], ["feeder", "Feeder"], ["glass", "Glass"]];
const MODES: [ScanMode, string][] = [["gray", "Gray"], ["color", "Color"], ["black_white", "Black & white"]];
const RESOLUTIONS = [150, 300, 600] as const;
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
    return {
      source: SOURCES.some(([value]) => value === saved?.source) ? saved!.source! : DEFAULTS.source,
      mode: MODES.some(([value]) => value === saved?.mode) ? saved!.mode! : DEFAULTS.mode,
      dpi: RESOLUTIONS.some((value) => value === saved?.dpi) ? saved!.dpi! : DEFAULTS.dpi,
    };
  } catch {
    return DEFAULTS;
  }
}

function saveSettings(settings: ScanRequest) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(settings));
  } catch {
    // The choice still applies to this scan when storage is unavailable.
  }
}

function Choice<T extends string | number>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (value: T) => void;
}) {
  const groove = useGrooveThumb(String(value));
  const id = `scan-${label.toLowerCase().replace(/[^a-z]+/g, "-")}`;
  return <div className="field">
    <span className="field__label" id={id}>{label}</span>
    <div className="groove" ref={groove} role="group" aria-labelledby={id}>
      {options.map(([option, name]) => <button
        key={option}
        type="button"
        className="groove__option"
        aria-pressed={option === value}
        onClick={() => onChange(option)}
      >{name}</button>)}
    </div>
  </div>;
}

/** The Scan button, and the dialog where the source, color and resolution are chosen. */
export function ScanControl({ scanning, onScan }: { scanning: boolean; onScan: (settings: ScanRequest) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [settings, setSettings] = useState<ScanRequest>(readSettings);

  function open() {
    setSettings(readSettings());
    dialogRef.current?.showModal();
  }

  function start() {
    saveSettings(settings);
    dialogRef.current?.close();
    onScan(settings);
  }

  return <>
    <button type="button" className="btn" disabled={scanning} aria-busy={scanning} onClick={open}>
      {scanning ? <Spinner /> : <ScanLine size={16} aria-hidden="true" />}
      <span className="btn__label">{scanning ? "Scanning" : "Scan"}</span>
    </button>
    <dialog
      ref={dialogRef}
      className="scan-dialog stock"
      aria-labelledby="scan-title"
      // A click on the backdrop lands on the dialog itself and closes it.
      onClick={(event) => { if (event.target === event.currentTarget) event.currentTarget.close(); }}
    >
      <form method="dialog" onSubmit={(event) => { event.preventDefault(); start(); }}>
        <div>
          <h2 className="scan-dialog__title" id="scan-title">Scan</h2>
          <p className="scan-dialog__lead">Samsung SL-M3870FW · A4</p>
        </div>
        <div className="scan-dialog__group">
          <Choice label="Paper from" value={settings.source} options={SOURCES} onChange={(source) => setSettings({ ...settings, source })} />
          <p className="scan-dialog__hint">{SOURCE_HINTS[settings.source]}</p>
        </div>
        <Choice label="Color" value={settings.mode} options={MODES} onChange={(mode) => setSettings({ ...settings, mode })} />
        <div className="scan-dialog__group">
          <Choice
            label="Resolution"
            value={settings.dpi}
            options={RESOLUTIONS.map((dpi) => [dpi, `${dpi} dpi`] as const)}
            onChange={(dpi) => setSettings({ ...settings, dpi })}
          />
          <p className="scan-dialog__hint">{RESOLUTION_HINTS[settings.dpi]}</p>
        </div>
        <div className="scan-dialog__actions">
          <button type="button" className="btn btn--text" onClick={() => dialogRef.current?.close()}>Cancel</button>
          <button type="submit" className="btn btn--ink" autoFocus><ScanLine size={16} aria-hidden="true" /> Scan</button>
        </div>
      </form>
    </dialog>
  </>;
}

const DWELL_MS = 8_000;

/** Scan progress in the corner. A finished scan offers to open the document and leaves on its own. */
export function ScanTray({ state, onOpen, onRetry, onDismiss }: {
  state: ScanState | null;
  onOpen: (document: Document) => void;
  onRetry: (settings: ScanRequest) => void;
  onDismiss: () => void;
}) {
  const [held, setHeld] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const active = state?.active ?? false;
  const settled = state !== null && !state.active && !state.error;

  useEffect(() => {
    if (active) setLeaving(false);
  }, [active]);

  useEffect(() => {
    if (!settled || held) return;
    const timer = window.setTimeout(() => setLeaving(true), DWELL_MS);
    return () => window.clearTimeout(timer);
  }, [settled, held]);

  if (!state) return null;
  const failed = !state.active && Boolean(state.error);
  const title = state.active ? "Scanning" : failed ? "Scan failed" : "Scan added";
  return <section
    className={`tray stock${leaving ? " is-leaving" : ""}`}
    onAnimationEnd={(event) => {
      if (event.target !== event.currentTarget || event.animationName !== "tray-out") return;
      setLeaving(false);
      onDismiss();
    }}
    role={failed ? "alert" : "status"}
    aria-label="Scan"
    onPointerEnter={() => setHeld(true)}
    onPointerLeave={() => setHeld(false)}
    onFocus={() => setHeld(true)}
    onBlur={() => setHeld(false)}
  >
    <div className="tray__head">
      {state.active ? <Spinner /> : <ScanLine size={16} aria-hidden="true" />}
      <p className="tray__title">{title}</p>
      {!state.active && <button type="button" className="icon-btn icon-btn--sm" aria-label="Dismiss scan status" onClick={() => setLeaving(true)}><X size={16} aria-hidden="true" /></button>}
    </div>
    {state.active
      ? <p className="tray__file">{state.pages === 0 ? "Waiting for the first page…" : `${plural(state.pages, "page")} scanned`}</p>
      : failed
        ? <>
          <p className="error-text">{state.error}</p>
          <div className="tray__actions"><button type="button" className="btn btn--text" onClick={() => onRetry(state.settings)}>Try again</button></div>
        </>
        : <>
          <ul className="tray__lines"><li>{plural(state.pages, "page")} added and queued for reading</li></ul>
          {state.document && <div className="tray__actions"><button type="button" className="btn btn--text" onClick={() => { onOpen(state.document!); setLeaving(true); }}>Open</button></div>}
        </>}
  </section>;
}
