import { createMemo, For, Show, useContext } from "solid-js";
import { SenderLink } from "../../components/FilterBar";
import { StageMeter, Thumbnail } from "../../components/ui";
import { documentDate, documentName, formatBytes, formatDay, type Group } from "../../lib/format";
import { AppContext } from "../../state/app";
import type { LibraryDocument } from "../../state/library";

export function Ledger(props: { groups: Group<LibraryDocument>[] }) {
  return <div class="ledger-wrap">
    <table class="ledger">
      <thead>
        <tr><th scope="col">Document</th><th scope="col">Sender</th><th scope="col">Date</th><th scope="col" class="num">Pages</th><th scope="col" class="num">Size</th><th scope="col">Added</th></tr>
      </thead>
      <For each={props.groups} keyed={(group) => group.key}>{(group) => <tbody>
        <Show when={group().label}>{(label) => <tr class="ledger__group"><th scope="colgroup" colspan={6}>{label()}</th></tr>}</Show>
        <For each={group().items}>{(document, index) => <LedgerRow document={document} order={group().start + index()} />}</For>
      </tbody>}</For>
    </table>
  </div>;
}

function LedgerRow(props: { document: LibraryDocument; order: number }) {
  const { url } = useContext(AppContext);
  const doc = () => props.document;
  const name = createMemo(() => documentName(doc()), { name: "row title" });

  return <tr class="ledger__row" style={{ "--i": props.order }}>
    <td class="ledger__doc">
      <button type="button" class="cover" aria-label={`Open ${name()}`} onClick={() => url.openDocument(doc().document_id)} />
      <div class="ledger__doc-inner">
        <span class="sheet sheet--mini"><Thumbnail document={doc()} /></span>
        <span class="ledger__name">
          <span class="ledger__title">{name()}</span>
          <Show when={doc().processing}><StageMeter document={doc()} class="stage--inline" /></Show>
          <Show when={doc().failed}><span class="status status--failed">Processing failed</span></Show>
        </span>
      </div>
    </td>
    <td class="ledger__sender"><Show when={doc().sender}>{(sender) => <SenderLink sender={sender()} />}</Show></td>
    <td class="fig">{formatDay(documentDate(doc()))}</td>
    <td class="fig num">{doc().page_count || ""}</td>
    <td class="fig num">{formatBytes(doc().file_size)}</td>
    <td class="fig ledger__added">{formatDay(doc().added_at)}</td>
  </tr>;
}
