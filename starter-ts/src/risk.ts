/**
 * Risk rules. Each area's level is built from sources of four kinds (data, notes, prior year, standard),
 * combined by explicit rules. The rules are the firm's judgment written down; they are versioned with the plan.
 *
 *  R1  level = the highest severity among the area's sources (info sources are context only).
 *  R2  corroboration: elevated sources of two or more different kinds, with an exposure at or above
 *      performance materiality, make the area significant. Notes alone never make an area significant.
 *  R3  recurrence: a data signal sharing an assertion with a prior-year misstatement in the same area raises the area one
 *      level (into significant only if this year's recurring amount ≥ clearly trivial). Prior-year misstatements below
 *      clearly trivial do not raise a level by themselves, but count for R3: a recurring trivial error is still a failed control.
 *  R4  ISA (UK) 240.26: revenue fraud risk is presumed significant (occurrence, cut-off) unless rebutted; the rebuttal is a rule.
 *  R5  scope: an area is notApplicable only on facts (no stock, not VAT-registered, not a first-year audit), never for lack of signals.
 *  R6  one agreed notes claim is enough to raise an area, but notes alone raise it to elevated at most: significant needs the data or
 *      the prior year to corroborate (R2) or a size the engine computes (R7). Amounts quoted in notes are context (a contract value),
 *      not exposure, so they never make an area significant on their own. The number of paragraphs does not matter.
 *  R7  an estimate the notes say is needed, with nothing linked to it in the ledger (see estimateStatus), is significant; where the
 *      notes state a delivery shortfall and a contract value, the engine computes an indicative size (never the model). An estimate
 *      that reduces income makes revenue significant too, for accuracy only.
 *  R8  covenants tested on these accounts plus data showing misstated covenant inputs or liquidity stress → going concern significant.
 *
 *  Only amounts that could be misstated count as exposure: population sizes, balances and limits never do.
 *  "lowers" claims are recorded against the area but do not lower it below what the data says.
 *
 *  assessRisk collects the sources, then assessArea applies the rules to one area in a fixed order:
 *  R5 scope → standards (R4 presumption, ISA 510) → R1 → R6 → R2 → R7 (accruals, then revenue) → R8 → R3 → R4 wording.
 */
import type { Area, Assertion, RiskLevel } from "./types";
import { type ClientFile, accountsIn, closing, gbp, materiality, type Materiality } from "./file";
import type { Signal } from "./signals";
import type { MergedNotes } from "./notes";
import type { Feedback } from "./feedback";
import { AREAS } from "./notes";
import { LEVEL_RANK } from "./programme";

export const RULESET_VERSION = "2026.11-2";

export type SourceKind = "data" | "notes" | "priorYear" | "standard";
export interface Source {
  exposure?: boolean;
  kind: SourceKind;
  severity: "info" | "elevated" | "significant";
  assertions: Assertion[];
  amountMinor: number | null;
  text: string;
  evidenceIds: string[];
  ref: string;
}
export interface AreaRisk {
  area: Area;
  level: RiskLevel;
  assertions: Assertion[];
  rules: string[];
  sources: Source[];
  mitigating: Source[];
  exposureMinor: number | null;
  scopeReason: string | null;
  scopeEvidence: string[];
  /** When a rule raises the level for some assertions only, the level the other assertions keep. Extent reads it; absent means the area level holds for every assertion. */
  otherAssertionsLevel?: RiskLevel;
  liftedAssertions?: Assertion[];
  /** What the file cannot settle and the partner must: present only when a rule ends undetermined. */
  questions?: string[];
}

const LEVELS: RiskLevel[] = ["notApplicable", "baseline", "elevated", "significant"];
const up = (l: RiskLevel): RiskLevel => (l === "baseline" ? "elevated" : l === "elevated" ? "significant" : l);
const INCOME_REDUCING = /clawback|refund|rebate|shortfall|undeliver/i;

// ---------- facts the rules read ----------

