/**
 * The programme's "Applicability" lines as code, one rule per procedure. Each quotes the line it implements.
 * A rule answers on facts from the file; where the file cannot answer, it says so (`unknown`) and the
 * question goes to the partner instead of being guessed.
 */
import type { Area, RiskLevel } from "./types";
import { type ClientFile, accountsIn, bankAccounts, closing, gbp, materiality } from "./file";
import type { Signal } from "./signals";
import type { MergedNotes, FactKey } from "./notes";
import type { AreaRisk } from "./risk";
import { scopeFacts } from "./risk";
import { LEVEL_RANK } from "./programme";

export interface Applicability {
  applies: boolean;
  because: string;
  evidenceIds: string[];
  unknown?: boolean;
  /** True when the programme names this condition as sufficient on its own ("relied upon or … elevated"): the procedure is selected whatever the area's level. */ selects?: boolean;
}
export interface ApplicabilityContext {
  f: ClientFile;
  signals: Signal[];
  notes: MergedNotes;
  risks: AreaRisk[];
}
type Rule = (c: ApplicabilityContext) => Applicability;

const yes = (because: string, evidenceIds: string[] = []): Applicability => ({ applies: true, because, evidenceIds });
const no = (because: string, evidenceIds: string[] = []): Applicability => ({ applies: false, because, evidenceIds });
const all: Rule = () => yes("applies to all engagements");
const level = (c: ApplicabilityContext, a: Area): RiskLevel => c.risks.find((r) => r.area === a)!.level;
const atLeast = (c: ApplicabilityContext, a: Area, l: RiskLevel) => LEVEL_RANK[level(c, a)] >= LEVEL_RANK[l];
const hasAssertion = (c: ApplicabilityContext, a: Area, x: string) =>
  c.risks.find((r) => r.area === a)!.assertions.includes(x as never);
const sig = (c: ApplicabilityContext, prefix: string) =>
  c.signals.filter((s) => s.id.startsWith(prefix) && s.severity !== "info");

function noteFact(c: ApplicabilityContext, k: FactKey, what: string): Applicability {
  const fact = c.notes.facts[k];
  if (fact.value === true) return yes(`${what}: ${fact.noteId} says "${fact.quote}"`, [fact.noteId!]);
  if (fact.value === false) return no(`${fact.noteId} rules out that ${what}: "${fact.quote}"`, [fact.noteId!]);
  return {
    applies: false,
    unknown: true,
    because: `the file does not say whether ${what}; treated as not applying and put to the partner`,
    evidenceIds: [],
  };
}

const tradeDebtors = (f: ClientFile) => f.accounts.filter((a) => /trade debtor/i.test(a.name)).map((a) => a.code);
const tradeCreditors = (f: ClientFile) => f.accounts.filter((a) => /trade creditor/i.test(a.name)).map((a) => a.code);
const withTradeDebtors: Rule = ({ f }) => {
  const codes = tradeDebtors(f);
  const any =
    codes.some((c) => f.tb.find((r) => r.account === c && (r.closingMinor !== 0 || r.priorYearMinor !== 0))) ||
    f.ledger.some((e) => e.journal === "sales");
  return any
    ? yes("the company has trade debtors", codes)
    : no(
        "no trade debtors: the debtors account is nil at both year ends and there is no sales ledger (income is received when earned)",
        codes,
      );
};
const vatRegistered: Rule = ({ f }) =>
  scopeFacts(f).vatRegistered
    ? yes(
        "VAT-registered: VAT control accounts are in use",
        f.accounts.filter((a) => /\bvat\b/i.test(a.name)).map((a) => a.code),
      )
    : no("not VAT-registered: no VAT control accounts in the chart", ["company.json"]);
const stockMaterial: Rule = ({ f }) => {
  const codes = accountsIn(f, "stock"),
    total = closing(f, codes);
  return Math.abs(total) >= materiality(f).performance
    ? yes(`stock is material (${(total / 100).toLocaleString("en-GB")} at the year end)`, codes)
    : no("stock is not material or not held", ["company.json", ...codes]);
};

