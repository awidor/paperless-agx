import { expect, test } from "bun:test";
import { initialQuery, readUrlState, writeUrlState } from "./url";

test("round-trips a search, filters, sort, view, and selected page", () => {
  const url = new URL("https://paper.test/?q=%22annual+bill%22&sender=ACME&from=2024-02-29&to=2024-03-01&sort=title_asc&view=list&document=42&document_page=3#current");
  const parsed = readUrlState(url.searchParams);
  expect(parsed).toEqual({
    search: '"annual bill"', view: "list",
    query: { ...initialQuery, sender: "ACME", createdFrom: "2024-02-29", createdTo: "2024-03-01", sort: "title_asc" },
    selected: { id: 42, page: 3 },
  });
  expect(writeUrlState(new URL(url), parsed).href).toBe(url.href);
});

test("uses defaults for invalid params and preserves unrelated query and hash", () => {
  const url = new URL("https://paper.test/?keep=yes&q=++&page=-3&sort=constructor&view=unknown&from=2026-02-29&to=2024-04-31&document=9007199254740992&document_page=12#current");
  const parsed = readUrlState(url.searchParams);
  expect(parsed).toEqual({ search: "", view: "grid", query: initialQuery, selected: null });
  expect(writeUrlState(url, parsed).href).toBe("https://paper.test/?keep=yes#current");
  expect(readUrlState(new URLSearchParams("document=3&document_page=3.5")).selected).toEqual({ id: 3, page: 1 });
});