export interface ScopeFacts {
  stockMaterial: boolean;
  vatRegistered: boolean;
  firstYear: boolean;
}
export function scopeFacts(f: ClientFile): ScopeFacts {
  const m = materiality(f);
  return {
    stockMaterial: Math.abs(closing(f, accountsIn(f, "stock"))) >= m.performance,
    vatRegistered: f.accounts.some((a) => /\bvat\b/i.test(a.name)),
    firstYear: f.company.engagement.firstYear,
  };
}

/** ISA 240 rebuttal: revenue is rebutted only when no person raises revenue (every revenue line comes from a system feed) and no manual journal credits revenue. */
function revenueRebuttal(f: ClientFile): { rebutted: boolean; why: string; evidenceIds: string[] } {
  const rev = [...accountsIn(f, "revenue"), ...accountsIn(f, "otherIncome")];
  const creditsRevenue = (l: { account: string; amountMinor: number }) => rev.includes(l.account) && l.amountMinor < 0;
  const people = f.ledger.filter(
    (e) => e.journal !== "manual" && !e.postedBy.startsWith("system") && e.lines.some(creditsRevenue),
  );
  const manualCredits = f.ledger.filter((e) => e.journal === "manual" && e.lines.some(creditsRevenue));
  if (!people.length && !manualCredits.length)
    return {
      rebutted: true,
      why: "rebutted: every credit to revenue in the year comes from a system feed (bank or card terminal), none is raised by a person and no manual journal credits revenue",
      evidenceIds: rev,
    };
  const who = [...new Set(people.map((e) => e.postedBy))];
  const raisedBy = people.length ? `${people.length} revenue entries are raised by ${who.join(", ")}` : "";
  const manual = manualCredits.length ? `${manualCredits.length} manual journals credit revenue` : "";
  return {
    rebutted: false,
    why: `presumed (ISA (UK) 240.26) and not rebutted: ${raisedBy}${raisedBy && manual ? "; " : ""}${manual}`,
    evidenceIds: [...who, ...manualCredits.map((e) => e.voucher)],
  };
}

/** Estimates go to the area whose balance they set: depreciation and useful lives to fixed assets, contract values and final accounts to revenue, stock to stock, the rest to accruals and provisions. */
export function estimateArea(description: string): Area {
  if (/depreciat|useful li|impairment of (fixed|tangible)/i.test(description)) return "fixedAssets";
  if (/final account|contract (revenue|value|price)|stage of completion|variation|retention/i.test(description))
    return "revenue";
  if (/\bstock|inventor|work in progress/i.test(description)) return "stock";
  return "accrualsProvisions";
}

/**
 * Deterministic size for a performance-shortfall estimate stated in prose: "delivered about 92%" of a contract whose
 * "value is 1,020,000" gives a shortfall of 8% of that value. Numbers are read by code from the paragraph, never by the model.
 */
export function shortfallBound(text: string): { amountMinor: number; basis: string } | null {
  const pct = /(?:delivered|achieved|performance of|delivery (?:was|of))\D{0,20}?(\d{1,3}(?:\.\d+)?)\s*%/i.exec(text);
  const val = /contract value (?:is|was|of)\s*£?\s*([\d,]+(?:\.\d+)?)/i.exec(text);
  if (!pct || !val) return null;
  const p = Number(pct[1]);
  const v = Number(val[1].replace(/,/g, ""));
  if (!(p > 0 && p < 100) || !(v > 0)) return null;
  const amountMinor = Math.round(((v * (100 - p)) / 100) * 100);
  return {
    amountMinor,
    basis: `${Math.round((100 - p) * 100) / 100}% undelivered of a ${gbp(Math.round(v * 100))} contract`,
  };
}

// ---------- sources: everything the rules weigh, by area ----------

