import { evidenceTerms, frameEvidence, markBoxes, markedRuns, type Run } from "./evidenceHighlight";

function check(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

const terms = evidenceTerms("Der Verdienstnachweis für Februar 2026 nennt 379,98 € brutto, arbeitsunfähig seit 24.10.2025.");
check(terms.join("|") === "379,98|24.10.2025", `figures from a reason: ${terms.join("|")}`);

// A sick note's date fields, the way pdf.js splits a page into runs.
const form = ["Datum", "|24.10.2025", "arbeitsunfähig seit", "17.10.2025", "24.10.2025", "Krankenkasse"];
check([...markedRuns(form, ["24.10.2025"])].join() === "1,4", "every place the date reads is marked, nothing else");
check(markedRuns(["Beitragsnummer", "285", "334", "268"], ["285 334 268"]).size === 3, "a quoted number split over runs");
check(markedRuns(["Mandatsreferenz 2853342682501"], ["285 334 268"]).size === 0, "a number inside a longer number");
check(markedRuns(["Datum 10.10.2025 17.10.2025"], ["17.10.2025"]).size === 1, "a date beside another date in one block");
check(markedRuns(form, ["Unfallkasse"]).size === 0, "unrelated text stays unmarked");
// The scan prints 07.11.2025, but its text layer lost the year.
check([...markedRuns(["bis einschließlich", "07.11.", "3)"], ["07.11.2025"])].join() === "1", "a date whose year the text lost");
check(markedRuns(["07.11.2024"], ["07.11.2025"]).size === 0, "the same day of another year");

// A letter: the label and number at the top right, the same number again far down in the subject line.
const letter: Run[] = [
  { text: "Datum 14.03.2025", box: [0.64, 0.20, 0.78, 0.21] },
  { text: "Beitragsnummer", box: [0.64, 0.22, 0.75, 0.23] },
  { text: "285 334 268", box: [0.76, 0.22, 0.84, 0.23] },
  { text: "Beitragsnummer 285 334 268", box: [0.10, 0.45, 0.40, 0.46] },
];
const groups = markBoxes(letter, ["285 334 268"]);
check(groups.length === 1 && groups[0].length === 2, "both places of the number are outlined");
const shape = { width: 0.36, minAspect: 1.5, maxAspect: 3.2 };
const frame = frameEvidence(groups, letter.map((run) => run.box), 0.707, shape);
check(frame.marks.length === 1, "one tight window, not two distant marks with blank paper between them");
check(frame.x < 0.64 && frame.x > 0.55, `the frame starts where the marked line does, label included: ${frame.x.toFixed(3)}`);
check(frame.y + frame.height < 0.45, "the second place stays out of the frame");

// The same letter as a scan: a line of type every 2% of the page, with the number's line among them.
const width = 200;
const height = 283;
const data = new Uint8Array(width * height);
const typeRows: [number, number][] = [];
for (let top = 0.1; top < 0.5; top += 0.02) typeRows.push([Math.round(top * height), Math.round(top * height) + 2]);
for (const [top, bottom] of typeRows) for (let y = top; y < bottom; y += 1) for (let x = 20; x < 180; x += 1) data[y * width + x] = 255;
const snapped = frameEvidence(groups, letter.map((run) => run.box), 0.707, shape, { width, height, data });
const top = snapped.y * height;
const bottom = (snapped.y + snapped.height) * height;
check(typeRows.every(([lineTop, lineBottom]) => (top <= lineTop || top >= lineBottom) && (bottom <= lineTop || bottom >= lineBottom)), `the frame's edges stop on blank paper, never through a line: ${top.toFixed(1)}-${bottom.toFixed(1)}`);
const firstLine = typeRows.find(([lineTop]) => lineTop >= top)!;
check(firstLine[0] - top >= 0.9, `blank paper above the first framed line: ${(firstLine[0] - top).toFixed(1)}`);
check(snapped.marks.length === 1 && Math.abs(snapped.width - 0.36) < 1e-9, "the evidence stays in a frame of the shape's width");

// Every strip in a list shows the paper at one scale, wherever its evidence sits.
const far = frameEvidence(markBoxes(letter, ["Beitragsnummer 285"]), letter.map((run) => run.box), 0.707, shape);
check(Math.abs(far.width - frame.width) < 1e-9, "two frames of one shape are equally wide");

const empty = frameEvidence([], letter.map((run) => run.box), 0.707, shape);
check(empty.marks.length === 0 && empty.y < 0.21, "with nothing to mark, the head of the page");
