import { createEffect, type Accessor } from "solid-js";

/** Follows the evidence while a page is rendering, until the reader moves the view. */
export function createRevealMark(container: () => HTMLElement | undefined, key: Accessor<string | null>) {
  createEffect(key, (value) => {
    const host = container();
    if (!host || value === null) return;
    let frame = 0;
    function reveal() {
      frame = 0;
      if (!host) return;
      const marks = host.querySelectorAll<HTMLElement>(".evidence-match");
      if (!marks.length) return;
      let top = Infinity;
      let bottom = -Infinity;
      for (const mark of marks) {
        const rect = mark.getBoundingClientRect();
        top = Math.min(top, rect.top);
        bottom = Math.max(bottom, rect.bottom);
      }
      const origin = host.getBoundingClientRect().top - host.scrollTop;
      const height = host.clientHeight;
      const target = bottom - top < height * 0.8 ? (top + bottom - height) / 2 : top - height / 3;
      host.scrollTo({ top: Math.max(0, target - origin) });
    }
    const observer = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(reveal);
    });
    observer.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style"] });
    reveal();

    const controller = new AbortController();
    function stop() {
      observer.disconnect();
      cancelAnimationFrame(frame);
      controller.abort();
    }
    const timeout = window.setTimeout(stop, 4_000);
    for (const type of ["wheel", "touchstart", "pointerdown", "keydown"]) {
      host.addEventListener(type, stop, { signal: controller.signal, passive: true });
    }
    return () => {
      window.clearTimeout(timeout);
      stop();
    };
  }, { name: "reveal evidence" });
}
