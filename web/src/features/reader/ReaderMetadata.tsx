import { For, Show, useContext } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { Document } from "../../client/api";
import { Check, Download, RefreshCw, Save, Trash2 } from "../../components/Icons";
import { Spinner, StageMeter } from "../../components/ui";
import { formatBytes, formatDay, isProcessing, stage } from "../../lib/format";
import { AppContext } from "../../state/app";

type Field = { value: string; set: (value: string) => void };
type Props = {
  document: Document;
  title: Field;
  sender: Field;
  date: Field;
  dirty: boolean;
  busy: boolean;
  onSave: (event: SubmitEvent) => void;
  onRetry: () => void;
  onRemove: () => void;
};

function MetadataField(props: { label: string; ai: boolean; children: JSX.Element }) {
  return <label class="field">
    <span class="field__label">{props.label}<Show when={props.ai}><span class="field__source">Filled in by AI</span></Show></span>
    {props.children}
  </label>;
}

export function ReaderMetadata(props: Props) {
  const { library } = useContext(AppContext);
  const doc = () => props.document;

  function saveLabel() {
    if (props.busy) return <span class="reader__save-label"><Spinner /> Saving</span>;
    if (props.dirty) return <span class="reader__save-label"><Save size={16} aria-hidden="true" /> Save changes</span>;
    return <span class="reader__save-label"><Check size={16} aria-hidden="true" /> Saved</span>;
  }

  return <aside class="reader__info" aria-label="Document information">
    <form class="panel-section" onSubmit={(event) => props.onSave(event)}>
      <h3>Details</h3>
      <MetadataField label="Title" ai={doc().title_source === "ai"}>
        <input class="input" value={props.title.value} maxlength={500} placeholder={doc().filename} disabled={props.busy}
          onInput={(event) => props.title.set(event.currentTarget.value)} />
      </MetadataField>
      <MetadataField label="Sender" ai={doc().sender_source === "ai"}>
        <input class="input" value={props.sender.value} maxlength={200} list="reader-sender-options" placeholder="Unknown sender" autocomplete="off"
          disabled={props.busy} onInput={(event) => props.sender.set(event.currentTarget.value)} />
        <datalist id="reader-sender-options"><For each={library.context.senders}>{(entry) => <option value={entry} />}</For></datalist>
      </MetadataField>
      <MetadataField label="Document date" ai={doc().created_at_source === "ai"}>
        <input class="input" type="date" value={props.date.value} disabled={props.busy}
          onInput={(event) => props.date.set(event.currentTarget.value)} />
      </MetadataField>
      <button type="submit" class={["btn", "btn--block", { "btn--ink": props.dirty || props.busy }]} disabled={props.busy || !props.dirty} aria-busy={props.busy ? "true" : "false"}>
        {saveLabel()}
      </button>
    </form>

    <section class="panel-section facts">
      <h3>File</h3>
      <dl>
        <div><dt>Status</dt><dd><Show when={isProcessing(doc())} fallback={stage(doc()).label}><StageMeter document={doc()} class="stage--inline" /></Show></dd></div>
        <div><dt>Pages</dt><dd>{doc().page_count}</dd></div>
        <div><dt>Size</dt><dd>{formatBytes(doc().file_size)}</dd></div>
        <div><dt>Added</dt><dd>{formatDay(doc().added_at)}</dd></div>
        <div><dt>File name</dt><dd>{doc().filename}</dd></div>
      </dl>
      <Show when={doc().last_error}>{(error) => <p class="error-text">{error()}</p>}</Show>
    </section>

    <section class="panel-section">
      <h3>Actions</h3>
      <div class="actions">
        <a class="action" href={`/api/documents/${doc().document_id}/file`} download={doc().filename}><Download size={16} aria-hidden="true" /> Download original</a>
        <Show when={!isProcessing(doc())}>
          <button type="button" class="action" disabled={props.busy} onClick={() => props.onRetry()}><RefreshCw size={16} aria-hidden="true" /> Reprocess document</button>
        </Show>
        <button type="button" class="action action--danger" disabled={props.busy} onClick={() => props.onRemove()}><Trash2 size={16} aria-hidden="true" /> Delete document</button>
      </div>
    </section>
  </aside>;
}
