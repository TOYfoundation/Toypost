import type { Analysis, Deadline } from '../shared.ts';
import type { CaseCandidate } from './provider.ts';

/** Ordnet ohne KI zu: gleiches Zeichen/Aktenzeichen, sonst gleicher Absender. */
export function matchCaseByRules(baseline: Analysis, candidates: CaseCandidate[]): string | undefined {
  if (baseline.reference) {
    const byRef = candidates.find((c) => c.reference && c.reference.toLowerCase() === baseline.reference!.toLowerCase());
    if (byRef) return byRef.id;
  }
  const sameSender = candidates.filter((c) => c.correspondent.toLowerCase() === baseline.correspondent.toLowerCase());
  return sameSender.length === 1 ? sameSender[0].id : undefined;
}

/** Zusammenführung: Regel-Fristen bleiben immer erhalten, die KI darf ergänzen. */
export function mergeDeadlines(rule: Deadline[], ai: Deadline[]): Deadline[] {
  const map = new Map<string, Deadline>();
  for (const d of [...rule, ...ai]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) continue;
    const key = `${d.date}|${d.kind}`;
    if (!map.has(key)) map.set(key, d);
  }
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

