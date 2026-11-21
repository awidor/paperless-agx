import { affects, createStore, reconcile, refresh, type Accessor } from "solid-js";
import { getDocument, getPages, type Document, type PageInfo } from "../client/api";
import { createPollRequest } from "../primitives/createPollRequest";

type ReaderData = { loaded: boolean; document: Document | null; pages: PageInfo[]; error: string };

export function createReaderData(documentId: Accessor<number>, prepare: () => Promise<unknown>) {
  const request = createPollRequest();
  const [data, setData] = createStore<ReaderData>((previous) => {
    const id = documentId();
    return request.load((controller) => Promise.all([getDocument(id, controller.signal), getPages(id, controller.signal), prepare()]).then(
      ([document, pages]) => ({ loaded: true, document, pages, error: "" }),
      (cause) => {
        if (controller.signal.aborted) return;
        // Cancel the sibling GET before another poll can start.
        controller.abort();
        previous.loaded = true;
        previous.error = cause instanceof Error ? cause.message : "The document failed to load.";
      },
    ));
  }, { loaded: false, document: null, pages: [], error: "" }, { key: "page", name: "reader data", seedLoadingValue: true });

  return {
    data,
    poll: () => { if (!request.pending()) refresh(data); },
    update: () => refresh(data),
    dismissError: () => setData((draft) => { draft.error = ""; }),
    retry: () => {
      affects(data);
      refresh(data);
    },
    received: (document: Document) => setData((draft) => {
      if (draft.document) reconcile(document, null)(draft.document);
      else draft.document = document;
      draft.error = "";
    }),
  };
}
