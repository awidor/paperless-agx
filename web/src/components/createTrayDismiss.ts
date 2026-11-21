import { createEffect, createSignal, type Accessor } from "solid-js";
import { motionAllowed } from "../primitives/motion";

export function createTrayDismiss(settled: Accessor<boolean>, delay: number, dismiss: () => void) {
  const [hovered, hover] = createSignal(false);
  const [focused, focus] = createSignal(false);
  const [leaving, setLeaving] = createSignal(false, { name: "tray dismissing" });
  function leave() {
    if (motionAllowed()) setLeaving(true);
    else dismiss();
  }
  createEffect(
    () => settled() && !hovered() && !focused(),
    (autoDismiss) => {
      if (!autoDismiss) return;
      const timer = window.setTimeout(leave, delay);
      return () => window.clearTimeout(timer);
    },
    { name: "tray dwell" },
  );
  return {
    leaving,
    leave,
    onPointerEnter: () => hover(true),
    onPointerLeave: () => hover(false),
    onFocusIn: () => focus(true),
    onFocusOut: (event: FocusEvent & { currentTarget: HTMLElement }) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) focus(false);
    },
    onAnimationEnd: (event: AnimationEvent) => {
      if (event.target === event.currentTarget && event.animationName === "tray-out") dismiss();
    },
  };
}