/** Every source, by area: data signals, notes claims and estimates, prior-year misstatements and missed coverage. */
function collectSources(f: ClientFile, signals: Signal[], notes: MergedNotes, fb: Feedback, m: Materiality) {
  const sources = new Map<Area, Source[]>(AREAS.map((a) => [a, []]));
  const mitigating = new Map<Area, Source[]>(AREAS.map((a) => [a, []]));
  const add = (area: Area, s: Source) => sources.get(area)!.push(s);

  for (const s of signals)
    for (const a of s.areas)
      add(a, {
        kind: "data",
        severity: s.areaSeverity[a] ?? s.severity,
        assertions: s.assertions,
        amountMinor: s.amountMinor,
        exposure: s.exposure,
        text: s.summary,
        evidenceIds: s.evidenceIds,
        ref: s.id,
      });

  for (const c of notes.claims) {
    const src: Source = {
      kind: "notes",
      severity: "elevated",
      assertions: c.assertions,
      amountMinor: c.amountMinor,
      exposure: false,
      text: `${c.noteId} (hypothesis from the notes, to confirm in fieldwork): ${c.claim} ("${c.quote}")`,
      evidenceIds: [c.noteId],
      ref: `note:${c.noteId}`,
    };
    if (c.direction === "raises") add(c.area, src);
    else mitigating.get(c.area)!.push({ ...src, severity: "info" });
  }

  for (const e of notes.estimates) {
    const bound = e.amountMinor === null ? shortfallBound(f.notes.find((n) => n.id === e.noteId)?.text ?? "") : null;
    const amount = e.amountMinor ?? bound?.amountMinor ?? null;
    const computed = bound
      ? `; indicative size ${gbp(bound.amountMinor)} (${bound.basis}, computed by the engine from ${e.noteId})`
      : "";
    add(estimateArea(e.description), {
      kind: "notes",
      severity: "elevated",
      assertions: ["completeness", "valuation"],
      amountMinor: amount,
      exposure: amount !== null,
      text: `${e.noteId}: estimate needed: ${e.description} ("${e.quote}")${computed}`,
      evidenceIds: [e.noteId],
      ref: `estimate:${e.noteId}`,
    });
  }

  for (const p of f.pyFindings.filter((p) => p.outcome === "misstatement")) {
    const a = fb.findingArea(p);
    if (a)
      add(a, {
        kind: "priorYear",
        severity: p.misstatementMinor >= m.clearlyTrivial ? "elevated" : "info",
        assertions: p.assertion ? [p.assertion] : [],
        amountMinor: p.misstatementMinor,
        text: `${p.id} last year: ${p.summary} (${gbp(p.misstatementMinor)} misstatement; ${p.explanation})`,
        evidenceIds: [p.id],
        ref: p.id,
      });
  }

  for (const x of fb.missed)
    add(x.area, {
      kind: "priorYear",
      severity: "elevated",
      assertions: x.assertions.filter((a): a is Assertion => a !== null),
      amountMinor: f.pyFindings.find((p) => p.id === x.findingId)?.amountMinor ?? null,
      text: `missed coverage: ${x.reason}`,
      evidenceIds: x.evidenceIds,
      ref: `missed:${x.procedureId}`,
    });

  return { sources, mitigating };
}

// ---------- the rules, one function each ----------

/** What assessArea carries from rule to rule. */
interface Assessment {
  area: Area;
  level: RiskLevel;
  rules: string[];
  /** every source, standards included; what the plan prints */
  all: Source[];
  /** the sources that count (not info), fixed before R7 adds its revenue-side sources */
  raising: Source[];
  exposure: number | null;
  questions: string[];
  /** an assertion-specific lift (R7 revenue), kept unless a whole-area rule fires after it */
  lifted: { other: RiskLevel; assertions: Assertion[] } | null;
}

/** Everything the rules need that is the same for every area. */
interface Context {
  f: ClientFile;
  m: Materiality;
  scope: ScopeFacts;
  notes: MergedNotes;
  rebut: ReturnType<typeof revenueRebuttal>;
  status: (s: Source) => EstimateStatus;
  /** estimates under accruals and provisions that reduce income and are not booked: R7's revenue side */
  incomeReducing: Source[];
}

