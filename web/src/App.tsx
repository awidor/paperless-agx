import { createMemo, createSignal, Show, useContext } from "solid-js";
import { Upload } from "./components/Icons";
import { ReaderHost } from "./components/ReaderHost";
import { ScanTray } from "./components/Scan";
import { TopBar } from "./components/TopBar";
import { Alert } from "./components/ui";
import { UploadTray } from "./components/UploadTray";
import { Library } from "./features/library/Library";
import { SearchView } from "./features/search/SearchView";
import { AppContext, createAppState } from "./state/app";

const ACCEPTED = "application/pdf,image/png,image/jpeg,image/tiff,image/webp";

export default function App() {
  return <AppContext value={createAppState()}><Shell /></AppContext>;
}

function Shell() {
  const { url, transfers, library } = useContext(AppContext);
  const selectedId = createMemo(() => url.state.selected?.id, { name: "selected document" });
  const uploading = () => transfers.state.upload?.active ?? false;
  let fileInput!: HTMLInputElement;
  function chooseFiles() { fileInput.click(); }

  return <div class="app">
    <TopBar onUpload={chooseFiles} />
    <input ref={fileInput} type="file" multiple hidden disabled={uploading()} accept={ACCEPTED} onChange={(event) => {
      if (event.currentTarget.files) void transfers.upload(event.currentTarget.files);
      event.currentTarget.value = "";
    }} />

    <main class="main">
      <div class="container">
        <Show when={library.context.error} keyed>{(message) => <ServiceAlert message={message} />}</Show>
        <Show when={url.state.search} keyed fallback={<Library onUpload={chooseFiles} />}>
          {(search) => <section class="view search" aria-labelledby="search-title"><SearchView query={search} /></section>}
        </Show>
      </div>
    </main>

    <div class="trays">
      <ScanTray />
      <UploadTray />
    </div>

    <Show when={transfers.dropping()}>
      <div class="drop" aria-hidden="true">
        <div class="drop__sheet">
          <Upload size={28} aria-hidden="true" />
          <p>{uploading() ? "Upload in progress" : "Drop to add to the library"}</p>
        </div>
      </div>
    </Show>

    <Show when={selectedId()} keyed>{(id) =>
      <ReaderHost documentId={id} page={url.state.selected?.page ?? 1} marks={url.state.selected?.marks} marksPage={url.state.selected?.marksPage} />
    }</Show>
  </div>;
}

function ServiceAlert(props: { message: string }) {
  const [dismissed, dismiss] = createSignal(false);
  return <Show when={!dismissed()}><Alert message={props.message} onDismiss={() => dismiss(true)} /></Show>;
}
