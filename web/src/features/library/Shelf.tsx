import { createMemo, For, Show, useContext } from "solid-js";
import { SenderLink } from "../../components/FilterBar";
import { StageMeter, Thumbnail } from "../../components/ui";
import { documentDate, documentName, formatBytes, formatDay, plural, type Group } from "../../lib/format";
import { AppContext } from "../../state/app";
import type { LibraryDocument } from "../../state/library";

/** The first row or so of sheets is on screen at once. */
const EAGER_SHEETS = 6;

export function Shelf(props: { groups: Group<LibraryDocument>[] }) {
  return <div class="shelf">
    <For each={props.groups} keyed={(group) => group.key}>{(group) => <section class="shelf-group" aria-label={group().label ?? "Documents"}>
      <Show when={group().label}>{(label) => <h2 class="group-title">{label()}</h2>}</Show>
      <ul class="sheet-grid" role="list">
        <For each={group().items}>{(document, index) => <li style={{ "--i": group().start + index() }}>
          <SheetCard document={document} priority={group().start + index() < EAGER_SHEETS} />
        </li>}</For>
      </ul>
    </section>}</For>
  </div>;
}

function SheetCard(props: { document: LibraryDocument; priority: boolean }) {
  const { url } = useContext(AppContext);
  const doc = () => props.document;
  const name = createMemo(() => documentName(doc()), { name: "card title" });
  const date = createMemo(() => documentDate(doc()), { name: "card date" });

  return <article class="sheet-card">
    <button type="button" class="cover" aria-label={`Open ${name()}`} onClick={() => url.openDocument(doc().document_id)} />
    <div class="sheet sheet--thumb">
      <Thumbnail document={doc()} priority={props.priority} />
      <Show when={doc().processing}><StageMeter document={doc()} class="stage--on-sheet" /></Show>
    </div>
    <div class="sheet-card__text">
      <h3 class="sheet-card__title">{name()}</h3>
      <Show when={doc().sender}>{(sender) => <SenderLink sender={sender()} />}</Show>
      <p class="sheet-card__meta">
        <time datetime={date().toISOString()}>{formatDay(date())}</time>
        <span>{doc().page_count ? plural(doc().page_count, "page") : formatBytes(doc().file_size)}</span>
      </p>
      <Show when={doc().failed}><p class="status status--failed">Processing failed</p></Show>
      <Show when={doc().last_error}>{(message) => <p class="error-text">{message()}</p>}</Show>
    </div>
  </article>;
}