/** R5: an area is out of scope on facts only. */
function scopeOf(ctx: Context, area: Area): { reason: string; evidence: string[] } | null {
  const { f, scope } = ctx;
  if (area === "stock" && !scope.stockMaterial)
    return {
      reason: `stock accounts total ${gbp(closing(f, accountsIn(f, "stock")))}, below performance materiality`,
      evidence: ["company.json", ...accountsIn(f, "stock")],
    };
  if (area === "vat" && !scope.vatRegistered)
    return {
      reason: "the chart of accounts has no VAT control accounts: the company is not VAT-registered",
      evidence: ["company.json"],
    };
  if (area === "openingBalances" && !scope.firstYear)
    return {
      reason: `continuing engagement (year ${f.company.engagement.yearsAsAuditor}): opening balances were audited last year`,
      evidence: ["company.json"],
    };
  return null;
}

/** The standards that speak before the file does: the ISA 240 revenue presumption and ISA 510 on a first-year audit. */
function standardSources(ctx: Context, area: Area): Source[] {
  const out: Source[] = [];
  if (area === "revenue" && !ctx.rebut.rebutted)
    out.push({
      kind: "standard",
      severity: "significant",
      assertions: ["occurrence", "cutOff"],
      amountMinor: null,
      text: `fraud in revenue recognition ${ctx.rebut.why}`,
      evidenceIds: ctx.rebut.evidenceIds,
      ref: "ISA240.26",
    });
  if (area === "openingBalances")
    out.push({
      kind: "standard",
      severity: "elevated",
      assertions: ["existence", "completeness", "valuation"],
      amountMinor: null,
      text: "first-year audit: the prior year was not audited by us (ISA (UK) 510)",
      evidenceIds: ["company.json"],
      ref: "ISA510",
    });
  return out;
}

/** R1: the highest source sets the level. */
function r1Highest(a: Assessment) {
  for (const s of a.raising) if (LEVEL_RANK[s.severity] > LEVEL_RANK[a.level]) a.level = s.severity as RiskLevel;
  if (a.raising.length) a.rules.push(`R1 highest source: ${a.level}`);
}

/** R6: notes alone raise an area, and the rule says what would make it significant. */
function r6NotesAlone(a: Assessment) {
  const hard = a.raising.some((s) => s.kind !== "notes" && s.kind !== "standard"); // a standard is a presumption, not corroboration
  const paragraphs = [...new Set(a.raising.filter((s) => s.kind === "notes").map((s) => s.evidenceIds[0]))];
  if (!hard && paragraphs.length && a.level === "elevated")
    a.rules.push(
      `R6 raised by the notes alone (${paragraphs.join(", ")}): elevated at most until the data or the prior year corroborates it`,
    );
}

/** R2: two kinds of source and an exposure at or above performance materiality. */
function r2Corroborated(ctx: Context, a: Assessment) {
  const kinds = new Set(a.raising.map((s) => s.kind).filter((k) => k !== "standard"));
  const amounts = a.raising
    .filter((s) => s.exposure !== false)
    .map((s) => s.amountMinor)
    .filter((x): x is number => x !== null);
  a.exposure = amounts.length ? Math.max(...amounts) : null;
  if (a.level !== "significant" && kinds.size >= 2 && a.exposure !== null && a.exposure >= ctx.m.performance) {
    a.level = "significant";
    a.rules.push(
      `R2 corroborated by ${[...kinds].join(" + ")}, exposure ${gbp(a.exposure)} at or above performance materiality ${gbp(ctx.m.performance)}`,
    );
  }
}

/**
 * R7, accruals and provisions: an estimate the notes say is needed and the ledger does not hold. R7 is about "not done",
 * not "done badly": the estimate counts as made only when a posting names it (estimateStatus). Postings that name nothing
 * leave it undetermined, which stays significant and becomes a partner question; a booked estimate short of its computed
 * size is still the risk.
 */
