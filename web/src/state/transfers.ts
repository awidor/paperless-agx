import { createSignal, createStore, onSettled } from "solid-js";
import { streamScan, uploadDocument, type Document, type ScanRequest } from "../client/api";

export type UploadState = {
  job: number;
  active: boolean;
  total: number;
  completed: number;
  current: string;
  uploaded: number;
  duplicates: number;
  failures: string[];
};

type ScanState = {
  job: number;
  settings: ScanRequest;
  pages: number;
  document: Document | null;
  error: string;
};

export function createTransfers(onChanged: () => void) {
  const [state, setState] = createStore<{
    upload: UploadState | null;
    scan: ScanState | null;
    scanning: boolean;
  }>({ upload: null, scan: null, scanning: false }, { name: "transfers" });
  const [dropping, setDropping] = createSignal(false, { name: "dropping files" });
  const lifetime = new AbortController();
  let sequence = 0;
  let uploading = false;
  let scanning = false;

  async function upload(files: FileList | File[]) {
    const pending = Array.from(files);
    if (!pending.length || uploading) return;
    uploading = true;
    setState((draft) => {
      const job = ++sequence;
      if (draft.upload) {
        Object.assign(draft.upload, { job, active: true, total: pending.length, completed: 0, current: pending[0].name, uploaded: 0, duplicates: 0 });
        draft.upload.failures.length = 0;
      } else {
        draft.upload = { job, active: true, total: pending.length, completed: 0, current: pending[0].name, uploaded: 0, duplicates: 0, failures: [] };
      }
    });
    for (const [index, file] of pending.entries()) {
      if (lifetime.signal.aborted) return;
      if (index > 0) setState((draft) => { draft.upload!.current = file.name; });
      try {
        const result = await uploadDocument(file, lifetime.signal);
        if (lifetime.signal.aborted) return;
        setState((draft) => {
          if (result.duplicate) draft.upload!.duplicates += 1;
          else draft.upload!.uploaded += 1;
        });
      } catch (cause) {
        if (lifetime.signal.aborted) return;
        const message = cause instanceof Error ? cause.message : "upload failed";
        setState((draft) => { draft.upload!.failures.push(`${file.name}: ${message}`); });
      }
      setState((draft) => { draft.upload!.completed = index + 1; });
    }
    uploading = false;
    setState((draft) => { draft.upload!.active = false; });
    onChanged();
  }

  async function scan(settings: ScanRequest) {
    if (scanning) return;
    scanning = true;
    setState((draft) => {
      const job = ++sequence;
      draft.scanning = true;
      if (draft.scan) {
        Object.assign(draft.scan, { job, pages: 0, document: null, error: "" });
        Object.assign(draft.scan.settings, settings);
      } else {
        draft.scan = { job, settings: { ...settings }, pages: 0, document: null, error: "" };
      }
    });
    try {
      const result = await streamScan(settings, (pages) => {
        setState((draft) => { draft.scan!.pages = pages; });
      }, lifetime.signal);
      if (lifetime.signal.aborted) return;
      setState((draft) => {
        draft.scan!.pages = result.pages;
        draft.scan!.document = result.document;
      });
    } catch (cause) {
      if (lifetime.signal.aborted) return;
      setState((draft) => { draft.scan!.error = cause instanceof Error ? cause.message : "The scan failed."; });
    }
    scanning = false;
    setState((draft) => { draft.scanning = false; });
    onChanged();
  }

  onSettled(() => {
    const { signal } = lifetime;
    let depth = 0;
    window.addEventListener("dragenter", (event) => {
      if (event.dataTransfer?.types.includes("Files")) {
        depth += 1;
        if (depth === 1) setDropping(true);
      }
    }, { signal });
    window.addEventListener("dragleave", () => {
      if (depth > 0 && --depth === 0) setDropping(false);
    }, { signal });
    window.addEventListener("dragover", (event) => event.preventDefault(), { signal });
    window.addEventListener("drop", (event) => {
      event.preventDefault();
      depth = 0;
      setDropping(false);
      if (event.dataTransfer?.files.length) void upload(event.dataTransfer.files);
    }, { signal });
    return () => lifetime.abort();
  });

  return {
    state, dropping, upload, scan,
    dismissUpload: () => setState((draft) => { if (!draft.upload?.active) draft.upload = null; }),
    dismissScan: (job: number) => setState((draft) => {
      if (!draft.scanning && draft.scan?.job === job) draft.scan = null;
    }),
  };
}
