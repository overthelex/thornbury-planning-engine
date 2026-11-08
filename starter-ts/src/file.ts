import type {
  Account,
  BankStatementLine,
  Company,
  LedgerEntry,
  Party,
  PlanningNote,
  PriorYearFinding,
  PriorYearPlanLine,
  TaxCode,
  TrialBalanceRow,
} from "./types";
import {
  loadAccounts,
  loadBankStatement,
  loadCompany,
  loadLedger,
  loadParties,
  loadPlanningNotes,
  loadPriorYearFindings,
  loadPriorYearPlan,
  loadTaxCodes,
  loadTrialBalance,
} from "./load";

/** Everything in one client's planning file, loaded once. */
export interface ClientFile {
  id: string;
  company: Company;
  ledger: LedgerEntry[];
  accounts: Account[];
  taxCodes: TaxCode[];
  parties: Party[];
  tb: TrialBalanceRow[];
  bankYear: BankStatementLine[];
  bankNext: BankStatementLine[];
  pyFindings: PriorYearFinding[];
  pyPlan: PriorYearPlanLine[] | null;
  notes: PlanningNote[];
}

export function loadClientFile(id: string): ClientFile {
  return {
    id,
    company: loadCompany(id),
    ledger: loadLedger(id),
    accounts: loadAccounts(id),
    taxCodes: loadTaxCodes(id),
    parties: loadParties(id),
    tb: loadTrialBalance(id),
    bankYear: loadBankStatement(id, "year"),
    bankNext: loadBankStatement(id, "next"),
    pyFindings: loadPriorYearFindings(id),
    pyPlan: loadPriorYearPlan(id),
    notes: loadPlanningNotes(id),
  };
}

/** Engagement thresholds, in pence. */
export const materiality = (f: ClientFile) => f.company.engagement.materialityMinor;
export type Materiality = ReturnType<typeof materiality>;

export const accountsIn = (f: ClientFile, category: string) =>
  f.accounts.filter((a) => a.category === category).map((a) => a.code);
export const accountOf = (f: ClientFile, code: string) => f.accounts.find((a) => a.code === code);
export const partyOf = (f: ClientFile, id: string | null) => (id ? f.parties.find((p) => p.id === id) : undefined);
export const tbRow = (f: ClientFile, code: string) => f.tb.find((r) => r.account === code);
export const closing = (f: ClientFile, codes: string[]) =>
  codes.reduce((s, c) => s + (tbRow(f, c)?.closingMinor ?? 0), 0);

/** The bank account(s): category "cash" excluding floats, which the statement does not cover. */
export const bankAccounts = (f: ClientFile) =>
  f.accounts.filter((a) => a.category === "cash" && !/float|in hand/i.test(a.name)).map((a) => a.code);

/** Users with unlimited approval: the people a management-override test looks at first. */
export const seniorUsers = (f: ClientFile) =>
  f.company.users.filter((u) => u.canApprove && (u.approvalLimitMinor ?? null) === null).map((u) => u.id);

/** Gross value of a purchase invoice: the credit to the creditors control. */
export function grossOf(f: ClientFile, e: LedgerEntry): number {
  const creditors = accountsIn(f, "currentLiabilities").filter((c) => /creditor/i.test(accountOf(f, c)!.name));
  return -e.lines.filter((l) => creditors.includes(l.account)).reduce((s, l) => s + l.amountMinor, 0);
}

/** The value of an entry: total debits. */
export const valueOf = (e: LedgerEntry) =>
  e.lines.filter((l) => l.amountMinor > 0).reduce((s, l) => s + l.amountMinor, 0);

export const yearEnd = (f: ClientFile) => f.company.financialYear.end;
export const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 86_400_000);

export const gbp = (minor: number) =>
  (minor / 100).toLocaleString("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });

const by =
  <T>(...keys: ((x: T) => string | number)[]) =>
  (a: T, b: T) => {
    for (const k of keys) {
      const x = k(a),
        y = k(b);
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return 0;
  };

/**
 * The plan is a function of what the file says, not of the order its rows arrive in: every collection is put in
 * one order (by date, then id) before any detector reads it. Without this, "the closing bank balance" was the last
 * row of the statement rather than the latest-dated one.
 */
export function canonical(f: ClientFile): ClientFile {
  return {
    ...f,
    ledger: f.ledger
      .map((e) => ({ ...e, lines: [...e.lines].sort(by((l) => l.line)) }))
      .sort(
        by(
          (e) => e.postingDate,
          (e) => e.voucher,
        ),
      ),
    accounts: [...f.accounts].sort(by((a) => a.code)),
    taxCodes: [...f.taxCodes].sort(by((t) => t.code)),
    parties: [...f.parties].sort(by((p) => p.id)),
    tb: [...f.tb].sort(by((r) => r.account)),
    bankYear: [...f.bankYear].sort(
      by(
        (b) => b.date,
        (b) => b.id,
      ),
    ),
    bankNext: [...f.bankNext].sort(
      by(
        (b) => b.date,
        (b) => b.id,
      ),
    ),
    pyFindings: [...f.pyFindings].sort(by((x) => x.id)),
    pyPlan: f.pyPlan && [...f.pyPlan].sort(by((x) => x.procedureId)),
    notes: [...f.notes].sort(by((n) => Number(n.id.slice(1)))),
  };
}
