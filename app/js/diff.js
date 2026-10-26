// Word-level comparison used for the red-pen corrections and for "how much of your reading was understood".
import { h, str } from "./util.js";

export const tokens = (s) => str(s).split(/\s+/).filter(Boolean);
export const normTok = (w) => w.toLowerCase().replace(/[\u2019\u2018]/g, "'").replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "").replace(/'/g, "");
export const sameWords = (a, b) => tokens(a).map(normTok).filter(Boolean).join(" ") === tokens(b).map(normTok).filter(Boolean).join(" ");
// True when two snippets differ only in punctuation, apostrophes or capitalization.
export const looseEqual = (a, b) => str(a).toLowerCase().replace(/[^a-z0-9]/g, "") === str(b).toLowerCase().replace(/[^a-z0-9]/g, "");

// ops: ["eq" | "del" | "ins", word]; "del" = only in a, "ins" = only in b. Comparison ignores case and punctuation.
export function diffOps(a, b) {
  const A = tokens(a).filter((w) => normTok(w)), B = tokens(b);
  const nA = A.map(normTok), nB = B.map(normTok);
  const n = A.length, m = B.length;
  if (n * m > 40000) return B.map((w) => ["eq", w]);
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = nA[i] === nB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && nA[i] === nB[j]) { ops.push(["eq", B[j]]); i++; j++; }
    else if (j < m && !nB[j]) { ops.push(["eq", B[j]]); j++; }
    else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) { ops.push(["del", A[i]]); i++; }
    else { ops.push(["ins", B[j]]); j++; }
  }
  return ops;
}

// Red-pen view: words to remove struck through, words to add underlined.
export function diffFragment(a, b) {
  const frag = document.createDocumentFragment();
  diffOps(a, b).forEach(([kind, w], k) => {
    if (k) frag.append(" ");
    frag.append(kind === "eq" ? w : h(kind, null, w));
  });
  return frag;
}

// Reading check: how many target words the recognizer heard, with the missed ones marked.
export function readingMatch(target, heard) {
  const ops = diffOps(heard, target);
  const total = tokens(target).filter((w) => normTok(w)).length || 1;
  const hit = ops.filter(([kind, w]) => kind === "eq" && normTok(w)).length;
  const missed = ops.filter(([kind, w]) => kind === "ins" && normTok(w)).map(([, w]) => w);
  const frag = document.createDocumentFragment();
  let first = true;
  for (const [kind, w] of ops) {
    if (kind === "del") continue;
    if (!first) frag.append(" ");
    first = false;
    frag.append(kind === "ins" ? h("mark", { class: "miss" }, w) : w);
  }
  return { hit, total, score: Math.round((100 * hit) / total), missed, frag };
}
