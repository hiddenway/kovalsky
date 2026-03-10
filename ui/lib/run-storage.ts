import type { RunRecord } from "@/lib/types";

const RUNS_STORAGE_KEY = "kovalsky:runs";

export function readRunsFromStorage(): RunRecord[] {
  if (typeof window === "undefined") {
    return [];
  }

  const raw = window.localStorage.getItem(RUNS_STORAGE_KEY);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as RunRecord[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeRunsToStorage(runs: RunRecord[]): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(RUNS_STORAGE_KEY, JSON.stringify(runs));
}

export { RUNS_STORAGE_KEY };
