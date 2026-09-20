/**
 * Editorial audit for the card library.
 *
 * Run with `node scripts/cardAudit.mjs`. Blocking rules - pack counts of 60 / 50 / 45,
 * unique ids, no duplicate or reversed endpoint pairs, no reused endpoint words and five
 * distinct examples per card - decide the exit code. Reused example text is reported as an
 * editorial backlog instead: it is a wording improvement, not a defect, and reviewing every
 * anchor still needs a human. Playtest evidence is not something this script can supply.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(resolve(root, "server/data/cards.ts"), "utf8");
const expectedCounts = { core: 60, "daily-life": 50, entertainment: 45 };

// Only the three row arrays are card data; the suitability sets reuse card ids and would
// otherwise look like duplicate rows.
const rowSections = ["coreRows", "dailyRows", "entertainmentRows"].map((name) => {
  const start = source.indexOf(`const ${name}`);
  const end = source.indexOf("\n];", start);
  return source.slice(start, end);
});
const rows = rowSections.flatMap((section) =>
  [...section.matchAll(/\[\s*"([a-z-]+-\d+)",\s*"([^"]+)",\s*"([^"]+)"/g)].map((match) => ({
    id: match[1],
    left: match[2],
    right: match[3],
  })),
);

const problems = {
  duplicateIds: [],
  duplicateEndpointPairs: [],
  reversedEndpointPairs: [],
  repeatedEndpoints: [],
};

const byId = new Map();
for (const row of rows) {
  if (byId.has(row.id)) problems.duplicateIds.push(row.id);
  byId.set(row.id, row);
}

const byPair = new Map();
for (const row of rows) {
  const pair = `${row.left}|${row.right}`;
  if (byPair.has(pair)) problems.duplicateEndpointPairs.push([byPair.get(pair), row.id, pair]);
  byPair.set(pair, row.id);
}

for (const row of rows) {
  const reversed = `${row.right}|${row.left}`;
  const other = byPair.get(reversed);
  if (other && other !== row.id) problems.reversedEndpointPairs.push([row.id, other, reversed]);
}

const endpointUse = new Map();
for (const row of rows) {
  for (const endpoint of [row.left, row.right]) {
    endpointUse.set(endpoint, (endpointUse.get(endpoint) ?? 0) + 1);
  }
}
problems.repeatedEndpoints = [...endpointUse.entries()]
  .filter(([, count]) => count > 1)
  .sort((first, second) => second[1] - first[1]);

const counts = {};
for (const row of rows) {
  const pack = row.id.replace(/-\d+$/, "");
  counts[pack] = (counts[pack] ?? 0) + 1;
}

const anchors = [
  ...rowSections.join("\n").matchAll(/\[\s*"([a-z-]+-\d+)",\s*"[^"]+",\s*"[^"]+",\s*\[([^\]]*)\]/g),
]
  .map((match) => ({
    id: match[1],
    anchors: [...match[2].matchAll(/"([^"]+)"/g)].map((anchor) => anchor[1]),
  }))
  .filter((entry) => entry.anchors.length !== 5 || new Set(entry.anchors).size !== 5);

const anchorUse = new Map();
for (const match of rowSections
  .join("\n")
  .matchAll(/\[\s*"([a-z-]+-\d+)",\s*"[^"]+",\s*"[^"]+",\s*\[([^\]]*)\]/g)) {
  for (const anchor of [...match[2].matchAll(/"([^"]+)"/g)]) {
    const text = anchor[1];
    anchorUse.set(text, [...(anchorUse.get(text) ?? []), match[1]]);
  }
}
const repeatedAnchors = [...anchorUse.entries()]
  .filter(([, owners]) => owners.length > 1)
  .sort((first, second) => second[1].length - first[1].length);

console.log(`cards: ${rows.length}`);
console.log(`packs: ${JSON.stringify(counts)} (expected ${JSON.stringify(expectedCounts)})`);
console.log(`duplicate ids: ${JSON.stringify(problems.duplicateIds)}`);
console.log(`duplicate endpoint pairs: ${JSON.stringify(problems.duplicateEndpointPairs)}`);
console.log(`reversed endpoint pairs: ${JSON.stringify(problems.reversedEndpointPairs)}`);
console.log(`reused endpoint words: ${JSON.stringify(problems.repeatedEndpoints)}`);
console.log(`cards without five distinct anchors: ${JSON.stringify(anchors)}`);
console.log(
  `editorial backlog - example texts reused across cards (${repeatedAnchors.length}): ${JSON.stringify(repeatedAnchors.map(([text, owners]) => [text, owners]))}`,
);
console.log("human review still required: endpoint wording quality and playtest evidence");
const countMismatch = Object.entries(expectedCounts).some(
  ([pack, expected]) => counts[pack] !== expected,
);
const failed =
  countMismatch ||
  problems.duplicateIds.length ||
  problems.duplicateEndpointPairs.length ||
  problems.reversedEndpointPairs.length ||
  problems.repeatedEndpoints.length ||
  anchors.length;
process.exitCode = failed ? 1 : 0;