function r7Accruals(ctx: Context, a: Assessment) {
  if (a.area !== "accrualsProvisions") return;
  const unchanged = a.raising.filter((s) => s.ref.startsWith("estimate:unchanged:"));
  const needed = a.raising.filter(
    (s) => s.ref.startsWith("estimate:N") && /provision|clawback|accrual|liabilit/i.test(s.text),
  );
  const open = needed.map((s) => ({ s, ...ctx.status(s) })).filter((x) => x.status !== "booked");
  if (!open.length) return;

  a.level = "significant"; // recorded even when R2 already got there: it is the reason a reviewer needs
  const sized = needed.filter((s) => s.amountMinor !== null);
  const size = sized.length
    ? `; indicative size ${sized.map((s) => `${gbp(s.amountMinor!)} (${s.evidenceIds[0]})`).join(", ")} against materiality ${gbp(ctx.m.overall)}`
    : "; its size cannot be bounded from the file";
  const note = (x: { s: Source }) => x.s.evidenceIds[0];

  const none = open.filter((x) => x.status === "unbooked" || x.status === "reversed");
  if (none.length) {
    const reversed = none.filter((x) => x.status === "reversed");
    const where = reversed.length
      ? reversed.map((x) => x.why).join("; ")
      : unchanged.length
        ? `${unchanged.map((s) => s.ref.split(":")[2]).join(", ")} unchanged all year`
        : "no posting to an accrual or provision account";
    a.rules.push(
      `R7 the notes say an estimate is needed (${none.map(note).join(", ")}) and the ledger holds nothing for it (${where})${size}`,
    );
  }
  for (const x of open.filter((x) => x.status === "short"))
    a.rules.push(`R7 the estimate the notes call for (${note(x)}) is booked but not adequately: ${x.why}`);
  for (const x of open.filter((x) => x.status === "undetermined")) {
    a.rules.push(
      `R7 the notes say an estimate is needed (${note(x)}) and no posting can be linked to it: ${x.why}; whether it was made is undetermined${size}`,
    );
    a.questions.push(`${note(x)}: ${x.why}. Has the estimate the notes call for been made, and where is it booked?`);
  }
}

/** R7, revenue side: the same unbooked estimate reduces income already recognised, so revenue is overstated by up to its size. Accuracy only. */
function r7Revenue(ctx: Context, a: Assessment) {
  if (a.area !== "revenue" || !ctx.incomeReducing.length) return;
  if (a.level !== "significant") a.lifted = { other: a.level, assertions: ["accuracy"] };
  a.level = "significant";
  // the service was delivered; what is wrong is the amount kept
  for (const x of ctx.incomeReducing) a.all.push({ ...x, severity: "significant", assertions: ["accuracy"] });

  const st = ctx.incomeReducing.map((x) => ({ x, ...ctx.status(x) }));
  const over = st
    .map(({ x, status, shortfallMinor }) =>
      status === "short"
        ? `${gbp(shortfallMinor!)} (${x.evidenceIds[0]}: what is booked falls short of ${gbp(x.amountMinor!)})`
        : x.amountMinor !== null
          ? `${gbp(x.amountMinor)} (${x.evidenceIds[0]})`
          : null,
    )
    .filter((t): t is string => t !== null);
  const anyShort = st.some((y) => y.status === "short");
  const what = st.every((y) => y.status === "unbooked" || y.status === "reversed")
    ? st.some((y) => y.status === "reversed")
      ? "what was booked for it was reversed in the year"
      : "nothing is booked for it"
    : st.every((y) => y.status === "short")
      ? "what is booked falls short of it"
      : "nothing booked can be linked to it";
  const notes = ctx.incomeReducing.map((x) => x.evidenceIds[0]).join(", ");
  const by = over.length ? `up to ${over.join(", ")}` : "an amount the file cannot bound";
  a.rules.push(
    `R7 an estimate the notes say is needed reduces income and ${what} (${notes}): revenue is ${anyShort ? "" : "recognised in full and "}overstated by ${by}`,
  );
}

/** R8: covenants tested on these accounts, with the data showing their inputs misstated or liquidity under stress. */
function r8Covenants(ctx: Context, a: Assessment) {
  if (a.area !== "goingConcern") return;
  const cov = ctx.notes.facts.borrowingCovenants;
  const covenantData = a.raising.filter(
    (s) => s.kind === "data" && (s.ref === "class:loan-interest" || s.ref === "bank:overdrawn"),
  );
  if (cov.value !== true || !covenantData.length) return;
  a.level = "significant";
  const shows = covenantData
    .map((s) =>
      s.ref === "bank:overdrawn"
        ? "liquidity stress (overdrawn)"
        : "covenant inputs misstated (loan interest posted elsewhere)",
    )
    .join(" and ");
  a.rules.push(
    `R8 borrowing covenants are tested on these accounts (${cov.noteId}: "${cov.quote}") and the data shows ${shows}: a breach would make the loan repayable and change its classification`,
  );
}

