import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { FileText, LoaderCircle, TriangleAlert, X } from "lucide-react";
import type { Document } from "./api";
import { stage } from "./format";
import { inkIn } from "./motion";

/** A page render of the document, or a blank sheet while there is none yet. */
export function Thumbnail({ document, page = 1, priority = false }: { document: Document; page?: number; priority?: boolean }) {
  const [missing, setMissing] = useState(false);
  if (missing) return <span className="sheet__blank" aria-hidden="true"><FileText size={20} /></span>;
  return <img
    ref={inkIn}
    className="doc-image ink"
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
 * Scrolls `container` so the marked evidence inside it sits in view, once
 * for each `key`. The page text layers render after the page itself, so this
 * waits for the mark to appear.
 */
export function useRevealMark(container: RefObject<HTMLElement | null>, key: string | null) {
  useEffect(() => {
    const host = container.current;
    if (!host || key === null) return;
    function reveal() {
      const marks = [...host!.querySelectorAll<HTMLElement>(".evidence-match")].map((mark) => mark.getBoundingClientRect());
      if (marks.length === 0) return;
      const origin = host!.getBoundingClientRect().top - host!.scrollTop;
      const top = Math.min(...marks.map((rect) => rect.top)) - origin;
      const bottom = Math.max(...marks.map((rect) => rect.bottom)) - origin;
      // All the marks in the middle of the view when they fit in it, the first a third of the way down when not.
      const target = bottom - top < host!.clientHeight * 0.8 ? (top + bottom) / 2 - host!.clientHeight / 2 : top - host!.clientHeight / 3;
      host!.scrollTo({ top: Math.max(0, target) });
    }
    // The page and its marks settle over a few renders, so the view follows them until the reader moves it.
    reveal();
    const observer = new MutationObserver(() => { reveal(); });
    observer.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style"] });
    const stop = () => observer.disconnect();
    const timeout = window.setTimeout(stop, 4000);
    host.addEventListener("wheel", stop, { once: true, passive: true });
    host.addEventListener("touchstart", stop, { once: true, passive: true });
    host.addEventListener("pointerdown", stop, { once: true });
    host.addEventListener("keydown", stop, { once: true });
    return () => {
      stop();
      window.clearTimeout(timeout);
      host.removeEventListener("wheel", stop);
      host.removeEventListener("touchstart", stop);
      host.removeEventListener("pointerdown", stop);
      host.removeEventListener("keydown", stop);
    };
  }, [container, key]);
}
