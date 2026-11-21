import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { fitTextBlocks, parseReplicaBlocks } from "./replica";

function documentForTest() {
  return new Window().document as unknown as Document;
}

test("copies only safe markup and text, excluding active content and attributes", () => {
  const document = documentForTest();
  const [block] = parseReplicaBlocks(`
    <div data-bbox="10 10 500 100" data-label="Text">
      <p id="stolen" style="color: red" onclick="alert(1)">Readable <b>bold</b> <a href="javascript:alert(1)">anchor text</a></p>
      <script data-bbox="10 10 20 20">excluded script</script>
      <iframe src="example"><div data-bbox="10 10 20 20">excluded iframe</div></iframe>
      <svg><text>excluded SVG</text></svg>
      <img src="example" onerror="alert(1)">
      <form><input type="text" value="excluded form"></form>
      <input type="checkbox" checked onchange="alert(1)">
    </div>
  `, document);
  const container = document.createElement("article");
  container.append(block.content);
  expect(Array.from(container.querySelectorAll("*"), (node) => node.tagName)).toEqual(["P", "STRONG", "SPAN"]);
  expect(container.querySelector("p")?.attributes.length).toBe(0);
  expect(container.querySelector(".digital-checkbox.checked")?.getAttribute("aria-hidden")).toBe("true");
  expect(block.text.trim()).toBe("Readable bold anchor text");
});

test("keeps outermost valid boxes and copies safe table spans", () => {
  const document = documentForTest();
  const blocks = parseReplicaBlocks(`
    <main>
      <div data-bbox="-10 100 1010 200" data-label="Table">
        <table><tr><th colspan="2" rowspan="003" data-bbox="10 10 20 20">Heading</th>
        <td colspan="1.1" rowspan="9007199254740993">Body</td><td colspan="1001" rowspan="65535">Tail</td></tr></table>
      </div>
      <div data-bbox="10 10 Infinity 20">invalid</div>
      <div data-bbox="50 20 20 21">inverted</div>
      <p data-bbox="200 180 210 190">Paragraph</p>
    </main>
  `, document);
  expect(blocks.map((block) => block.bbox)).toEqual([[0, 100, 1000, 200], [200, 180, 210, 190]]);
  const fragment = blocks[0].content as DocumentFragment;
  expect(fragment.querySelector("th")?.getAttribute("colspan")).toBe("2");
  expect(fragment.querySelector("th")?.getAttribute("rowspan")).toBe("3");
  expect(fragment.querySelectorAll("td[colspan], td[rowspan], [data-bbox]").length).toBe(0);
});

test("fits multiple overflowing blocks in at most seven measurements each", () => {
  const document = documentForTest();
  const reads = [0, 0, 0];
  const limits = [5, 12, 30];
  const entries = limits.map((limit, index) => {
    const element = document.createElement("div");
    Object.defineProperties(element, {
      clientHeight: { value: 10 }, clientWidth: { value: 10 }, scrollWidth: { value: 10 },
      scrollHeight: { get() {
        reads[index] += 1;
        return parseFloat(element.style.fontSize) > limit ? 15 : 10;
      } },
    });
    return { element, size: 30 };
  });
  fitTextBlocks(entries);
  expect(reads).toEqual([7, 7, 1]);
  for (const [index, entry] of entries.entries()) {
    const size = parseFloat(entry.element.style.fontSize);
    expect(size).toBeLessThanOrEqual(limits[index]);
    expect(size).toBeGreaterThan(limits[index] - 0.5);
  }
});