/** R3: a data signal sharing an assertion with a prior-year misstatement raises the area one level; into significant only above clearly trivial. */
function r3Recurrence(ctx: Context, a: Assessment) {
  // any size: a trivial error that recurs is still a control failure
  const pyMis = a.all.filter((s) => s.kind === "priorYear" && !s.ref.startsWith("missed:"));
  const shares = (s: Source, p: Source) => p.assertions.some((x) => s.assertions.includes(x));
  const recurring = a.raising.filter((s) => s.kind === "data" && pyMis.some((p) => shares(s, p)));
  if (!recurring.length || a.level === "significant") return;
  const recurringSize = Math.max(0, ...recurring.map((r) => r.amountMinor ?? 0));
  if (up(a.level) === "significant" && recurringSize < ctx.m.clearlyTrivial) return;
  a.level = up(a.level);
  const findings = [...new Set(pyMis.filter((p) => recurring.some((r) => shares(r, p))).map((p) => p.ref))];
  a.rules.push(
    `R3 recurrence of ${findings.join(", ")} in this year's data (${recurring.map((r) => r.ref).join(", ")})`,
  );
}

/** R4: the revenue presumption, stated whichever way it went; when rebutted, the rebuttal stays in the sources as context. */
function r4Revenue(ctx: Context, a: Assessment) {
  if (a.area !== "revenue") return;
  a.rules.push(`R4 ${ctx.rebut.rebutted ? ctx.rebut.why : "fraud risk presumed and not rebutted"}`);
  if (ctx.rebut.rebutted)
    a.all.push({
      kind: "standard",
      severity: "info",
      assertions: [],
      amountMinor: null,
      text: `fraud in revenue recognition ${ctx.rebut.why}`,
      evidenceIds: ctx.rebut.evidenceIds,
      ref: "ISA240.26",
    });
}

/** One area through every rule, in the order the header states. */
function assessArea(ctx: Context, area: Area, sources: Source[], mitigating: Source[]): AreaRisk {
  const scope = scopeOf(ctx, area);
  if (scope)
    return {
      area,
      level: "notApplicable",
      assertions: [],
      rules: [`R5 ${scope.reason}`],
      sources: [],
      mitigating: [],
      exposureMinor: null,
      scopeReason: scope.reason,
      scopeEvidence: scope.evidence,
    };

  const all = [...sources, ...standardSources(ctx, area)];
  const a: Assessment = {
    area,
    level: "baseline",
    rules: [],
    all,
    raising: all.filter((s) => s.severity !== "info"),
    exposure: null,
    questions: [],
    lifted: null,
  };
  r1Highest(a);
  r6NotesAlone(a);
  r2Corroborated(ctx, a);
  r7Accruals(ctx, a);
  r7Revenue(ctx, a);
  r8Covenants(ctx, a);
  r3Recurrence(ctx, a);
  r4Revenue(ctx, a);

  // a later rule that raises the whole area (R2, R3, R8) supersedes an assertion-specific lift
  const keep = a.lifted && !a.rules.some((r) => /^R(2|3|8) /.test(r));
  return {
    area,
    level: a.level,
    assertions: [...new Set(a.raising.flatMap((s) => s.assertions))].sort() as Assertion[],
    rules: a.rules,
    sources: a.all,
    mitigating,
    exposureMinor: a.exposure,
    scopeReason: null,
    scopeEvidence: [],
    ...(keep ? { otherAssertionsLevel: a.lifted!.other, liftedAssertions: a.lifted!.assertions } : {}),
    ...(a.questions.length ? { questions: a.questions } : {}),
  };
}

