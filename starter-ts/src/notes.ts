/**
 * The planning notes as the engine uses them: claims and facts a language model extracted once,
 * committed under data/derived/<client>/notes_extraction.json, validated here and merged by majority.
 * The engine never calls a model. If the notes change, the hash check stops the plan.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, loadPlanningNotesMarkdown } from "./load";
import type { Area, Assertion, PlanningNote } from "./types";

export const AREAS: Area[] = [
  "revenue",
  "debtors",
  "purchasesCreditors",
  "payroll",
  "fixedAssets",
  "bankCash",
  "relatedParties",
  "journalsManagementOverride",
  "goingConcern",
  "stock",
  "openingBalances",
  "vat",
  "accrualsProvisions",
  "completion",
];
export const ASSERTIONS: Assertion[] = [
  "existence",
  "completeness",
  "accuracy",
  "cutOff",
  "valuation",
  "rightsAndObligations",
  "classification",
  "presentation",
  "occurrence",
];

export interface NoteClaim {
  noteId: string;
  area: Area;
  assertions: Assertion[];
  /** raises: the paragraph points to a way the accounts could be wrong. lowers: it is evidence the risk is lower. */
  direction: "raises" | "lowers";
  claim: string;
  /** An exact, contiguous substring of the paragraph. */
  quote: string;
  /** Only when the paragraph states the amount; pounds as written, converted to pence. */
  amountMinor: number | null;
}
export interface NoteFact {
  value: boolean | null;
  noteId: string | null;
  quote: string | null;
}
export interface NoteEstimate {
  description: string;
  noteId: string;
  quote: string;
  amountMinor: number | null;
}
export const FACT_KEYS = [
  "longTermContractsSpanYearEnd",
  "borrowingCovenants",
  "impairmentIndicators",
  "assetRegisterVerifiedWithinThreeYears",
] as const;
export type FactKey = (typeof FACT_KEYS)[number];
export interface ExtractionPayload {
  claims: NoteClaim[];
  facts: Record<FactKey, NoteFact>;
  estimates: NoteEstimate[];
}

export interface ExtractionRun {
  model: string;
  effort: string;
  raw: string;
  stopReason: string;
  usage: unknown;
}
export interface ExtractionFile {
  client: string;
  inputSha256: string;
  promptSha256: string;
  prompt: string;
  runs: ExtractionRun[];
}