export const APPLICABILITY: Record<string, Rule> = {
  // Revenue
  "REV-01": all,
  "REV-02": all,
  "REV-03": (c) => {
    const manual = sig(c, "journal:").filter((s) => s.mustTest["REV-03"]);
    if (manual.length)
      return yes(
        `manual revenue entries exist: ${manual.map((s) => s.mustTest["REV-03"].join(", ")).join(", ")}`,
        manual.flatMap((s) => s.mustTest["REV-03"]),
      );
    if (level(c, "revenue") === "significant") return yes("revenue is a significant risk");
    return no("no manual or non-standard credits to revenue in the ledger, and revenue is not a significant risk");
  },
  // The notes say whether contracts span the year end; the ledger says whether revenue is billed on them. Stage-of-completion
  // revenue is invoiced to customers, so with no sales ledger the "contract" is a funding arrangement (a NHS contract paid
  // monthly), and its clawback is an estimate handled by ACC-01 and JNL-02, not contract revenue.
  "REV-04": (c) => {
    const fact = noteFact(c, "longTermContractsSpanYearEnd", "long-term contracts span the year end");
    if (fact.unknown && !c.f.notes.some((n) => /contract/i.test(n.text)))
      return no(
        "no paragraph of the planning notes mentions a contract, and nothing in the ledger is billed by stage of completion",
        ["company.json"],
      );
    if (!fact.applies) return fact;
    if (!c.f.ledger.some((e) => e.journal === "sales"))
      return no(
        `the notes mention a contract spanning the year end (${fact.evidenceIds[0]}), but the company raises no sales invoices, so no revenue is recognised by stage of completion; the contract's clawback is addressed as an estimate (ACC-01, JNL-02)`,
        [...fact.evidenceIds, ...tradeDebtors(c.f)],
      );
    return fact;
  },
  "REV-05": withTradeDebtors,
  "REV-06": ({ f }) => {
    const rev = accountsIn(f, "revenue");
    const lines = f.ledger
      .filter((e) => e.journal === "cash")
      .flatMap((e) => e.lines.filter((l) => rev.includes(l.account)));
    const takings = -lines.reduce((t, l) => t + l.amountMinor, 0);
    const credited = [...new Set(lines.map((l) => l.account))].sort();
    return takings >= materiality(f).performance
      ? yes(
          `cash and card takings are a material revenue stream (${gbp(takings)} credited to ${credited.join(", ")} through the takings journal)`,
          credited,
        )
      : no("no material cash or card takings");
  },
  // Debtors
  "DEB-01": withTradeDebtors,
  "DEB-02": (c) =>
    atLeast(c, "debtors", "significant") && hasAssertion(c, "debtors", "existence")
      ? yes("debtor existence is a significant risk")
      : no(`debtor existence is not a significant risk (debtors assessed ${level(c, "debtors")})`),
  "DEB-03": all,
  // Purchases and creditors
  "PUR-01": all,
  "PUR-02": ({ f }) =>
    tradeCreditors(f).some((c) => f.tb.find((r) => r.account === c && r.closingMinor !== 0))
      ? yes("the company has trade creditors", tradeCreditors(f))
      : no("no trade creditors"),
  "PUR-03": (c) => {
    if (atLeast(c, "purchasesCreditors", "elevated"))
      return yes(`purchases are assessed ${level(c, "purchasesCreditors")}`);
    // the plan relies on a control when it downgrades a signal by pointing at that control's test last year
    const relied = c.signals.filter((s) => s.reliesOn?.length && s.areas.includes("purchasesCreditors"));
    if (relied.length) {
      const ids = [...new Set(relied.flatMap((s) => s.reliesOn!))];
      return {
        selects: true,
        ...yes(
          `the plan relies on the approval control: it treats ${relied.map((s) => s.id.split(":").at(-1)).join(", ")}'s self-approval as explained because of the compensating control tested last year (${ids.join(", ")}); PUR-03 tests that the control still operates`,
          [
            ...ids,
            ...Object.keys(c.f.company.controls)
              .filter((k) => /purchase/i.test(k))
              .map((k) => `control:${k}`),
          ],
        ),
      };
    }
    return {
      applies: false,
      unknown: true,
      because: "purchases are baseline; whether the team relies on the approval control is not recorded in the file",
      evidenceIds: Object.keys(c.f.company.controls)
        .filter((k) => /purchase/i.test(k))
        .map((k) => `control:${k}`),
    };
  },
  "PUR-04": ({ f }) =>
    f.ledger.some((e) => e.journal === "purchases")
      ? yes("the company keeps a purchase ledger")
      : no("no purchase ledger"),
  "PUR-05": all,
  // Payroll
  "PAY-01": ({ f }) =>
    f.company.employees > 0 ? yes(`${f.company.employees} employees`, ["company.json"]) : no("no employees"),
  "PAY-02": (c) => {
    const py = c.f.pyFindings.filter(
      (p) => p.outcome === "misstatement" && /leaver|starter/i.test(`${p.subject} ${p.summary} ${p.explanation}`),
    );
    if (py.length)
      return yes(
        `the prior year found leaver or starter errors (${py.map((p) => p.id).join(", ")})`,
        py.map((p) => p.id),
      );
    return atLeast(c, "payroll", "elevated")
      ? yes(`payroll is assessed ${level(c, "payroll")}`)
      : no("payroll is baseline and the prior year found no leaver or starter errors");
  },
  "PAY-03": ({ f }) => {
    const approvers = [
      ...new Set(
        f.ledger
          .filter((e) => e.journal === "payroll")
          .map((e) => e.approvedBy)
          .filter((x): x is string => !!x),
      ),
    ];
    const weak = approvers.filter((u) => f.company.users.find((x) => x.id === u)?.canPost);
    return weak.length
      ? yes(
          `segregation in payroll is weak: the payroll is approved by ${weak.join(", ")}, who can also post to the ledger`,
          weak,
        )
      : no("payroll approval is segregated from posting");
  },
  "PAY-04": ({ f }) =>
    f.company.employees > 0 ? yes(`${f.company.employees} employees`, ["company.json"]) : no("no employees"),
  // Fixed assets
  "FA-01": ({ f }) =>
    accountsIn(f, "fixedAssets").some((c) => f.tb.find((r) => r.account === c && r.closingMinor !== 0))
      ? yes("the company has fixed assets", accountsIn(f, "fixedAssets"))
      : no("no fixed assets"),
  "FA-02": (c) => {
    if (atLeast(c, "fixedAssets", "significant") && hasAssertion(c, "fixedAssets", "existence"))
      return yes("fixed asset existence is a significant risk");
    const v = noteFact(
      c,
      "assetRegisterVerifiedWithinThreeYears",
      "the asset register has been physically verified in the last three years",
    );
    return v.unknown
      ? v
      : v.applies
        ? no(`the register was verified recently: ${v.because}`, v.evidenceIds)
        : yes(`the register has not been verified in three years: ${v.because}`, v.evidenceIds);
  },
  "FA-03": (c) => noteFact(c, "impairmentIndicators", "there are indicators of impairment"),
  // Bank and cash
  "BNK-01": all,
  "BNK-02": all,
  "BNK-03": ({ f, signals }) => {
    const bank = bankAccounts(f);
    const manual = f.ledger.filter((e) => e.journal === "manual" && e.lines.some((l) => bank.includes(l.account)));
    const diffs = signals.filter((s) => s.id.startsWith("bank:") && s.severity !== "info" && s.id !== "bank:overdrawn");
    const cash =
      f.accounts.some((a) => /cash in hand|float/i.test(a.name)) && f.ledger.some((e) => e.journal === "cash");
    const why = [
      manual.length ? `${manual.length} manual journals to the bank account` : "",
      cash ? "cash is handled" : "",
      diffs.length ? "the bank does not agree to the ledger" : "",
    ].filter(Boolean);
    return why.length
      ? yes(why.join("; "), [...manual.map((e) => e.voucher), ...diffs.flatMap((s) => s.evidenceIds.slice(0, 1))])
      : no("no manual journals to bank, no cash handling and no reconciliation differences");
  },
  // Related parties
  "RP-01": all,
  "RP-02": ({ f, signals }) => {
    const tx = signals.filter((s) => s.id.startsWith("rp:transactions:") || s.id === "rp:personal-expenditure");
    const family = f.parties.filter((p) => p.relatedParty && p.type === "employee" && !/director/i.test(p.relation));
    if (tx.length || family.length)
      return yes(
        [
          tx.length ? "transactions with related parties are in the ledger" : "",
          family.length
            ? `related persons who are not directors are on the payroll (${family.map((p) => p.name).join(", ")})`
            : "",
        ]
          .filter(Boolean)
          .join("; "),
        [...tx.flatMap((s) => s.evidenceIds.slice(0, 1)), ...family.map((p) => p.id)],
      );
    return no(
      "no related-party transactions beyond directors' remuneration",
      f.parties.filter((p) => p.relatedParty).map((p) => p.id),
    );
  },
  "RP-03": ({ f, signals }) => {
    const s = signals.filter((s) => s.id.startsWith("rp:director-balance:") || s.id === "rp:personal-expenditure");
    const dla = f.tb.filter((r) => /director/i.test(r.name) && (r.closingMinor !== 0 || r.openingMinor !== 0));
    return s.length || dla.length
      ? yes("a director's balance or personal expenditure exists or existed in the year", [
          ...s.flatMap((x) => x.evidenceIds.slice(0, 2)),
          ...dla.map((r) => r.account),
        ])
      : no("no director's balance or personal expenditure found in the ledger");
  },
  // Journals
  "JNL-01": all,
  "JNL-02": all,
  "JNL-03": all,
  // Going concern
  "GC-01": all,
  "GC-02": (c) => {
    let cov = noteFact(c, "borrowingCovenants", "borrowing covenants exist");
    if (cov.applies) return cov;
    // covenants need borrowings: with no borrowing account in the chart and nothing in the trial balance, the file settles it
    const borrowing = c.f.accounts.filter(
      (a) =>
        a.category === "longTermLiabilities" ||
        /loan|borrow|overdraft|hire purchase|finance lease|debenture/i.test(a.name),
    );
    if (
      cov.unknown &&
      !borrowing.some((a) =>
        c.f.tb.some((r) => r.account === a.code && (r.closingMinor !== 0 || r.priorYearMinor !== 0)),
      )
    )
      cov = no(
        `no borrowings: the chart has ${borrowing.length ? `no balance on ${borrowing.map((a) => a.code).join(", ")}` : "no loan, overdraft or lease account"}, so there are no covenants`,
        ["company.json"],
      );
    return atLeast(c, "goingConcern", "significant")
      ? yes("going concern is a significant risk")
      : cov.unknown
        ? cov
        : no(`${cov.because}, and going concern is not a significant risk`, cov.evidenceIds);
  },
  // Stock
  "STK-01": stockMaterial,
  "STK-02": stockMaterial,
  // Opening balances
  "OB-01": ({ f }) =>
    f.company.engagement.firstYear
      ? yes("first-year engagement", ["company.json"])
      : no(`continuing engagement, year ${f.company.engagement.yearsAsAuditor}`, ["company.json"]),
  // VAT
  "VAT-01": vatRegistered,
  "VAT-02": (c) => {
    const reg = vatRegistered(c);
    if (!reg.applies) return reg;
    const py = c.f.pyFindings.filter((p) => p.outcome === "misstatement" && p.raisedBy?.startsWith("VAT"));
    const hosp = sig(c, "class:hospitality").concat(sig(c, "rp:personal-expenditure"));
    if (py.length || hosp.length)
      return yes(
        [
          py.length ? `the prior year found VAT errors (${py.map((p) => p.id).join(", ")})` : "",
          hosp.length ? "this year's ledger shows input VAT reclaimed on hospitality or non-business costs" : "",
        ]
          .filter(Boolean)
          .join("; "),
        [...py.map((p) => p.id), ...hosp.flatMap((s) => s.evidenceIds.slice(0, 2))],
      );
    return no("no prior-year VAT errors and no significant entertaining");
  },
  // Accruals
  "ACC-01": all,
  // Completion
  "COMP-01": all,
  "COMP-02": all,
};