export function assessRisk(f: ClientFile, signals: Signal[], notes: MergedNotes, fb: Feedback): AreaRisk[] {
  const m = materiality(f);
  const { sources, mitigating } = collectSources(f, signals, notes, fb, m);
  // Is a needed estimate booked? Only postings that name it count: an unrelated accrual says nothing about this one.
  const status = (s: Source) =>
    estimateStatus(f, s, notes.estimates.find((e) => `estimate:${e.noteId}` === s.ref)?.description ?? "", m);
  const incomeReducing = sources
    .get("accrualsProvisions")!
    .filter((s) => s.ref.startsWith("estimate:N") && INCOME_REDUCING.test(s.text) && status(s).status !== "booked");
  const ctx: Context = { f, m, scope: scopeFacts(f), notes, rebut: revenueRebuttal(f), status, incomeReducing };
  return AREAS.map((area) => assessArea(ctx, area, sources.get(area)!, mitigating.get(area)!));
}

// ---------- is a needed estimate in the ledger? ----------

/** Words that every estimate description shares and so cannot identify one. */
const GENERIC = new Set(
  "provision provisions accrual accruals estimate estimates for the and of with from year end posted by external accountants balance adjustment".split(
    " ",
  ),
);
const stem = (w: string) => (w.length > 3 ? w.replace(/s$/, "") : w);
const words = (text: string) => text.toLowerCase().match(/[a-z]+/g) ?? [];

export type EstimateStatus = {
  status: "booked" | "short" | "unbooked" | "reversed" | "undetermined";
  why: string;
  vouchers: string[];
  shortfallMinor: number | null;
};

/**
 * Whether the estimate a note calls for is in the ledger, and whether enough of it is.
 *
 * A posting to an accrual or provision account that names one word of the estimate is only a candidate. It is linked when it
 * names the estimate itself: at least two of its words (both, if it has two), and, for an estimate that reduces income (a
 * clawback, refund, rebate or shortfall), a debit to the income it reduces. "NHS pension accrual" shares a word with "NHS
 * clawback" but debits wages: a candidate, not a match.
 *
 * A linked posting is read net of what later undoes it: its reversals (reversalOf), and named postings that release the
 * same account (a debit to the provision, crediting the income back). A provision booked and reversed in the year is not a
 * provision.
 *  - unbooked: no accrual or provision account carries any posting;
 *  - undetermined: postings exist but none is linked (or a linked one is trivial and the file cannot size the estimate);
 *  - reversed: linked postings exist but their reversals and releases leave less than clearly trivial;
 *  - short: what remains is less than the size the engine computes, by at least performance materiality;
 *  - booked: otherwise.
 */
