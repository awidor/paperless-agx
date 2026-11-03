// Fetches General Sans from Fontshare into public/fonts for this installation.
// The ITF Free Font License lets each installation self-host its own copy but
// forbids redistributing the files, so they are downloaded here and never
// committed. Without them the interface falls back to the system sans.
import { existsSync, mkdirSync } from "node:fs";

const WEIGHTS = [400, 500, 600];
const CSS_URL = `https://api.fontshare.com/v2/css?f[]=general-sans@${WEIGHTS.join(",")}&display=swap`;
const directory = new URL("../public/fonts/", import.meta.url);
const target = (weight: number) => new URL(`general-sans-${weight}.woff2`, directory);

if (WEIGHTS.every((weight) => existsSync(target(weight)))) process.exit(0);

try {
  const css = await (await fetch(CSS_URL)).text();
  const faces = [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map((match) => match[1]);
  mkdirSync(directory, { recursive: true });
  for (const weight of WEIGHTS) {
    const face = faces.find((body) => new RegExp(`font-weight:\\s*${weight}\\b`).test(body));
    const source = face?.match(/url\('([^']+\.woff2)'\)/)?.[1];
    if (!source) throw new Error(`no woff2 for weight ${weight}`);
    const response = await fetch(source.startsWith("//") ? `https:${source}` : source);
    if (!response.ok) throw new Error(`${response.status} for weight ${weight}`);
    await Bun.write(target(weight), response);
  }
  console.log("Fetched General Sans from Fontshare.");
} catch (cause) {
  console.warn(`General Sans could not be fetched (${cause instanceof Error ? cause.message : cause}); the interface uses the system sans.`);
}
