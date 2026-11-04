/**
 * Finding the evidence on a page, and the window of the page that shows it.
 *
 * A search names what it found in words: the exact text the owner quoted, or
 * the agent's one-line reason ("arbeitsunfähig seit 24.10.2025 bis
 * voraussichtlich 07.11.2025"). The figures in that line are what can be
 * pointed at on the paper, so those are the terms, and a piece of page text is
 * marked only where a whole term reads in it.
 */

/** A box on the page as fractions of its width and height: [left, top, right, bottom]. */
export type Box = [number, number, number, number];
/** A piece of page text where the page prints it: a PDF text run, or an OCR block. */
export type Run = { text: string; box: Box };

/** Lower case, with every run of spacing and punctuation as one space: "24.10.2025" reads as "24 10 2025". */
function normalized(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const FIGURE = /\d+(?:[.,:/-]\d+)*/g;
const FULL_DATE = /^(\d{1,2}[./]\d{1,2})[./]\d{2,4}$/;

/**
 * The figures in a sentence that are specific enough to find on a page: dates,
 * amounts and reference numbers. A bare year or a short count would mark every
 * date of that year, so a figure needs five digits, or four with a separator.
 */
export function evidenceTerms(sentence: string | null | undefined): string[] {
  const terms = new Set<string>();
  for (const [figure] of (sentence ?? "").matchAll(FIGURE)) {
    const digits = figure.replace(/\D/g, "").length;
    if (digits >= 5 || (digits >= 4 && /[.,:/-]/.test(figure))) terms.add(figure);
  }
  return [...terms];
}

/** Where a term reads: its runs, and how much wider than them the printed term is when the text lost part of it. */
export type RunMatch = { term: number; runs: number[]; stretch?: number };

/**
 * Where the terms read in `runs`, the text pieces of a page in reading order.
 * A term may span neighbouring runs ("285", "334", "268"), but never starts or
 * ends inside a number: "10.10.2025" is not found in "110.10.2025". A date the
 * page's text lost its year from ("07.11." where the scan prints 07.11.2025) is
 * found by its day and month, as long as no other year follows them.
 */
export function matchRuns(runs: string[], terms: string[]): RunMatch[] {
  let text = "";
  const owner: number[] = [];
  runs.forEach((run, index) => {
    const clean = normalized(run);
    if (!clean) return;
    if (text) {
      text += " ";
      owner.push(-1);
    }
    text += clean;
    for (let i = 0; i < clean.length; i += 1) owner.push(index);
  });
  const digit = (at: number) => at >= 0 && at < text.length && /\p{N}/u.test(text[at]);
  const find = (needle: string, term: number, yearless: boolean): RunMatch[] => {
    const found: RunMatch[] = [];
    for (let at = text.indexOf(needle); needle && at >= 0; at = text.indexOf(needle, at + 1)) {
      const end = at + needle.length;
      if ((digit(at) && digit(at - 1)) || (digit(end - 1) && digit(end))) continue;
      // Day and month alone: the next word must not be a year of its own.
      if (yearless && /^ (\d{2}|\d{4})(?!\p{N})/u.test(text.slice(end))) continue;
      found.push({ term, runs: [...new Set(owner.slice(at, end).filter((index) => index >= 0))], ...(yearless ? { stretch: (terms[term].trim().length + 0.5) / (needle.length + 1) } : {}) });
    }
    return found;
  };
  return terms.flatMap((term, index) => {
    const whole = find(normalized(term), index, false);
    const dayMonth = whole.length === 0 ? FULL_DATE.exec(term.trim())?.[1] : undefined;
    return dayMonth ? find(normalized(dayMonth), index, true) : whole;
  });
}

/** The indexes of every run that holds part of a term. */
export function markedRuns(runs: string[], terms: string[] | undefined): Set<number> {
  if (!terms?.length) return new Set();
  return new Set(matchRuns(runs, terms).flatMap((match) => match.runs));
}

function union(boxes: Box[]): Box {
  return boxes.reduce<Box>((all, box) => [Math.min(all[0], box[0]), Math.min(all[1], box[1]), Math.max(all[2], box[2]), Math.max(all[3], box[3])], [Infinity, Infinity, -Infinity, -Infinity]);
}

/** One box per line of a match: the words of "285 334 268" are outlined together, not one by one. */
function lines(boxes: Box[]): Box[] {
  const merged: Box[] = [];
  for (const box of [...boxes].sort((a, b) => a[1] - b[1] || a[0] - b[0])) {
    const last = merged.at(-1);
    const overlap = last ? Math.min(last[3], box[3]) - Math.max(last[1], box[1]) : 0;
    if (last && overlap > 0.5 * Math.min(last[3] - last[1], box[3] - box[1])) merged[merged.length - 1] = union([last, box]);
    else merged.push([...box]);
  }
  return merged;
}

/** A block taller than this share of the page is a form or a column; outlining it points at nothing. */
const MARKABLE_HEIGHT = 0.05;

/**
 * The outlines for each term found in `runs`: one box per line of each place
 * it reads, with a little room around the type that stays clear of the lines
 * above and below. Every list holds the places of one term.
 */
export function markBoxes(runs: Run[], terms: string[] | undefined): Box[][] {
  if (!terms?.length) return [];
  const groups: Box[][] = terms.map(() => []);
  for (const match of matchRuns(runs.map((run) => run.text), terms)) {
    const found = lines(match.runs.map((index) => runs[index].box));
    // A date whose year the text lost still prints it on the paper, just after the day and month.
    const last = found.at(-1);
    if (last && match.stretch) last[2] = last[0] + (last[2] - last[0]) * match.stretch;
    for (const box of found) {
      const height = box[3] - box[1];
      if (height > MARKABLE_HEIGHT) continue;
      groups[match.term].push([box[0] - height * 0.3, box[1] - height * 0.12, box[2] + height * 0.3, box[3] + height * 0.12]);
    }
  }
  return groups.filter((group) => group.length > 0);
}


/**
 * How a frame is cut: its width as a share of the page, the same for every
 * strip in a list so they all show the paper at one scale, and the range of its
 * width over its height, which sets how many lines it may hold.
 */
export type FrameShape = { width: number; minAspect: number; maxAspect: number };
/** The page render as darkness, one byte per pixel from 0 (paper) to 255 (black), scaled to `width` pixels across. */
export type Ink = { width: number; height: number; data: Uint8Array };
/** The part of the page in the frame, as fractions of the page, and the outlines inside it. */
export type Frame = { x: number; y: number; width: number; height: number; marks: Box[] };

/** Room around the evidence, in page widths: lines read from the left, and labels sit above their values. */
const PAD_X = 0.03;
const PAD_ABOVE = 0.05;
const PAD_BELOW = 0.025;
/** Marks further apart than this would leave a band of blank paper between them, so they are not framed together. */
const GAP = 0.06;
/** Words this close continue the same line, so a label is framed with its value, even across a form field. */
const WORD_GAP = 0.14;
const NUDGE = 0.006;
/** How far the frame may slide sideways to find blank paper for its edges, in page widths. */
const SLIDE = 0.06;
/** The narrowest blank between two words, in page widths; the gaps between letters are narrower. */
const WORD_SPACE = 0.005;
/** A pixel this dark (0 is paper, 255 black) is ink. */
const INK = 90;
/** A line further than this from the framed ones sits across blank paper, so the frame does not reach for it. */
const LINE_REACH = 0.05;
/** The room above the first framed line and below the last, at most, as a share of a line's height; and its bounds in page widths. */
const LINE_ROOM = 1;
const ROOM_MIN = 0.008;
const ROOM_MAX = 0.02;

type Line = { top: number; bottom: number };

/**
 * The window of the page around the evidence, `shape.width` of the page wide.
 * It frames one tight band of marks, the one naming the most different terms
 * (the earliest when several do), never two distant marks with paper between
 * them. Its left edge starts where the marked line starts, so the label before
 * a figure shows, and the rest of its width runs on to the right, the way the
 * line reads.
 *
 * Given the page's ink, it holds whole lines only: it grows by the nearest
 * line above or below until it reaches its proportions, never across a band of
 * blank paper, and leaves up to a line's height of paper above the first line
 * and below the last. Its sides slide onto the blank between words. With
 * nothing to mark, it shows the head of the page: the letterhead, sender and
 * subject that make a letter recognisable.
 *
 * Works in page widths throughout: a box's vertical fractions are scaled by
 * the page's height over its width, and scaled back at the end.
 */
export function frameEvidence(groups: Box[][], runs: Box[], pageAspect: number, shape: FrameShape, ink?: Ink): Frame {
  const tall = 1 / pageAspect;
  const w = Math.min(1, shape.width);
  const toWidths = (box: Box): Box => [box[0], box[1] * tall, box[2], box[3] * tall];
  const marks = groups.flatMap((group, term) => group.map((box) => ({ term, box: toWidths(box) }))).sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0]);
  // Only line-sized text tells where a line starts; a whole form or table block spans everything.
  const words = runs.map(toWidths).filter((box) => box[3] - box[1] < 0.035 && box[2] - box[0] < 0.6);

  let focus: Box | null = null;
  let best = 0;
  for (const anchor of marks) {
    const picked = [anchor];
    const nearest = marks.filter((mark) => mark !== anchor).sort((a, b) => Math.abs(a.box[1] - anchor.box[1]) - Math.abs(b.box[1] - anchor.box[1]));
    for (const mark of nearest) {
      const band = union(picked.map((item) => item.box));
      const next = union([band, mark.box]);
      const gap = Math.max(mark.box[1] - band[3], band[1] - mark.box[3]);
      if (gap > GAP || next[2] - next[0] + 2 * PAD_X > w || next[3] - next[1] + PAD_ABOVE + PAD_BELOW > w / shape.minAspect) continue;
      picked.push(mark);
    }
    const score = new Set(picked.map((item) => item.term)).size;
    if (score > best) {
      best = score;
      focus = union(picked.map((item) => item.box));
    }
  }

  // Across: from where the marked lines start, on to the right.
  let lineStart: number;
  let y0: number;
  let y1: number;
  if (focus) {
    const [, top, right, bottom] = focus;
    let left = focus[0];
    // Walk left along the marked lines to where they start, while the frame can still hold them.
    for (;;) {
      const before = words.filter((box) => box[2] <= left + NUDGE && left - box[2] <= WORD_GAP && Math.min(box[3], bottom) - Math.max(box[1], top) > 0.5 * (box[3] - box[1]) && right - box[0] + 2 * PAD_X <= w);
      const step = before.reduce((min, box) => Math.min(min, box[0]), left);
      if (step >= left) break;
      left = step;
    }
    lineStart = left;
    y0 = top - PAD_ABOVE;
    y1 = bottom + PAD_BELOW;
  } else {
    // Nothing to point at: the head of the page, across its text.
    const text = words.length ? union(words) : ([0.08, 0.04, 0.92, 1] as Box);
    lineStart = text[0];
    y0 = text[1] - PAD_BELOW;
    y1 = y0;
  }
  let x0 = Math.max(0, Math.min(lineStart - PAD_X, 1 - w));

  // Down: as tall as the frame's proportions ask, the marks a little above the middle.
  const grow = w / shape.maxAspect - (y1 - y0);
  if (grow > 0) {
    y0 -= focus ? grow * 0.6 : 0;
    y1 += focus ? grow * 0.4 : grow;
  }
  const clampY = () => {
    const shift = Math.max(0, -y0) - Math.max(0, y1 - tall);
    y0 = Math.max(0, y0 + shift);
    y1 = Math.min(tall, y1 + shift);
  };
  clampY();

  if (ink) {
    const scale = ink.width;
    const rows = ink.height;
    const at = (x: number, y: number) => x >= 0 && y >= 0 && x < ink.width && y < rows && ink.data[y * ink.width + x] > INK;

    // A column inked down most of the neighbourhood is a ruled line of a form, not text.
    const ruled = (from: number, to: number) => {
      const start = Math.max(0, Math.round((focus ? focus[1] - 0.2 : y0) * scale));
      const end = Math.min(rows, Math.round((focus ? focus[3] + 0.2 : y0 + 0.4) * scale));
      const columns = new Set<number>();
      for (let x = from; x < to; x += 1) {
        let count = 0;
        for (let y = start; y < end; y += 1) if (at(x, y)) count += 1;
        if (count > 0.35 * (end - start)) columns.add(x);
      }
      return columns;
    };

    // The lines of type across the frame's width: runs of rows with ink, letting a dot or an umlaut join its line.
    const linesAcross = (): Line[] => {
      const from = Math.round(x0 * scale);
      const to = Math.round((x0 + w) * scale);
      const skip = ruled(from, to);
      const enough = Math.max(3, (to - from) * 0.01);
      const lines: Line[] = [];
      let blank = Infinity;
      for (let y = 0; y < rows; y += 1) {
        let count = 0;
        for (let x = from; x < to; x += 1) if (!skip.has(x) && at(x, y)) count += 1;
        if (count < enough) {
          blank += 1;
          continue;
        }
        const last = lines.at(-1);
        if (last && blank <= 2) last.bottom = y + 1;
        else lines.push({ top: y, bottom: y + 1 });
        blank = 0;
      }
      return lines.map((line) => ({ top: line.top / scale, bottom: line.bottom / scale }));
    };

    // The frame's sides slide together onto the blank between words, keeping the evidence and the line's start inside.
    const blankColumn = (x: number) => {
      const column = Math.round(x * scale);
      if (column <= 0 || column >= ink.width) return true;
      const half = Math.max(1, Math.round((WORD_SPACE * scale) / 2));
      for (let c = column - half; c <= column + half; c += 1) {
        let count = 0;
        for (let y = Math.round(y0 * scale); y < Math.round(y1 * scale); y += 1) if (at(c, y)) count += 1;
        if (count > 1) return false;
      }
      return true;
    };
    const slide = () => {
      const fits = (x: number, keepStart: boolean) => x >= 0 && x + w <= 1 + 1e-9 && (!focus || (x <= focus[0] && x + w >= focus[2])) && (!keepStart || x <= lineStart);
      for (const both of [true, false]) {
        for (const keepStart of [true, false]) {
          for (let step = 0; step <= SLIDE * scale; step += 1) {
            for (const direction of [-1, 1]) {
              const x = x0 + (direction * step) / scale;
              if (fits(x, keepStart) && blankColumn(x) && (!both || blankColumn(x + w))) return x;
            }
          }
        }
      }
      return x0;
    };

    for (let pass = 0; pass < 2; pass += 1) {
      x0 = slide();
      const lines = linesAcross();
      if (lines.length === 0) break;
      // The lines the evidence sits on, or for the head of the page, the first line of type.
      let first = focus ? lines.findIndex((line) => line.bottom > focus![1] && line.top < focus![3]) : lines.findIndex((line) => line.bottom > y0);
      if (first < 0) break;
      let last = first;
      if (focus) while (last + 1 < lines.length && lines[last + 1].top < focus[3]) last += 1;
      const held = { first, last };
      const heights = lines.slice(first, last + 1).map((line) => line.bottom - line.top).sort((a, b) => a - b);
      const room = Math.min(ROOM_MAX, Math.max(ROOM_MIN, heights[Math.floor(heights.length / 2)] * LINE_ROOM));
      const span = () => lines[last].bottom - lines[first].top + 2 * room;
      // Add the nearest line above or below until the frame is as tall as its proportions ask; labels sit above their values, so above wins a near tie.
      while (span() < w / shape.maxAspect) {
        const above = focus && first > 0 ? lines[first].top - lines[first - 1].bottom : Infinity;
        const below = last + 1 < lines.length ? lines[last + 1].top - lines[last].bottom : Infinity;
        const upward = above * 0.8 <= below;
        const gap = upward ? above : below;
        const grown = upward ? lines[last].bottom - lines[first - 1].top + 2 * room : lines[last + 1]?.bottom - lines[first].top + 2 * room;
        if (!(gap <= LINE_REACH) || grown > w / shape.minAspect) break;
        if (upward) first -= 1;
        else last += 1;
      }
      // A line at the frame's edge that sits closer to the type outside than to the type inside belongs to that, so it leaves the frame.
      const above = (index: number) => (index > 0 ? lines[index].top - lines[index - 1].bottom : Infinity);
      const below = (index: number) => (index + 1 < lines.length ? lines[index + 1].top - lines[index].bottom : Infinity);
      while (first < held.first && above(first) < 0.75 * below(first)) first += 1;
      while (last > held.last && below(last) < 0.75 * above(last)) last -= 1;
      const roomAbove = first > 0 ? Math.min(room, (lines[first].top - lines[first - 1].bottom) / 2) : Math.min(room, lines[first].top);
      const roomBelow = last + 1 < lines.length ? Math.min(room, (lines[last + 1].top - lines[last].bottom) / 2) : Math.min(room, tall - lines[last].bottom);
      y0 = lines[first].top - roomAbove;
      y1 = lines[last].bottom + roomBelow;
    }
  }

  const x1 = x0 + w;
  // A mark shows when most of it is in the frame; the outline of a line above or below must not poke in at the edge.
  const inside = (box: Box) => box[0] < x1 && box[2] > x0 && Math.min(box[3], y1) - Math.max(box[1], y0) > 0.6 * (box[3] - box[1]);
  const shown = marks.filter((mark) => inside(mark.box)).map((mark): Box => [mark.box[0], mark.box[1] / tall, mark.box[2], mark.box[3] / tall]);
  return { x: x0, y: y0 / tall, width: w, height: (y1 - y0) / tall, marks: shown };
}
