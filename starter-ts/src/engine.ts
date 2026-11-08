import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AuditPlan, RiskAssessment } from "./types";
import { CLIENTS_DIR, DATA_DIR } from "./load";
import { canonical, type ClientFile, gbp, loadClientFile, yearEnd } from "./file";
import { parseProgramme, type Programme } from "./programme";
import { allSignals, type Signal } from "./signals";
import { loadMergedNotes, sha256, type MergedNotes } from "./notes";
import { priorYearFeedback, type Feedback } from "./feedback";
import { assessRisk, RULESET_VERSION, type AreaRisk } from "./risk";
import { selectProcedures, budgetCheck, type Budget, type PlannedLine } from "./select";
import { buildEvidenceIndex, assertEvidence, type EvidenceIndex } from "./evidence";

export interface EnginePlan extends AuditPlan {
  procedures: PlannedLine[];
  rulesetVersion: string;
  inputs: Record<string, string>;
  notesExtraction: MergedNotes["provenance"] & { disagreements: string[] };
  areas: AreaRisk[];
  signals: Signal[];
  budget: Budget;
  questions: string[];
}
export interface EngineResult {
  plan: EnginePlan;
  file: ClientFile;
  programme: Programme;
  evidence: EvidenceIndex;
  notes: MergedNotes;
  feedback: Feedback;
}

function inputHashes(client: string): Record<string, string> {
  const files: Record<string, string> = {
    "data/programme/audit_programme.md": sha256(
      readFileSync(join(DATA_DIR, "programme", "audit_programme.md"), "utf8"),
    ),
  };
  for (const f of readdirSync(join(CLIENTS_DIR, client)).sort())
    files[`data/clients/${client}/${f}`] = sha256(readFileSync(join(CLIENTS_DIR, client, f), "utf8"));
  return files;
}

function rationale(r: AreaRisk): string {
  if (r.level === "notApplicable") return `Not applicable: ${r.scopeReason}.`;
  const raising = r.sources.filter((s) => s.severity !== "info");
  if (!raising.length)
    return "Baseline: nothing in the file raises this area; the programme's baseline procedures apply.";
  const lead = raising.sort(
    (a, b) => (b.severity === "significant" ? 1 : 0) - (a.severity === "significant" ? 1 : 0),
  )[0];
  return `${r.level[0].toUpperCase()}${r.level.slice(1)} (${r.rules.join("; ")}). Led by: ${lead.text}${raising.length > 1 ? ` (+${raising.length - 1} more source${raising.length > 2 ? "s" : ""})` : ""}.`;
}

export function buildPlan(client: string): EngineResult {
  return buildPlanFromFile(loadClientFile(client));
}

/** The same plan from a file already in memory: lets tests change one fact and see what moves. */
export function buildPlanFromFile(input: ClientFile): EngineResult {
  const file = canonical(input);
  const client = file.id;
  const programme = parseProgramme();
  const evidence = buildEvidenceIndex(file);
  const signals = allSignals(file);
  const notes = loadMergedNotes(client, file.notes);
  const feedback = priorYearFeedback(file, programme.procedures);
  const areas = assessRisk(file, signals, notes, feedback);
  const procedures = selectProcedures(programme, areas, signals, feedback, { f: file, signals, notes, risks: areas });
  const budget = budgetCheck(procedures, areas, programme, file.company.engagement.fieldworkBudgetHours);

  const riskAssessment: RiskAssessment[] = areas.map((r) => ({
    area: r.area,
    level: r.level,
    assertions: r.assertions,
    rationale: rationale(r),
    evidenceIds: [
      ...new Set([...r.scopeEvidence, ...r.sources.filter((s) => s.severity !== "info").flatMap((s) => s.evidenceIds)]),
    ],
  }));

  // data-integrity questions first: if the file is incomplete, every other answer depends on it
  const questions: string[] = [];
  const lastNext = file.bankNext
    .map((b) => b.date)
    .sort()
    .at(-1);
  const receiptsNext = file.bankNext.filter((b) => b.amountMinor > 0).length;
  if (lastNext && receiptsNext === 0)
    questions.push(
      `The post-year-end bank statement ends on ${lastNext} and has ${receiptsNext} receipts. Subsequent receipts testing and the subsequent-events review rely on it: is it complete?`,
    );
  for (const p of procedures.filter((p) => p.unknown))
    questions.push(`${p.procedureId}: ${p.reason.replace(/^Does not apply: /, "")}`);
  for (const d of notes.disagreements.filter((d) => d.startsWith("fact") || d.startsWith("extraction")))
    questions.push(`Notes: ${d}.`);
  for (const r of areas) for (const q of r.questions ?? []) questions.push(q);
  if (budget.gapHours > 0)
    questions.push(
      `The plan needs ${budget.totalHours}h against a budget of ${budget.budgetHours}h. Accept the overrun, or defer from the list in the budget section?`,
    );

  const limitations = [
    "The engine plans from the file as received; it has not seen the client's systems, minutes or contracts.",
    `Planning notes are read through a committed model extraction (${notes.provenance.models.join(", ")}; ${notes.provenance.runs} runs, majority of two). ${notes.disagreements.length} items were dropped as unverified or not agreed by two runs; they are listed in plan.json under notesExtraction.disagreements.`,
    "Hours are the programme's baseline hours scaled linearly with sample size; must-test items under JNL-01 are added at the per-item rate.",
    ...[...new Set(signals.flatMap((s) => s.reliesOn ?? []))].map(
      (id) =>
        `The plan relies on the compensating control tested last year (${id}): PUR-03 is selected to test it still operates; confirm it has not changed since FY${Number(yearEnd(file).slice(0, 4)) - 1} before relying on that evidence (ISA (UK) 330.14).`,
    ),
    "ISA (UK) 240 treats management override as a significant risk on every audit; the firm's response is the three mandatory JNL procedures, and the area level here sets their extent.",
  ];

  for (const r of riskAssessment) assertEvidence(evidence, r.evidenceIds, `risk ${r.area}`);
  for (const p of procedures) assertEvidence(evidence, p.evidenceIds, `procedure ${p.procedureId}`);
  for (const s of signals) assertEvidence(evidence, s.evidenceIds, `signal ${s.id}`);

  const plan: EnginePlan = {
    clientId: client,
    riskAssessment,
    procedures,
    totalHours: budget.totalHours,
    budgetHours: budget.budgetHours,
    limitations,
    rulesetVersion: RULESET_VERSION,
    inputs: inputHashes(client),
    notesExtraction: { ...notes.provenance, disagreements: notes.disagreements },
    areas,
    signals,
    budget,
    questions,
  };
  return { plan, file, programme, evidence, notes, feedback };
}

export { gbp };
