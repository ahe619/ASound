// A separate, pinned dictionary: study-deck membership never limits lookup.
export const normalizeQuery = text => String(text || "").normalize("NFKC").toLowerCase().replace(/[‘’]/g, "'").trim().replace(/\s+/g, " ");
export const shardKey = text => (normalizeQuery(text) + "__").slice(0, 2).replace(/[^a-z]/g, "_");
const root = new URL("../dictionary/", import.meta.url);
let indexPromise;
const cache = new Map();
async function read(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error("Dictionary unavailable");
    const data = await response.json();
    if (data.schemaVersion !== 1) throw new Error("Dictionary version mismatch");
    return data;
  } finally { clearTimeout(timeout); }
}
export function dictionaryInfo() {
  if (!indexPromise) indexPromise = read(new URL("index.json", root)).catch(error => { indexPromise = null; throw error; });
  return indexPromise;
}
export function nearby(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let before = Array.from({length:b.length + 1}, (_, i) => i);
  let previous;
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(row[j-1]+1, before[j]+1, before[j-1]+(a[i-1] !== b[j-1]));
      if (i > 1 && j > 1 && a[i-1] === b[j-2] && a[i-2] === b[j-1]) row[j] = Math.min(row[j], previous[j-2]+1);
    }
    if (Math.min(...row) > 2) return 3;
    previous = before; before = row;
  }
  return before[b.length];
}
export async function lookup(query) {
  const term = normalizeQuery(query);
  if (!term || term.length > 160) return { entries:[], suggestions:[] };
  const info = await dictionaryInfo(), key = shardKey(term);
  if (!Object.hasOwn(info.shards, key)) return {entries:[], suggestions:[]};
  if (!cache.has(key)) {
    const task = read(new URL(`shards/${key}.json`, root)).then(data => {
      if (!Array.isArray(data.entries)) throw new Error("Invalid dictionary shard");
      return data.entries;
    }).catch(error => { cache.delete(key); throw error; });
    cache.set(key, task);
    // Keep at most four shards in memory on phones. The service worker can retain visited shards offline.
    if (cache.size > 4) cache.delete(cache.keys().next().value);
  }
  const rows = await cache.get(key);
  const exact = rows.filter(row => normalizeQuery(row[0]) === term);
  exact.sort((a,b) => Number(b[0] === query.trim()) - Number(a[0] === query.trim()));
  if (exact.length) return {entries:exact.map(([word,ipa,meaning,english,exchange]) => ({word,ipa,meaning,english,exchange})),suggestions:[]};
  const suggestions = rows.map(row => ({word:row[0], normalized:normalizeQuery(row[0]), rank:row[5] || 999999}))
    .filter(row => row.normalized.startsWith(term) || Math.abs(row.normalized.length-term.length) <= 2)
    .map(row => ({...row, score:row.normalized.startsWith(term) ? 0 : nearby(term,row.normalized)}))
    .filter(row => row.score <= 2).sort((a,b) => a.score-b.score || a.rank-b.rank || a.word.length-b.word.length);
  return {entries:[], suggestions:[...new Set(suggestions.map(row => row.word))].slice(0,8)};
}
export function inflections(exchange) {
  const supported = new Set(["p","d","i","3","s","r","t","0"]);
  return String(exchange || "").split("/").flatMap(item => {
    const [kind, terms] = item.split(":");
    return supported.has(kind) ? (terms || "").split(",").filter(Boolean).map(term => ({kind,term})) : [];
  });
}
