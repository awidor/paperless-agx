import { createEffect, onSettled, type Accessor } from "solid-js";

/** The theme's ease-out, for animations started from script. */
export const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";

export function motionAllowed(): boolean {
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** A ref for an image that fades onto its sheet once it has loaded. */
export function inkIn(image: HTMLImageElement) {
  const show = () => { image.dataset.inked = ""; };
  if (image.complete && image.currentSrc) show();
  else {
    image.addEventListener("load", show, { once: true });
    image.addEventListener("error", show, { once: true });
  }
}

/** A ref for a groove whose single thumb slides under the chosen option. */
export function createGrooveThumb(chosen: Accessor<string | number>) {
  let host: HTMLElement | undefined;
  function place() {
    if (!host) return;
    const option = host.querySelector<HTMLElement>('[aria-pressed="true"], [aria-selected="true"]');
    if (!option) {
      delete host.dataset.thumb;
      return;
    }
    host.style.setProperty("--thumb-x", `${option.offsetLeft}px`);
    host.style.setProperty("--thumb-y", `${option.offsetTop}px`);
    host.style.setProperty("--thumb-w", `${option.offsetWidth}px`);
    host.style.setProperty("--thumb-h", `${option.offsetHeight}px`);
    host.dataset.thumb = "";
  }
  createEffect(chosen, place, { defer: true, name: "place groove thumb" });
  onSettled(() => {
    if (!host) return;
    place();
    const observer = new ResizeObserver(place);
    observer.observe(host);
    return () => observer.disconnect();
  });
  return (element: HTMLElement) => { host = element; };
}
