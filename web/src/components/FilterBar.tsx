import { createSignal, For, latest, Show, useContext } from "solid-js";
import type { DocumentSort } from "../client/api";
import { AppContext } from "../state/app";
import { initialQuery, SORT_LABELS } from "../state/url";
import { ChevronDown, SlidersHorizontal } from "./Icons";

export function FilterToggle(props: { count: number }) {
  const app = useContext(AppContext);
  return <button type="button" class="btn filter-toggle" aria-expanded={app.filtersOpen() ? "true" : "false"} aria-controls="document-filters" onClick={app.toggleFilters}>
    <SlidersHorizontal size={16} aria-hidden="true" />
    {props.count > 0 ? `Filters (${props.count})` : "Filters"}
  </button>;
}

export function SenderLink(props: { sender: string }) {
  const { url } = useContext(AppContext);
  return <button type="button" class="sender-link" title={`Show only ${props.sender}`} onClick={() => url.updateQuery({ sender: props.sender })}>{props.sender}</button>;
}

const sortOptions = Object.entries(SORT_LABELS);

export function FilterBar(props: { count: number; withSort?: boolean }) {
  const app = useContext(AppContext);
  const query = () => app.url.state.query;
  const [sender, setSender] = createSignal(() => query().sender, { name: "sender filter draft" });
  const [from, setFrom] = createSignal(() => query().createdFrom, { name: "from filter draft" });
  const [to, setTo] = createSignal(() => query().createdTo, { name: "to filter draft" });
  return <div class={["filters", { "is-open": app.filtersOpen() || (!props.withSort && props.count > 0) }]} id="document-filters" role="group" aria-label="Filter documents">
    <label class="field field--sender">
      <span class="field__label">Sender</span>
      <input class="input" list="sender-options" value={sender()} placeholder="All senders" autocomplete="off"
        onInput={(event) => setSender(event.currentTarget.value)}
        onChange={(event) => app.url.updateQuery({ sender: event.currentTarget.value })} />
      <datalist id="sender-options"><For each={app.library.context.senders}>{(name) => <option value={name} />}</For></datalist>
    </label>
    <label class="field field--date">
      <span class="field__label">From</span>
      <input class="input" type="date" value={from()} max={query().createdTo || undefined}
        onInput={(event) => setFrom(event.currentTarget.value)}
        onChange={(event) => app.url.updateQuery({ createdFrom: event.currentTarget.value })} />
    </label>
    <label class="field field--date">
      <span class="field__label">To</span>
      <input class="input" type="date" value={to()} min={query().createdFrom || undefined}
        onInput={(event) => setTo(event.currentTarget.value)}
        onChange={(event) => app.url.updateQuery({ createdTo: event.currentTarget.value })} />
    </label>
    <Show when={props.withSort}>
      <label class="field field--sort">
        <span class="field__label">Sort</span>
        <span class="select">
          <select class="input" value={latest(() => query().sort)} onChange={(event) => app.url.updateQuery({ sort: event.currentTarget.value as DocumentSort })}>
            <For each={sortOptions}>{([value, label]) => <option value={value}>{label}</option>}</For>
          </select>
          <ChevronDown size={16} aria-hidden="true" />
        </span>
      </label>
    </Show>
    <Show when={props.count > 0}>
      <button type="button" class="btn btn--text filters__reset" onClick={() => {
        setSender("");
        setFrom("");
        setTo("");
        app.url.updateQuery(initialQuery);
      }}>Reset filters</button>
    </Show>
  </div>;
}