export function estimateStatus(
  f: ClientFile,
  s: Source,
  description: string,
  m: { performance: number; clearlyTrivial: number },
): EstimateStatus {
  const accounts = f.tb.filter((r) => /accrual|provision/i.test(r.name)).map((r) => r.account);
  const postings = f.ledger.filter((e) => e.lines.some((l) => accounts.includes(l.account)));
  if (!postings.length)
    return {
      status: "unbooked",
      why: "no posting to an accrual or provision account",
      vouchers: [],
      shortfallMinor: null,
    };
  type Posting = (typeof postings)[number];

  // what the estimate is called, and which postings call it that
  const subject = [...new Set(words(description).filter((w) => w.length >= 3 && !GENERIC.has(w)))];
  const terms = [...new Set(subject.map(stem))];
  const named = (e: Posting) => {
    const ws = words([e.description, ...e.lines.map((l) => l.description ?? "")].join(" "));
    return terms.filter((t) => ws.some((w) => stem(w) === t));
  };
  const namesIt = (e: Posting) => named(e).length >= Math.min(2, terms.length);

  // for an estimate that reduces income, the booking debits income and a release credits it back
  const income = [...accountsIn(f, "revenue"), ...accountsIn(f, "otherIncome")];
  const reducesIncome = INCOME_REDUCING.test(description);
  const debitsIncome = (e: Posting) => e.lines.some((l) => income.includes(l.account) && l.amountMinor > 0);
  const creditsIncome = (e: Posting) => e.lines.some((l) => income.includes(l.account) && l.amountMinor < 0);
  const debitsProvision = (e: Posting) => e.lines.some((l) => accounts.includes(l.account) && l.amountMinor > 0);

  const candidates = postings.filter((e) => named(e).length > 0);
  const linked = candidates.filter((e) => namesIt(e) && (!reducesIncome || debitsIncome(e)));
  const reversesLinked = (e: Posting) => e.reversalOf !== null && linked.some((l) => l.voucher === e.reversalOf);
  const releasesIt = (e: Posting) => namesIt(e) && debitsProvision(e) && (!reducesIncome || creditsIncome(e));
  const undone = postings.filter((e) => !linked.includes(e) && (reversesLinked(e) || releasesIt(e)));

  const onAccounts = (xs: Posting[]) =>
    xs.reduce(
      (t, e) => t + e.lines.filter((l) => accounts.includes(l.account)).reduce((u, l) => u + l.amountMinor, 0),
      0,
    );
  const booked = -onAccounts(linked);
  const released = onAccounts(undone);
  const credited = booked - released;
  const ids = linked.map((e) => e.voucher).join(", ");
  const vouchers = [...linked, ...undone].map((e) => e.voucher);
  const plural = (n: number, one: string, many: string) => (n > 1 ? many : one);

  if (linked.length && undone.length && credited < m.clearlyTrivial) {
    const undoneIds = undone
      .map((e) => `${e.voucher}${e.reversalOf ? ` (reversal of ${e.reversalOf})` : ""}`)
      .join(", ");
    return {
      status: "reversed",
      why: `${ids} booked ${gbp(booked)} and ${undoneIds} ${plural(undone.length, "releases", "release")} ${gbp(released)} in the same year: ${gbp(Math.max(0, credited))} remains`,
      vouchers,
      shortfallMinor: null,
    };
  }
  if (linked.length) {
    const size = s.amountMinor;
    const net = undone.length ? ` net of ${undone.map((e) => e.voucher).join(", ")}` : "";
    if (size !== null && size - credited >= m.performance)
      return {
        status: "short",
        why: `${ids} ${plural(linked.length, "books", "book")} ${gbp(Math.max(0, credited))}${net} against an indicative ${gbp(size)}, short by ${gbp(size - credited)}, at or above performance materiality ${gbp(m.performance)}`,
        vouchers,
        shortfallMinor: size - credited,
      };
    if (size !== null || credited >= m.clearlyTrivial)
      return { status: "booked", why: `booked by ${ids}${net}`, vouchers, shortfallMinor: null };
  }

  // undetermined: say which postings were looked at and why none counts
  const why = linked.length
    ? `${ids} ${plural(linked.length, "names", "name")} ${s.evidenceIds[0]}'s estimate but ${plural(linked.length, "credits", "credit")} ${gbp(Math.max(0, credited))}, below clearly trivial`
    : candidates.length
      ? `${candidates.map((e) => describeCandidate(f, e, reducesIncome && !debitsIncome(e))).join("; ")} ${plural(candidates.length, "shares only a word", "share only words")} with the estimate: a candidate, not a match`
      : `the ${postings.length} posting${plural(postings.length, "", "s")} to accrual and provision accounts (${listVouchers(postings)}) ${plural(postings.length, "names", "name")} none of ${subject.join(", ") || "its subject"}`;
  return { status: "undetermined", why, vouchers: postings.map((e) => e.voucher), shortfallMinor: null };
}

function describeCandidate(f: ClientFile, e: ClientFile["ledger"][number], wrongSide: boolean): string {
  const nameOf = (a: string) => `${a} ${f.accounts.find((x) => x.code === a)?.name ?? ""}`.trim();
  const debits = e.lines
    .filter((l) => l.amountMinor > 0)
    .map((l) => nameOf(l.account))
    .join(", ");
  return `${e.voucher} ("${e.description}"${wrongSide ? `, debiting ${debits}, not income` : ""})`;
}

function listVouchers(xs: ClientFile["ledger"]): string {
  return (
    xs
      .slice(0, 5)
      .map((e) => e.voucher)
      .join(", ") + (xs.length > 5 ? ` and ${xs.length - 5} more` : "")
  );
}

export const levelOf = (risks: AreaRisk[], area: Area): RiskLevel => risks.find((r) => r.area === area)!.level;
export { LEVELS };
