import { useLayoutEffect, useState } from "react";

/** The theme's ease-out, for animations started from script. */
export const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";

/** Script-driven animations ask this at the moment they would start; CSS ones follow the media query on their own. */
export function motionAllowed(): boolean {
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * A ref for an `.ink` image: it fades onto its sheet once it has loaded
 * instead of popping in. An image already in the cache shows at once, and
 * one that fails shows as it would without the fade.
 */
export function inkIn(image: HTMLImageElement | null) {
  if (!image) return;
  const show = () => { image.dataset.inked = ""; };
  if (image.complete) show();
  else {
    image.addEventListener("load", show, { once: true });
    image.addEventListener("error", show, { once: true });
  }
}

/**
 * A ref for a `.groove`: one thumb slides under whichever option is chosen,
 * instead of each option lighting up on its own. `chosen` names the current
 * choice so the thumb follows it.
 */
export function useGrooveThumb(chosen: string) {
  const [groove, setGroove] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!groove) return;
    const host = groove;
    function place() {
      const option = host.querySelector<HTMLElement>('[aria-pressed="true"], [aria-selected="true"]');
      if (!option) {
        delete host.dataset.thumb;
        return;
      }
      host.style.setProperty("--thumb-x", `${option.offsetLeft}px`);
      host.style.setProperty("--thumb-y", `${option.offsetTop}px`);
      host.style.setProperty("--thumb-w", `${option.offsetWidth}px`);
      host.style.setProperty("--thumb-h", `${option.offsetHeight}px`);
      // The thumb is drawn from here on; it appears in place and only later moves.
      host.dataset.thumb = "";
    }
    place();
    const observer = new ResizeObserver(place);
    observer.observe(host);
    return () => observer.disconnect();
  }, [groove, chosen]);
  return setGroove;
}
