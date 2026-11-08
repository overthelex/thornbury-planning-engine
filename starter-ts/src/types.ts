/**
 * Data model for the Ashworth Electrical FY2025 audit file.
 * Amounts are integers in minor units (pence). Debit is positive, credit is negative.
 */

export type Journal = "sales" | "purchases" | "bank" | "payroll" | "manual";

export interface LedgerLine {
  line: number;
  account: string;
  amountMinor: number;
  /** Tax code from tax_codes.csv, or null when the line carries no VAT treatment. */
  taxCode: string | null;
  /** VAT attributable to this line (informational; the VAT itself is posted on 2200/2201). */
  vatMinor: number;
  partyId: string | null;
  description: string | null;
}

export interface LedgerEntry {
  voucher: string;
  journal: Journal;
  /** Date the entry takes effect in the accounts. */
  postingDate: string;
  /** Date on the source document. */
  transactionDate: string;
  /** When the entry was keyed into the ERP. */
  systemEntryTime: string;
  postedBy: string;
  approvedBy: string | null;
  description: string;
  partyId: string | null;
  externalReference: string | null;
  isReversal: boolean;
  reversalOf: string | null;
  lines: LedgerLine[];
}

export interface Account {
  code: string;
  name: string;
  class: "asset" | "liability" | "equity" | "income" | "expense" | string;
  category: string;
}

export interface TaxCode {
  code: string;
  name: string;
  ratePercent: number;
}

export interface Party {
  id: string;
  type: "customer" | "supplier" | "employee";
  name: string;
  relatedParty: boolean;
  relation: string;
  startDate: string;
  endDate: string;
}

export interface TrialBalanceRow {
  account: string;
  name: string;
  /** FY2024 comparative: closing balance for balance sheet accounts, full-year total for P&L accounts. */
  priorYearMinor: number;
  openingMinor: number;
  closingMinor: number;
}

export interface BankStatementLine {
  id: string;
  date: string;
  /** Positive is money in. */
  amountMinor: number;
  counterparty: string;
  reference: string;
  description: string;
  balanceMinor: number;
}

export interface CompanyUser {
  id: string;
  name: string;
  role: string;
  canPost: boolean;
  canApprove: boolean;
  approvalLimitMinor?: number | null;
}

export interface Engagement {
  firstYear: boolean;
  yearsAsAuditor: number;
  materialityMinor: { overall: number; performance: number; clearlyTrivial: number };
  fieldworkBudgetHours: number;
  partner: string;
}

export interface Company {
  name: string;
  companyNumber: string;
  registeredOffice: string;
  activity: string;
  employees: number;
  financialYear: { start: string; end: string };
  currency: string;
  amountsIn: string;
  ledgerSource: string;
  ledgerExportedAt: string;
  engagement: Engagement;
  users: CompanyUser[];
  controls: Record<string, string>;
}

/** The assertions the firm's methodology recognises. */
export type Assertion =
  | "existence"
  | "completeness"
  | "accuracy"
  | "cutOff"
  | "valuation"
  | "rightsAndObligations"
  | "classification"
  | "presentation"
  | "occurrence";

/**
 * What the engine emits. An `exception` is something the team must resolve;
 * an `openItem` is something worth a look that is not yet an exception.
 */
export interface Finding {
  kind: "exception" | "openItem";
  /** What the finding is about, in the team's words: a voucher, a supplier, a pattern. */
  subject: string;
  summary: string;
  assertion: Assertion | null;
  amountMinor: number | null;
  /** Vouchers, bank lines or party ids the finding rests on. Nothing without evidence. */
  evidenceIds: string[];
}

/** How the team resolved a finding after fieldwork. */
export type FindingOutcome = "misstatement" | "explained" | "notAnException";

export interface PriorYearFinding extends Omit<Finding, "evidenceIds"> {
  financialYear: number;
  id: string;
  outcome: FindingOutcome;
  explanation: string;
  misstatementMinor: number;
  /** The procedure that raised it, when known. */
  raisedBy: string | null;
}

/** One line of last year's programme as it was actually executed (data/clients/<id>/prior_year_plan.jsonl, continuing clients only). */
export interface PriorYearPlanLine {
  financialYear: number;
  procedureId: string;
  selected: boolean;
  budgetHours: number;
  actualHours: number;
  /** Ids of prior-year findings this procedure raised. */
  findingsRaised: string[];
  note: string;
}

// ---------- planning ----------

export type Area =
  | "revenue"
  | "debtors"
  | "purchasesCreditors"
  | "payroll"
  | "fixedAssets"
  | "bankCash"
  | "relatedParties"
  | "journalsManagementOverride"
  | "goingConcern"
  | "stock"
  | "openingBalances"
  | "vat"
  | "accrualsProvisions"
  | "completion";

/**
 * The minimum risk level at which the firm's programme expects a procedure to run.
 * `mandatory` procedures run on every engagement where they apply, whatever the risk.
 */
export type ProcedureLevel = "mandatory" | "baseline" | "elevated" | "significant";

/**
 * One procedure from the firm's audit programme. The programme is supplied as
 * prose (data/programme/audit_programme.md); this is the shape it parses to.
 */
export interface Procedure {
  id: string;
  area: Area;
  title: string;
  description: string;
  assertions: Assertion[];
  level: ProcedureLevel;
  /** Hours at the baseline extent. Scalable procedures cost more at higher extents. */
  hours: number;
  scalable: boolean;
  applicability: string;
}

/** One numbered paragraph of the planning notes (data/clients/<id>/planning_notes.md). */
export interface PlanningNote {
  /** The bracketed paragraph number, for example "N7". */
  id: string;
  /** The heading the paragraph sits under. */
  section: string;
  text: string;
}

export type RiskLevel = "notApplicable" | "baseline" | "elevated" | "significant";

/** The engine's view of one audit area. */
export interface RiskAssessment {
  area: Area;
  level: RiskLevel;
  assertions: Assertion[];
  rationale: string;
  /** Vouchers, bank line ids, planning note ids, prior-year finding ids, account codes or party ids. Nothing without evidence. */
  evidenceIds: string[];
}

/** One line of the tailored programme: a procedure selected or explicitly not selected. */
export interface PlannedProcedure {
  procedureId: string;
  selected: boolean;
  reason: string;
  evidenceIds: string[];
  /** For scalable procedures: the extent chosen (for example a sample size or "all MD-posted journals"). */
  extent: string | null;
  hours: number;
}

/** What `npm run cli -- plan <client>` writes, one per client. */
export interface AuditPlan {
  clientId: string;
  riskAssessment: RiskAssessment[];
  procedures: PlannedProcedure[];
  totalHours: number;
  budgetHours: number;
  /** What the plan does not cover, and what the engine could not assess and why. */
  limitations: string[];
}
