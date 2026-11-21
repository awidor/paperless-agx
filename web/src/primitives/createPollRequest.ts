import { onCleanup } from "solid-js";

/** Timer ticks only re-ask an idle source. A new query or explicit refresh can still replace it. */
export function createPollRequest() {
  let active: AbortController | undefined;

  async function load<T>(request: (controller: AbortController) => Promise<T>): Promise<T> {
    active?.abort();
    const controller = new AbortController();
    active = controller;
    onCleanup(() => controller.abort());
    try {
      return await request(controller);
    } finally {
      if (active === controller) active = undefined;
    }
  }

  return { load, pending: () => active !== undefined };
}
