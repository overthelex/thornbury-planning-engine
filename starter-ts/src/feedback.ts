/**
 * What last year's executed plan and findings say about this year's plan (memo 8).
 * - yield: what each procedure found per hour;
 * - extent caps: a procedure that overran its budget and found no misstatement goes back to the programme's extent;
 * - missed coverage: a finding that surfaced "by chance" through another procedure makes the direct procedure a candidate.
 */
import type { Area, PriorYearFinding } from "./types";
import type { ClientFile } from "./file";
import type { ProgrammeProcedure } from "./programme";

export interface ProcedureYield {
  procedureId: string;
  selected: boolean;
  budgetHours: number;
  actualHours: number;
  findings: string[];
  misstatements: number;
  misstatementMinor: number;
}
export interface ExtentCap {
  procedureId: string;
  reason: string;
  evidenceIds: string[];
}
export interface MissedCoverage {
  procedureId: string;
  area: Area;
  assertions: PriorYearFinding["assertion"][];
  findingId: string;
  reason: string;
  evidenceIds: string[];
}
export interface Feedback {
  yields: ProcedureYield[];
  caps: ExtentCap[];
  missed: MissedCoverage[];
  findingArea: (p: PriorYearFinding) => Area | null;
}

const KEYWORD_AREA: [RegExp, Area][] = [
  [/stock|count|wip/i, "stock"],
  [/loan|interest|covenant/i, "goingConcern"],
  [/debtor/i, "debtors"],
  [/payroll|leaver|wages/i, "payroll"],
  [/vat/i, "vat"],
  [/accrual|provision/i, "accrualsProvisions"],
  [/bank/i, "bankCash"],
  [/director|related/i, "relatedParties"],
];

export function priorYearFeedback(f: ClientFile, procedures: ProgrammeProcedure[]): Feedback {
  const byId = new Map(procedures.map((p) => [p.id, p]));
  const findings = new Map(f.pyFindings.map((x) => [x.id, x]));
  const findingArea = (p: PriorYearFinding): Area | null =>
    (p.raisedBy && byId.get(p.raisedBy)?.area) ||
    KEYWORD_AREA.find(([re]) => re.test(`${p.subject} ${p.summary}`))?.[1] ||
    null;
  const yields: ProcedureYield[] = (f.pyPlan ?? []).map((l) => {
    const mis = l.findingsRaised.map((id) => findings.get(id)).filter((x) => x?.outcome === "misstatement");
    return {
      procedureId: l.procedureId,
      selected: l.selected,
      budgetHours: l.budgetHours,
      actualHours: l.actualHours,
      findings: l.findingsRaised,
      misstatements: mis.length,
      misstatementMinor: mis.reduce((s, x) => s + (x?.misstatementMinor ?? 0), 0),
    };
  });
  const caps: ExtentCap[] = yields
    .filter((y) => y.selected && y.budgetHours > 0 && y.actualHours >= 2 * y.budgetHours && y.misstatements === 0)
    .map((y) => ({
      procedureId: y.procedureId,
      reason: `last year ${y.procedureId} took ${y.actualHours}h against ${y.budgetHours}h budgeted and found no misstatement (${y.findings.map((id) => `${id}: ${findings.get(id)?.outcome}`).join(", ") || "nothing raised"}); held at the programme's extent, and any extension needs a documented reason`,
      evidenceIds: [`PY:${y.procedureId}`, ...y.findings],
    }));
  const missed: MissedCoverage[] = [];
  for (const l of f.pyPlan ?? []) {
    if (l.selected) continue;
    for (const id of l.note.match(/\b(FY\d{2}-[A-Z]?\d+|PY-[A-Z]+-\d+)\b/g) ?? []) {
      const x = findings.get(id);
      if (!x) continue;
      const proc = byId.get(l.procedureId);
      if (!proc) continue;
      missed.push({
        procedureId: l.procedureId,
        area: proc.area,
        assertions: proc.assertions,
        findingId: id,
        reason: `${l.procedureId} was not run last year and ${id} (${x.summary}, ${x.outcome}) was found only through ${x.raisedBy ?? "another procedure"}`,
        evidenceIds: [`PY:${l.procedureId}`, id],
      });
    }
  }
  return { yields, caps, missed, findingArea };
}
