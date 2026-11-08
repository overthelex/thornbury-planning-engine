/**
 * Every id a plan may cite, with a one-line description of what it is. A reason that cites an id
 * not in this index is a bug, and `assertEvidence` makes it fail the run (memo 1: "if it cannot point, it does not count").
 */
import { type ClientFile, gbp, valueOf } from "./file";

export type EvidenceIndex = Map<string, string>;

export function buildEvidenceIndex(f: ClientFile): EvidenceIndex {
  const ix: EvidenceIndex = new Map();
  for (const e of f.ledger)
    ix.set(
      e.voucher,
      `${e.voucher} ${e.journal} ${e.postingDate} "${e.description}" ${gbp(valueOf(e))}, posted by ${e.postedBy}${e.approvedBy ? `, approved by ${e.approvedBy}` : ", no approver"}, keyed ${e.systemEntryTime.slice(0, 16).replace("T", " ")}`,
    );
  for (const b of [...f.bankYear, ...f.bankNext])
    ix.set(b.id, `bank ${b.date} ${b.counterparty} ${b.reference} ${gbp(b.amountMinor)}`);
  for (const n of f.notes)
    ix.set(
      n.id,
      `planning notes ${n.id} (${n.section}): "${n.text.length > 220 ? n.text.slice(0, 217) + "..." : n.text}"`,
    );
  for (const p of f.pyFindings)
    ix.set(
      p.id,
      `FY${p.financialYear} finding ${p.id}: ${p.subject}; ${p.summary}; outcome ${p.outcome}${p.raisedBy ? `, raised by ${p.raisedBy}` : ""}`,
    );
  for (const l of f.pyPlan ?? [])
    ix.set(
      `PY:${l.procedureId}`,
      `FY${l.financialYear} plan ${l.procedureId}: ${l.selected ? `selected, ${l.budgetHours}h budgeted, ${l.actualHours}h spent, raised ${l.findingsRaised.join(", ") || "nothing"}` : "not selected"}${l.note ? `; "${l.note}"` : ""}`,
    );
  for (const a of f.accounts) {
    const r = f.tb.find((t) => t.account === a.code);
    ix.set(
      a.code,
      `account ${a.code} ${a.name}${r ? `: prior year ${gbp(r.priorYearMinor)}, closing ${gbp(r.closingMinor)}` : ""}`,
    );
  }
  for (const p of f.parties)
    ix.set(
      p.id,
      `${p.type} ${p.id} ${p.name}${p.relatedParty ? ` (related: ${p.relation})` : ""}${p.endDate ? `, left ${p.endDate}` : ""}`,
    );
  for (const u of f.company.users)
    ix.set(
      u.id,
      `user ${u.id}: ${u.name}, ${u.role}${u.canApprove ? `, approves ${u.approvalLimitMinor ? `up to ${gbp(u.approvalLimitMinor)}` : "without limit"}` : ""}`,
    );
  ix.set(
    "company.json",
    `engagement facts: ${f.company.engagement.firstYear ? "first-year audit" : `year ${f.company.engagement.yearsAsAuditor}`}, materiality ${gbp(f.company.engagement.materialityMinor.overall)}, performance ${gbp(f.company.engagement.materialityMinor.performance)}, trivial ${gbp(f.company.engagement.materialityMinor.clearlyTrivial)}, budget ${f.company.engagement.fieldworkBudgetHours}h`,
  );
  for (const [k, v] of Object.entries(f.company.controls)) ix.set(`control:${k}`, `client control ${k}: "${v}"`);
  return ix;
}

export function assertEvidence(ix: EvidenceIndex, ids: string[], where: string): void {
  const missing = ids.filter((id) => !ix.has(id));
  if (missing.length) throw new Error(`${where} cites evidence that is not in the file: ${missing.join(", ")}`);
}
