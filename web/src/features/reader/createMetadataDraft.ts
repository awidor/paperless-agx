import { createSignal, type Accessor } from "solid-js";

type Draft = { saved: string; value: string };

/** A new server answer updates untouched fields and keeps any local edit. */
export function createMetadataDraft(source: Accessor<string>, name: string) {
  const [draft, write] = createSignal<Draft>((previous) => {
    const saved = source();
    return { saved, value: previous && previous.value !== previous.saved ? previous.value : saved };
  }, { name });
  return {
    get value() { return draft().value; },
    dirty: () => draft().value !== draft().saved,
    set: (value: string) => write((previous) => ({ saved: previous.saved, value })),
    commit: (value: string) => write({ saved: value, value }),
  };
}
