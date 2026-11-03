import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { FileText, LoaderCircle, TriangleAlert, X } from "lucide-react";
import type { Document } from "./api";
import { stage } from "./format";

/** A page render of the document, or a blank sheet while there is none yet. */
export function Thumbnail({ document, page = 1, priority = false }: { document: Document; page?: number; priority?: boolean }) {
  const [missing, setMissing] = useState(false);
  if (missing) return <span className="sheet__blank" aria-hidden="true"><FileText size={20} /></span>;
  return <img
    className="doc-image"
    src={`/api/documents/${document.document_id}/thumbnails/${page}`}
    alt=""
    width={210}
    height={297}
    loading={priority ? "eager" : "lazy"}
    fetchPriority={priority ? "high" : undefined}
    decoding="async"
    draggable={false}
    onError={() => setMissing(true)}
  />;
}

/** Where a document is in processing, as the stage's name over a bar of the stages done. */
export function StageMeter({ document, className = "" }: { document: Document; className?: string }) {
  const { label, progress } = stage(document);
  return <span className={`stage ${className}`} role="status">
    <span>{label}</span>
    <span className="meter" aria-hidden="true"><span className="meter__fill" style={{ ["--progress" as string]: String(progress) }} /></span>
  </span>;
}

export function Spinner({ size = 16, label }: { size?: number; label?: string }) {
  return <LoaderCircle className="spin" size={size} aria-hidden={label ? undefined : true} aria-label={label} />;
}

export function EmptyState({ title, children, action, alert = false, live = false }: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  alert?: boolean;
  live?: boolean;
}) {
  return <div className="empty" role={alert ? "alert" : live ? "status" : undefined}>
    <h2 className="empty__title">{title}</h2>
    {children && <p>{children}</p>}
    {action && <div className="empty__actions">{action}</div>}
  </div>;
}

export function Alert({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return <div className="alert" role="alert">
    <TriangleAlert size={18} aria-hidden="true" />
    <p>{message}</p>
    <button type="button" className="icon-btn" aria-label="Dismiss error" onClick={onDismiss}><X size={16} aria-hidden="true" /></button>
  </div>;
}

/**
 * Scrolls `container` so the first marked passage inside it sits in view, once
 * for each `key`. The page text layers render after the page itself, so this
 * waits for the mark to appear.
 */
export function useRevealMark(container: RefObject<HTMLElement | null>, key: string | null) {
  useEffect(() => {
    const host = container.current;
    if (!host || key === null) return;
    function reveal(): boolean {
      const mark = host!.querySelector<HTMLElement>(".evidence-match");
      if (!mark) return false;
      const offset = mark.getBoundingClientRect().top - host!.getBoundingClientRect().top + host!.scrollTop;
      host!.scrollTo({ top: Math.max(0, offset - host!.clientHeight / 3) });
      return true;
    }
    if (reveal()) return;
    const observer = new MutationObserver(() => { if (reveal()) observer.disconnect(); });
    observer.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    const timeout = window.setTimeout(() => observer.disconnect(), 10_000);
    return () => {
      observer.disconnect();
      window.clearTimeout(timeout);
    };
  }, [container, key]);
}
