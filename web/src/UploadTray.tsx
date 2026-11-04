import { useEffect, useState } from "react";
import { Upload, X } from "lucide-react";
import { plural } from "./format";

export type UploadState = {
  active: boolean;
  total: number;
  completed: number;
  current: string;
  uploaded: number;
  duplicates: number;
  failures: string[];
};

const DWELL_MS = 6_000;

/** Upload progress in the corner; a clean finish leaves on its own unless the pointer or focus is on it. */
export function UploadTray({ state, onDismiss }: { state: UploadState | null; onDismiss: () => void }) {
  const [held, setHeld] = useState(false);
  // The tray slides out before it is gone; a new upload while it leaves brings it back.
  const [leaving, setLeaving] = useState(false);
  const settled = state !== null && !state.active && state.failures.length === 0;
  const active = state?.active ?? false;

  useEffect(() => {
    if (active) setLeaving(false);
  }, [active]);

  useEffect(() => {
    if (!settled || held) return;
    const timer = window.setTimeout(() => setLeaving(true), DWELL_MS);
    return () => window.clearTimeout(timer);
  }, [settled, held]);

  if (!state) return null;
  const failed = !state.active && state.failures.length > 0;
  return <section
    className={`tray stock${leaving ? " is-leaving" : ""}`}
    onAnimationEnd={(event) => {
      if (event.target !== event.currentTarget || event.animationName !== "tray-out") return;
      setLeaving(false);
      onDismiss();
    }}
    role={failed ? "alert" : "status"}
    aria-label="Uploads"
    onPointerEnter={() => setHeld(true)}
    onPointerLeave={() => setHeld(false)}
    onFocus={() => setHeld(true)}
    onBlur={() => setHeld(false)}
  >
    <div className="tray__head">
      <Upload size={16} aria-hidden="true" />
      <p className="tray__title">{state.active ? `Uploading ${state.completed + 1} of ${state.total}` : failed ? "Some files were not added" : "Upload finished"}</p>
      {!state.active && <button type="button" className="icon-btn icon-btn--sm" aria-label="Dismiss upload status" onClick={() => setLeaving(true)}><X size={16} aria-hidden="true" /></button>}
    </div>
    {state.active ? <>
      <p className="tray__file">{state.current}</p>
      <span className="meter" aria-hidden="true"><span className="meter__fill" style={{ ["--progress" as string]: String(state.completed / state.total) }} /></span>
    </> : <ul className="tray__lines">
      {state.uploaded > 0 && <li>{plural(state.uploaded, "file")} added and queued for reading</li>}
      {state.duplicates > 0 && <li>{plural(state.duplicates, "file")} already in the library</li>}
      {state.failures.map((failure) => <li key={failure} className="error-text">{failure}</li>)}
    </ul>}
  </section>;
}
