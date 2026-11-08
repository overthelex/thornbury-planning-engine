import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

export const DATA_DIR = join(__dirname, "..", "data");
export const CLIENTS_DIR = join(DATA_DIR, "clients");

export function listClients(): string[] {
  return readdirSync(CLIENTS_DIR)
    .filter((d) => existsSync(join(CLIENTS_DIR, d, "company.json")))
    .sort();
}
const clientDir = (client: string) => {
  const dir = join(CLIENTS_DIR, client);
  if (!existsSync(dir)) throw new Error(`no client "${client}"; known: ${listClients().join(", ")}`);
  return dir;
};

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows;
  return body
    .filter((r) => r.length > 1 || r[0] !== "")
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}
const num = (s: string) => Number(s);
const bool = (s: string) => s === "true";
const readJsonl = <T>(file: string): T[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);

export function loadCompany(client: string): Company {
  return JSON.parse(readFileSync(join(clientDir(client), "company.json"), "utf8")) as Company;
}
export function loadLedger(client: string): LedgerEntry[] {
  return readJsonl<LedgerEntry>(join(clientDir(client), "ledger.jsonl"));
}
export function loadAccounts(client: string): Account[] {
  return parseCsv(readFileSync(join(clientDir(client), "accounts.csv"), "utf8")) as unknown as Account[];
}
export function loadTaxCodes(client: string): TaxCode[] {
  return parseCsv(readFileSync(join(clientDir(client), "tax_codes.csv"), "utf8")).map((r) => ({
    code: r.code,
    name: r.name,
    ratePercent: num(r.ratePercent),
  }));
}
export function loadParties(client: string): Party[] {
  return parseCsv(readFileSync(join(clientDir(client), "parties.csv"), "utf8")).map((r) => ({
    ...r,
    relatedParty: bool(r.relatedParty),
  })) as Party[];
}
export function loadTrialBalance(client: string): TrialBalanceRow[] {
  return parseCsv(readFileSync(join(clientDir(client), "trial_balance.csv"), "utf8")).map((r) => ({
    account: r.account,
    name: r.name,
    priorYearMinor: num(r.priorYearMinor),
    openingMinor: num(r.openingMinor),
    closingMinor: num(r.closingMinor),
  }));
}
/** `which` is "year" for the financial year's statement, "next" for the first quarter after it. */
export function loadBankStatement(client: string, which: "year" | "next"): BankStatementLine[] {
  const year = loadCompany(client).financialYear.end.slice(0, 4);
  const file = which === "year" ? `bank_statement_${year}.csv` : `bank_statement_${Number(year) + 1}q1.csv`;
  return parseCsv(readFileSync(join(clientDir(client), file), "utf8")).map((r) => ({
    ...r,
    amountMinor: num(r.amountMinor),
    balanceMinor: num(r.balanceMinor),
  })) as BankStatementLine[];
}
export function loadPriorYearFindings(client: string): PriorYearFinding[] {
  return readJsonl<PriorYearFinding>(join(clientDir(client), "prior_year_findings.jsonl"));
}
/** Continuing clients only; returns null for a first-year engagement. */
export function loadPriorYearPlan(client: string): PriorYearPlanLine[] | null {
  const file = join(clientDir(client), "prior_year_plan.jsonl");
  return existsSync(file) ? readJsonl<PriorYearPlanLine>(file) : null;
}
/** The planning notes as written. */
export function loadPlanningNotesMarkdown(client: string): string {
  return readFileSync(join(clientDir(client), "planning_notes.md"), "utf8");
}
/** The planning notes split into their numbered paragraphs. */
export function loadPlanningNotes(client: string): PlanningNote[] {
  const notes: PlanningNote[] = [];
  let section = "";
  for (const line of loadPlanningNotesMarkdown(client).split("\n")) {
    if (line.startsWith("## ")) section = line.slice(3).trim();
    const m = line.match(/^\[(N\d+)\]\s+(.*)$/);
    if (m) notes.push({ id: m[1], section, text: m[2].trim() });
  }
  return notes;
}
/** The firm's programme as the firm keeps it: a document. Parsing it is up to you; `Procedure` in types.ts is the shape it describes. */
export function loadProgrammeMarkdown(): string {
  return readFileSync(join(DATA_DIR, "programme", "audit_programme.md"), "utf8");
}
