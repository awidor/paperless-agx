import type { Document } from "./api";

export function DocumentTitle({ document }: { document: Document }) {
  return <>
    {document.sender && <span className="title-sender">{document.sender}: </span>}
    {document.title || document.filename}
  </>;
}