export interface MergedNotes {
  claims: NoteClaim[];
  facts: Record<FactKey, NoteFact>;
  estimates: NoteEstimate[];
  /** What the runs did not agree on, or what failed validation: shown to the partner, never used. */
  disagreements: string[];
  provenance: { file: string; models: string[]; inputSha256: string; promptSha256: string; runs: number };
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const extractionPath = (client: string) => join(DATA_DIR, "derived", client, "notes_extraction.json");

const norm = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();

/** Checks one run's payload against the paragraphs. Returns the valid items and a reason for every dropped one. */
export function validatePayload(
  p: ExtractionPayload,
  notes: PlanningNote[],
): { payload: ExtractionPayload; errors: string[] } {
  const byId = new Map(notes.map((n) => [n.id, n]));
  const errors: string[] = [];
  const quoteOk = (noteId: string | null, quote: string | null, what: string) => {
    if (!noteId || !quote) return false;
    const n = byId.get(noteId);
    if (!n) {
      errors.push(`${what}: unknown paragraph ${noteId}`);
      return false;
    }
    if (!norm(n.text).includes(norm(quote))) {
      errors.push(`${what}: quote not found in ${noteId}: "${quote.slice(0, 60)}"`);
      return false;
    }
    return true;
  };
  const amountOk = (amount: number | null, quote: string, what: string) => {
    if (amount === null) return true;
    const pounds = (amount / 100).toLocaleString("en-GB");
    if (
      norm(quote)
        .replace(/,/g, "")
        .includes(String(amount / 100))
    )
      return true;
    errors.push(`${what}: amount ${pounds} is not stated in the quote`);
    return false;
  };
  const claims = p.claims.filter((c, i) => {
    const what = `claim ${i} (${c.noteId}/${c.area})`;
    if (!AREAS.includes(c.area)) {
      errors.push(`${what}: unknown area`);
      return false;
    }
    if (!c.assertions.every((a) => ASSERTIONS.includes(a))) {
      errors.push(`${what}: unknown assertion`);
      return false;
    }
    if (c.direction !== "raises" && c.direction !== "lowers") {
      errors.push(`${what}: bad direction`);
      return false;
    }
    return quoteOk(c.noteId, c.quote, what) && amountOk(c.amountMinor, c.quote, what);
  });
  const facts = {} as Record<FactKey, NoteFact>;
  for (const k of FACT_KEYS) {
    const f = p.facts?.[k] ?? { value: null, noteId: null, quote: null };
    facts[k] =
      f.value === null || quoteOk(f.noteId, f.quote, `fact ${k}`) ? f : { value: null, noteId: null, quote: null };
  }
  const estimates = (p.estimates ?? []).filter(
    (e, i) => quoteOk(e.noteId, e.quote, `estimate ${i}`) && amountOk(e.amountMinor, e.quote, `estimate ${i}`),
  );
  return { payload: { claims, facts, estimates }, errors };
}

/** Parses a run's raw text. A run that is not valid JSON counts as a run that said nothing. */
export function parseRun(raw: string): ExtractionPayload | null {
  try {
    return JSON.parse(raw) as ExtractionPayload;
  } catch {
    return null;
  }
}

/**
 * Majority merge across runs: a claim survives when at least two runs make it about the same paragraph,
 * area and direction; its assertions are those at least two of those runs name (none, and a disagreement, if no two do).
 * Fewer than two valid runs means nothing is agreed. Facts take the majority value;
 * a split goes to `disagreements` and is treated as unknown.
 */
export function mergeRuns(file: ExtractionFile, notes: PlanningNote[]): MergedNotes {
  const disagreements: string[] = [];
  const valid = file.runs
    .map((r, i) => {
      const p = parseRun(r.raw);
      if (!p) {
        disagreements.push(`run ${i} (${r.model}): output was not valid JSON; ignored`);
        return null;
      }
      const v = validatePayload(p, notes);
      for (const e of v.errors) disagreements.push(`run ${i} (${r.model}): dropped ${e}`);
      return v.payload;
    })
    .filter((p): p is ExtractionPayload => p !== null);
  // two runs must agree, always: with fewer than two valid runs nothing from the notes is used, and the plan says so
  const need = 2;
  if (valid.length < need)
    disagreements.push(
      `extraction: only ${valid.length} of ${file.runs.length} runs are valid, so no claim, fact or estimate can reach two-run agreement; the plan uses nothing from the notes until extraction is rerun`,
    );

  const groups = new Map<string, NoteClaim[]>();
  valid.forEach((p) => {
    const seen = new Set<string>();
    for (const c of p.claims) {
      const k = `${c.noteId}|${c.area}|${c.direction}`;
      if (seen.has(k)) {
        groups.get(k)!.at(-1)!.assertions = [...new Set([...groups.get(k)!.at(-1)!.assertions, ...c.assertions])];
        continue;
      }
      seen.add(k);
      groups.set(k, [...(groups.get(k) ?? []), { ...c }]);
    }
  });
  const claims: NoteClaim[] = [];
  for (const [k, cs] of groups) {
    if (cs.length < need) {
      disagreements.push(`claim ${k.replace(/\|/g, " / ")} made by ${cs.length} of ${valid.length} runs; not used`);
      continue;
    }
    const count = new Map<Assertion, number>();
    cs.forEach((c) => c.assertions.forEach((a) => count.set(a, (count.get(a) ?? 0) + 1)));
    const assertions = ASSERTIONS.filter((a) => (count.get(a) ?? 0) >= need);
    // the area is agreed; assertions no two runs share are not borrowed from one run: the claim raises the area for none
    if (!assertions.length)
      disagreements.push(
        `claim ${k.replace(/\|/g, " / ")}: runs agree on the area but no assertion is named by two of them (${cs.map((c) => c.assertions.join("+") || "none").join(" vs ")}); used without assertions`,
      );
    claims.push({ ...cs[0], assertions });
  }

  const facts = {} as Record<FactKey, NoteFact>;
  for (const k of FACT_KEYS) {
    const votes = valid.map((p) => p.facts[k]);
    const yes = votes.filter((v) => v.value === true),
      no = votes.filter((v) => v.value === false);
    const win =
      yes.length >= need && yes.length > no.length
        ? yes[0]
        : no.length >= need && no.length > yes.length
          ? no[0]
          : null;
    if (!win && (yes.length || no.length))
      disagreements.push(
        `fact ${k}: ${yes.length} runs yes, ${no.length} no, ${votes.length - yes.length - no.length} unknown; treated as unknown`,
      );
    facts[k] = win ?? { value: null, noteId: null, quote: null };
  }

  const est = new Map<string, NoteEstimate[]>();
  valid.forEach((p) => {
    const seen = new Set<string>();
    for (const e of p.estimates)
      if (!seen.has(e.noteId)) {
        seen.add(e.noteId);
        est.set(e.noteId, [...(est.get(e.noteId) ?? []), e]);
      }
  });
  const estimates = [...est.values()].filter((es) => es.length >= need).map((es) => es[0]);

  claims.sort(
    (a, b) =>
      Number(a.noteId.slice(1)) - Number(b.noteId.slice(1)) ||
      a.area.localeCompare(b.area) ||
      a.direction.localeCompare(b.direction),
  );
  estimates.sort((a, b) => a.noteId.localeCompare(b.noteId));
  return {
    claims,
    facts,
    estimates,
    disagreements,
    provenance: {
      file: `data/derived/${file.client}/notes_extraction.json`,
      models: file.runs.map((r) => r.model),
      inputSha256: file.inputSha256,
      promptSha256: file.promptSha256,
      runs: file.runs.length,
    },
  };
}

/** Loads the committed extraction and refuses to use it if the notes have changed since it was made. */
export function loadMergedNotes(client: string, notes: PlanningNote[]): MergedNotes {
  const path = extractionPath(client);
  if (!existsSync(path))
    throw new Error(
      `no notes extraction for ${client}: run \`npm run extract -- ${client}\` (needs ANTHROPIC_API_KEY) and commit ${path}`,
    );
  const file = JSON.parse(readFileSync(path, "utf8")) as ExtractionFile;
  const now = sha256(loadPlanningNotesMarkdown(client));
  if (file.inputSha256 !== now)
    throw new Error(
      `planning notes for ${client} changed since the extraction was made (${file.inputSha256.slice(0, 12)} → ${now.slice(0, 12)}); re-run the extraction`,
    );
  return mergeRuns(file, notes);
}
