import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, rememberFact } from "@/lib/career-ops";
import { atomicWrite } from "@/lib/core/safe-write";

export interface QaMemoryEntry {
  key: string;
  question: string;
  answer: string;
  fieldType: string;
  updatedAt: string;
  useCount: number;
}

export interface QaMemoryStore {
  version: number;
  updatedAt: string;
  entries: QaMemoryEntry[];
}

const MEMORY_REL_PATH = path.join("data", "qa-memory.json");

/** Collapse punctuation, asterisks, smart quotes, and whitespace into a deterministic lookup key. */
export function normalizeQuestionKey(question: string): string {
  return String(question ?? "")
    .replace(/[\u2731*]/g, "")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 140);
}

export function qaMemoryFilePath(): string {
  return path.join(careerOpsRoot(), MEMORY_REL_PATH);
}

export function readQaMemory(): QaMemoryStore {
  const file = qaMemoryFilePath();
  if (!fs.existsSync(file)) {
    return { version: 1, updatedAt: "", entries: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<QaMemoryStore>;
    const entries = Array.isArray(raw.entries)
      ? raw.entries.filter(
          (e): e is QaMemoryEntry =>
            Boolean(e && typeof e.key === "string" && typeof e.question === "string" && typeof e.answer === "string"),
        )
      : [];
    return {
      version: typeof raw.version === "number" ? raw.version : 1,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
      entries,
    };
  } catch {
    return { version: 1, updatedAt: "", entries: [] };
  }
}

export function upsertQaMemory(input: {
  question: string;
  answer: string;
  fieldType?: string;
  alsoRememberFact?: boolean;
}): { entry: QaMemoryEntry; store: QaMemoryStore } {
  const question = input.question.trim();
  const answer = input.answer.trim();
  if (!question) throw new Error("question is required");
  if (!answer) throw new Error("answer is required");

  const key = normalizeQuestionKey(question);
  if (!key) throw new Error("question produced an empty normalized key");

  const store = readQaMemory();
  const now = new Date().toISOString();
  const idx = store.entries.findIndex((e) => e.key === key);
  const existing = idx >= 0 ? store.entries[idx] : null;

  const entry: QaMemoryEntry = {
    key,
    question,
    answer,
    fieldType: (input.fieldType ?? existing?.fieldType ?? "text").trim() || "text",
    updatedAt: now,
    useCount: (existing?.useCount ?? 0) + 1,
  };

  const nextEntries =
    idx >= 0
      ? store.entries.map((e, i) => (i === idx ? entry : e))
      : [entry, ...store.entries];

  const nextStore: QaMemoryStore = {
    version: 1,
    updatedAt: now,
    entries: nextEntries,
  };

  atomicWrite(qaMemoryFilePath(), JSON.stringify(nextStore, null, 2));

  if (input.alsoRememberFact === true) {
    rememberFact(`Form Q&A (${question}): ${answer}`);
  }

  return { entry, store: nextStore };
}

export function deleteQaMemory(keyOrQuestion: string): { removed: boolean; store: QaMemoryStore } {
  const targetKey = normalizeQuestionKey(keyOrQuestion) || keyOrQuestion.trim().toLowerCase();
  const store = readQaMemory();
  const filtered = store.entries.filter((e) => e.key !== targetKey);
  const removed = filtered.length !== store.entries.length;
  if (!removed) return { removed: false, store };

  const nextStore: QaMemoryStore = {
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: filtered,
  };
  atomicWrite(qaMemoryFilePath(), JSON.stringify(nextStore, null, 2));
  return { removed: true, store: nextStore };
}

