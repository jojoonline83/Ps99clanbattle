// Merge display names: node merge-names.mjs <from.json> <into.json>
// Keeps real names already in <into>, fills missing or numeric-only entries from <from>.
import { readFileSync, writeFileSync } from 'node:fs';

const [fromFile, intoFile] = process.argv.slice(2);
const read = f => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch (_) { return {}; } };
const from = read(fromFile);
const into = read(intoFile);
let added = 0;
for (const [uid, name] of Object.entries(from)) {
    if (!into[uid] || (into[uid] === uid && name !== uid)) { into[uid] = name; added++; }
}
writeFileSync(intoFile, JSON.stringify(into));
console.log(`merge-names: ${added} added, ${Object.keys(into).length} total.`);
