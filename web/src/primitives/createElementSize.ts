import { createSignal, onSettled } from "solid-js";

export type ElementSize = { width: number; height: number };

export function createElementSize(options: { threshold?: number; minWidth?: number; widthOnly?: boolean } = {}) {
  const { threshold = 2, minWidth = 1, widthOnly = false } = options;
  const [size, setSize] = createSignal<ElementSize | undefined>(undefined, { name: "element size" });
  let element: HTMLElement | undefined;

  onSettled(() => {
    if (!element) return;
    const { clientWidth: width, clientHeight: height } = element;
    if (width >= minWidth && (widthOnly || height >= 1)) setSize({ width, height });
    let frame = 0;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width < minWidth || (!widthOnly && height < 1)) return;
      cancelAnimationFrame(frame);
      // A viewer can change its host's height when it paints. Publish outside
      // ResizeObserver delivery so those changes cannot recurse in the same frame.
      frame = requestAnimationFrame(() => {
        setSize((previous) => previous && Math.abs(previous.width - width) < threshold
          && (widthOnly || Math.abs(previous.height - height) < threshold) ? previous : { width, height });
      });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  });

  return { size, ref: (next: HTMLElement) => { element = next; } };
}
