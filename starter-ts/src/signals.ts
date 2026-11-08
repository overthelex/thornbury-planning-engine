/**
 * Detectors: deterministic tests over the ledger, the bank, the trial balance and the party register.
 * Every detector is client-agnostic: thresholds come from the engagement's materiality, accounts are
 * found by category or name, people by role. A detector never names a client.
 */
import type { Area, Assertion, LedgerEntry } from "./types";
import {
  type ClientFile,
  accountOf,
  accountsIn,
  bankAccounts,
  closing,
  daysBetween,
  gbp,
  grossOf,
  materiality,
  partyOf,
  seniorUsers,
  tbRow,
  valueOf,
  yearEnd,
} from "./file";

export type Severity = "info" | "elevated" | "significant";
export interface Signal {
  /** Stable id: detector plus subject, so plans diff cleanly year on year. */
  id: string;
  detector: string;
  areas: Area[];
  assertions: Assertion[];
  severity: Severity;
  /** The exposure this signal itself evidences, in pence (not the balance it sits in). */
  amountMinor: number | null;
  summary: string;
  evidenceIds: string[];
  /** Items a procedure must cover in full, whatever its sample: procedure id → vouchers or bank lines. */
  mustTest: Record<string, string[]>;
  /** False when amountMinor is a population or balance size, not an amount that could be misstated: such amounts never count as exposure. */
  exposure: boolean;
  /** Per-area severity where it differs from `severity` (a journal is significant for override, only elevated for the balance it lands in). */
  areaSeverity: Partial<Record<Area, Severity>>;
  /** Prior-year findings whose tested compensating control this signal's downgrade rests on: the plan relies on that control this year. */
  reliesOn?: string[];
}

const sig = (
  s: Omit<Signal, "mustTest" | "exposure" | "areaSeverity"> &
    Partial<Pick<Signal, "mustTest" | "exposure" | "areaSeverity">>,
): Signal => ({ mustTest: {}, exposure: true, areaSeverity: {}, ...s });

// ---------- routing a ledger line to an audit area ----------

export function areaOfAccount(f: ClientFile, code: string, partyId: string | null = null): Area {
  const a = accountOf(f, code);
  const name = a?.name ?? code;
  const related = partyOf(f, partyId)?.relatedParty === true;
  switch (a?.category) {
    case "revenue":
    case "otherIncome":
      return "revenue";
    case "fixedAssets":
      return "fixedAssets";
    case "stock":
      return "stock";
    case "cash":
      return "bankCash";
    case "staffCosts":
      return "payroll";
    case "longTermLiabilities":
      return "goingConcern";
    case "equity":
      return "completion";
  }
  if (/\bstock|inventor/i.test(name)) return "stock"; // "Stock movement" sits in cost of sales but is the stock balance's other side
  if (/vat/i.test(name)) return "vat";
  if (/director/i.test(name) || (related && /other debtor/i.test(name))) return "relatedParties";
  if (/debtor|prepayment/i.test(name)) return "debtors";
  if (/paye|ni payable|pension/i.test(name)) return "payroll";
  if (/accrual|provision/i.test(name)) return "accrualsProvisions";
  if (/depreciation/i.test(name)) return "fixedAssets";
  if (/loan|interest/i.test(name)) return "goingConcern";
  return "purchasesCreditors";
}

const stem = (d: string) =>
  d
    .toLowerCase()
    .replace(
      /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(tember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b/g,
      "",
    )
    .replace(/[0-9]+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
const uniq = <T>(xs: T[]) => [...new Set(xs)];
const byValueDesc = (a: LedgerEntry, b: LedgerEntry) => valueOf(b) - valueOf(a) || a.voucher.localeCompare(b.voucher);

/** A prior-year finding about this person that the team resolved as not a problem: used to stop re-flagging known, explained behaviour. */
function explainedLastYear(f: ClientFile, userId: string, pattern: RegExp) {
  const user = f.company.users.find((u) => u.id === userId);
  return f.pyFindings.find(
    (p) =>
      p.outcome !== "misstatement" &&
      (p.subject.includes(userId) || (user && p.subject.includes(user.name))) &&
      pattern.test(`${p.subject} ${p.summary}`),
  );
}

// ---------- 1. manual journals ----------

/** What one manual journal looks like: the flags, and the facts the signal is built from. */
interface JournalProfile {
  flags: string[];
  keyedAfterYe: boolean;
  revCreditMinor: number;
  staffMisposted: boolean;
}

/**
 * Routine means periodic: three or more entries of one description, never two in the same month. Copies do not qualify.
 * Returns each manual journal's group, or null when it is not part of a routine.
 */
function routineGroups(manual: LedgerEntry[]): Map<LedgerEntry, LedgerEntry[] | null> {
  const byStem = new Map<string, LedgerEntry[]>();
  for (const e of manual) byStem.set(stem(e.description), [...(byStem.get(stem(e.description)) ?? []), e]);
  const periodic = (g: LedgerEntry[]) =>
    g.length >= 3 && new Set(g.map((x) => x.postingDate.slice(0, 7))).size === g.length;
  return new Map(
    manual.map((e) => [e, periodic(byStem.get(stem(e.description))!) ? byStem.get(stem(e.description))! : null]),
  );
}

/** The flags that describe how a journal was posted rather than what it does. */
function processFlags(f: ClientFile, e: LedgerEntry, senior: string[]): string[] {
  const sys = e.systemEntryTime;
  const hour = Number(sys.slice(11, 13));
  const weekend = [0, 6].includes(new Date(sys).getUTCDay());
  const out: string[] = [];
  if (!e.approvedBy) out.push("no approver");
  if (e.approvedBy && e.approvedBy === e.postedBy) out.push("approved by the person who posted it");
  if (senior.includes(e.postedBy)) out.push(`posted by ${e.postedBy} (unlimited approval authority)`);
  if ((hour < 7 || hour >= 20) && !explainedLastYear(f, e.postedBy, /hour|evening|night/i))
    out.push(`keyed at ${sys.slice(11, 16)}`);
  if (weekend && !explainedLastYear(f, e.postedBy, /weekend|saturday|sunday/i)) out.push("keyed at a weekend");
  return out;
}

/**
 * Every flag on one manual journal, in the order the summary prints them.
 * Repetition lowers suspicion only for what repeats: a process flag (how a journal is posted) that every entry of a
 * periodic group shares is how that routine is run. Content flags (what the journal does), and anything this entry does
 * that its group does not, are never waived by repetition.
 */
function profileJournal(f: ClientFile, e: LedgerEntry, group: LedgerEntry[] | null, senior: string[]): JournalProfile {
  const m = materiality(f);
  const ye = yearEnd(f);
  const revenue = [...accountsIn(f, "revenue"), ...accountsIn(f, "otherIncome")];
  const bank = bankAccounts(f);
  const value = valueOf(e);
  const sys = e.systemEntryTime;
  const keyedAfterYe = sys.slice(0, 10) > ye && e.postingDate <= ye;
  const proc = processFlags(f, e, senior);
  const shared = (x: string) => !!group && group.every((o) => o === e || processFlags(f, o, senior).includes(x));
  const isTiming = (x: string) => /^keyed at/.test(x);
  const flags: string[] = [];

  // timing against the year end
  if (keyedAfterYe && (daysBetween(ye, sys) > 30 || (!e.approvedBy && !shared("no approver"))))
    flags.push(`keyed ${sys.slice(0, 10)}, ${daysBetween(ye, sys)} days after the year end, into ${e.postingDate}`);
  // process: approval and authority, unless the whole routine runs that way
  flags.push(...proc.filter((x) => !isTiming(x) && !shared(x)));
  // content
  if (value >= m.clearlyTrivial && value % 100_000 === 0) flags.push("round sum");
  flags.push(...proc.filter((x) => isTiming(x) && !shared(x)));
  const revCreditMinor = e.lines
    .filter((l) => revenue.includes(l.account) && l.amountMinor < 0)
    .reduce((s, l) => s - l.amountMinor, 0);
  if (revCreditMinor > 0) flags.push("credits revenue outside the sales ledger");
  if (e.lines.some((l) => bank.includes(l.account))) flags.push("moves cash by manual journal");
  const staffMisposted = e.lines.find(
    (l) =>
      partyOf(f, l.partyId)?.type === "employee" &&
      accountOf(f, l.account)?.category !== "staffCosts" &&
      !/debtor|director/i.test(accountOf(f, l.account)?.name ?? ""),
  );
  if (staffMisposted)
    flags.push(
      `amount to employee ${staffMisposted.partyId} coded to ${staffMisposted.account} ${accountOf(f, staffMisposted.account)?.name}`,
    );
  if (e.description.trim().length < 12) flags.push(`description is only "${e.description}"`);
  const original = e.reversalOf ? f.ledger.find((x) => x.voucher === e.reversalOf) : undefined;
  if (original && valueOf(original) !== value)
    flags.push(`reverses ${original.voucher} (${gbp(valueOf(original))}) for a different amount`);
  // an amount unlike the rest of a fixed-amount routine is the entry that differs
  if (group) {
    const others = group.filter((o) => o !== e).map(valueOf);
    if (others.every((v) => v === others[0]) && Math.abs(value - others[0]) >= m.clearlyTrivial)
      flags.push(`${gbp(value)} where every other entry of this routine is ${gbp(others[0])}`);
  }
  return { flags, keyedAfterYe, revCreditMinor, staffMisposted: !!staffMisposted };
}

/** The signal for a flagged journal: which areas it touches, how severe, and which procedures must test it. */
function journalSignal(f: ClientFile, e: LedgerEntry, profile: JournalProfile): Signal {
  const m = materiality(f);
  const bank = bankAccounts(f);
  const { flags, keyedAfterYe, revCreditMinor, staffMisposted } = profile;
  const value = valueOf(e);
  const legs = e.lines.filter((l) => !bank.includes(l.account));
  const areaOf = (l: (typeof legs)[number]) => areaOfAccount(f, l.account, l.partyId ?? e.partyId);
  const areas = uniq(["journalsManagementOverride" as Area, ...legs.map(areaOf)]).filter((a) => a !== "vat");
  if (revCreditMinor > 0 && !areas.includes("revenue")) areas.push("revenue");
  const pnlAreas = uniq(
    legs.filter((l) => ["income", "expense"].includes(accountOf(f, l.account)?.class ?? "")).map(areaOf),
  );
  // significant needs size and at least two flags; a balance-sheet leg of a significant journal is elevated, not significant
  const severity: Severity =
    value >= m.performance && flags.length >= 2 ? "significant" : value >= m.clearlyTrivial ? "elevated" : "info";
  const assertions: Assertion[] = uniq([
    "occurrence",
    ...(keyedAfterYe ? ["cutOff" as Assertion] : []),
    ...(staffMisposted ? ["classification" as Assertion] : []),
    ...(revCreditMinor > 0 ? ["accuracy" as Assertion] : []),
  ]);
  return sig({
    id: `journal:${e.voucher}`,
    detector: "manual journal profile",
    areas,
    assertions,
    severity,
    amountMinor: value,
    summary: `${e.voucher} "${e.description}" ${gbp(value)}: ${flags.join("; ")}`,
    evidenceIds: uniq([e.voucher, e.postedBy, ...(e.partyId ? [e.partyId] : []), ...e.lines.map((l) => l.account)]),
    mustTest:
      value >= m.clearlyTrivial
        ? { "JNL-01": [e.voucher], ...(revCreditMinor > 0 ? { "REV-03": [e.voucher] } : {}) }
        : {},
    areaSeverity:
      severity === "significant"
        ? Object.fromEntries(
            areas
              .filter((a) => a !== "journalsManagementOverride" && !pnlAreas.includes(a))
              .map((a) => [a, "elevated" as Severity]),
          )
        : {},
  });
}

export function journalSignals(f: ClientFile): Signal[] {
  const senior = seniorUsers(f);
  const manual = f.ledger.filter((e) => e.journal === "manual");
  const groups = routineGroups(manual);
  const out: Signal[] = [];
  for (const e of manual) {
    const profile = profileJournal(f, e, groups.get(e) ?? null, senior);
    if (profile.flags.length) out.push(journalSignal(f, e, profile));
  }
  return out;
}

// ---------- 2. bank to ledger ----------

export function bankSignals(f: ClientFile): Signal[] {
  const m = materiality(f),
    ye = yearEnd(f),
    start = f.company.financialYear.start,
    bank = bankAccounts(f);
  const out: Signal[] = [];
  const stmt = f.bankYear.filter((b) => b.date >= start && b.date <= ye);
  // year-end balance
  const lastLine = [...stmt].reverse()[0];
  const tbBank = closing(f, bank);
  const ledgerBank = f.ledger.flatMap((e) =>
    e.lines.filter((l) => bank.includes(l.account)).map((l) => ({ e, amount: l.amountMinor })),
  );
  // group both sides by reference, then match leftovers by amount within five days
  const ledGroups = new Map<string, { e: LedgerEntry; amount: number }[]>();
  for (const x of ledgerBank) {
    const k = x.e.externalReference ?? `#${x.e.voucher}`;
    ledGroups.set(k, [...(ledGroups.get(k) ?? []), x]);
  }
  const stGroups = new Map<string, typeof stmt>();
  for (const b of stmt) stGroups.set(b.reference, [...(stGroups.get(b.reference) ?? []), b]);
  const ledLeft: { e: LedgerEntry; amount: number }[] = [],
    stLeft: typeof stmt = [];
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const matchedRefs = new Set<string>();
  for (const [k, xs] of ledGroups) {
    const st = stGroups.get(k);
    if (st && sum(st.map((b) => b.amountMinor)) === sum(xs.map((x) => x.amount))) matchedRefs.add(k);
    else ledLeft.push(...xs);
  }
  for (const [k, bs] of stGroups) if (!matchedRefs.has(k)) stLeft.push(...bs);
  const used = new Set<string>();
  const ledUnmatched = ledLeft.filter((x) => {
    const hit = stLeft.find(
      (b) => !used.has(b.id) && b.amountMinor === x.amount && Math.abs(daysBetween(x.e.postingDate, b.date)) <= 5,
    );
    if (hit) used.add(hit.id);
    return !hit;
  });
  const stUnmatched = stLeft.filter((b) => !used.has(b.id));
  for (const x of ledUnmatched.filter((x) => Math.abs(x.amount) >= m.clearlyTrivial)) {
    out.push(
      sig({
        id: `bank:ledger-only:${x.e.voucher}`,
        detector: "bank to ledger matching",
        areas: ["bankCash"],
        assertions: ["existence", "occurrence"],
        severity: "elevated",
        amountMinor: Math.abs(x.amount),
        summary: `${x.e.voucher} "${x.e.description}" moves ${gbp(x.amount)} through the bank account in the ledger, but no line on the bank statement matches it`,
        evidenceIds: [x.e.voucher, ...bank],
        mustTest: { "BNK-03": [x.e.voucher] },
      }),
    );
  }
  const stBig = stUnmatched.filter((b) => Math.abs(b.amountMinor) >= m.clearlyTrivial);
  if (stBig.length)
    out.push(
      sig({
        id: "bank:statement-only",
        detector: "bank to ledger matching",
        areas: ["bankCash"],
        assertions: ["completeness"],
        severity: "elevated",
        amountMinor: sum(stBig.map((b) => Math.abs(b.amountMinor))),
        summary: `${stBig.length} bank statement lines above the trivial threshold have no ledger entry`,
        evidenceIds: stBig.map((b) => b.id),
        mustTest: { "BNK-03": stBig.map((b) => b.id) },
      }),
    );
  if (lastLine && lastLine.balanceMinor !== tbBank) {
    const diff = lastLine.balanceMinor - tbBank;
    const explains = ledUnmatched.filter((x) => -x.amount === diff || x.amount === -diff);
    out.push(
      sig({
        id: "bank:closing-difference",
        detector: "bank to ledger matching",
        areas: ["bankCash"],
        assertions: ["existence", "completeness"],
        severity: Math.abs(diff) >= m.clearlyTrivial ? "elevated" : "info",
        amountMinor: Math.abs(diff),
        summary: `bank statement balance at ${lastLine.date} ${gbp(lastLine.balanceMinor)} differs from the trial balance ${gbp(tbBank)} by ${gbp(diff)}${explains.length ? `; exactly the unmatched ${explains.map((x) => x.e.voucher).join(", ")}` : ""}`,
        evidenceIds: [lastLine.id, ...bank, ...explains.map((x) => x.e.voucher)],
      }),
    );
  }
  // overdrawn days on the statement
  const od = uniq(stmt.filter((b) => b.balanceMinor < 0).map((b) => b.date));
  if (od.length)
    out.push(
      sig({
        id: "bank:overdrawn",
        detector: "bank to ledger matching",
        areas: ["goingConcern", "bankCash"],
        assertions: ["presentation", "valuation"],
        severity: "elevated",
        amountMinor: -Math.min(...stmt.map((b) => b.balanceMinor)),
        exposure: false,
        summary: `the account was overdrawn on ${od.length} statement dates (${od[0]} to ${od[od.length - 1]}), lowest ${gbp(Math.min(...stmt.map((b) => b.balanceMinor)))}${lastLine && lastLine.balanceMinor < 0 ? `, and at the year end (${gbp(lastLine.balanceMinor)})` : ""}`,
        evidenceIds: uniq([
          stmt.find((b) => b.balanceMinor < 0)!.id,
          stmt.reduce((lo, b) => (b.balanceMinor < lo.balanceMinor ? b : lo)).id,
          ...(lastLine && lastLine.balanceMinor < 0 ? [lastLine.id] : []),
        ]),
      }),
    );
  // PAY-02 tests "every leaver" and "every starter": its population is everyone who joined or left in the year, not only those flagged
  const { start: fyStart, end: fyEnd } = f.company.financialYear;
  const inYear = (d: string | null | undefined) => !!d && d >= fyStart && d <= fyEnd;
  const movers = f.parties.filter((p) => p.type === "employee" && (inYear(p.startDate) || inYear(p.endDate)));
  if (movers.length)
    out.push(
      sig({
        id: "payroll:starters-leavers",
        detector: "leaver paid after leaving date",
        areas: ["payroll"],
        assertions: ["occurrence", "accuracy"],
        severity: "info",
        amountMinor: null,
        exposure: false,
        summary: `${movers.length} employee${movers.length > 1 ? "s" : ""} joined or left in the year: ${movers.map((p) => `${p.name} (${p.id}, ${inYear(p.endDate) ? `left ${p.endDate}` : `joined ${p.startDate}`})`).join("; ")}`,
        evidenceIds: movers.map((p) => p.id),
        mustTest: { "PAY-02": movers.map((p) => p.id) },
      }),
    );
  // payments to leavers after their leaving date (payroll in the ledger is one line; the bank shows each person)
  for (const p of f.parties.filter((p) => p.type === "employee" && p.endDate)) {
    const after = [...f.bankYear, ...f.bankNext].filter(
      (b) => b.amountMinor < 0 && b.date > p.endDate && b.counterparty.toUpperCase() === p.name.toUpperCase(),
    );
    if (!after.length) continue;
    const total = -sum(after.map((b) => b.amountMinor));
    out.push(
      sig({
        id: `payroll:leaver-paid:${p.id}`,
        detector: "leaver paid after leaving date",
        areas: ["payroll"],
        assertions: ["occurrence", "existence"],
        severity: total >= m.clearlyTrivial ? "elevated" : "info",
        amountMinor: total,
        summary: `${p.name} (${p.id}) left on ${p.endDate} but received ${after.length} bank payments totalling ${gbp(total)} after that date (${after[0].date} to ${after[after.length - 1].date})`,
        evidenceIds: [p.id, ...after.map((b) => b.id)],
        mustTest: { "PAY-02": [p.id], "PAY-03": after.map((b) => b.id) },
      }),
    );
  }
  return out;
}

// ---------- 3. purchase approval ----------

export function approvalSignals(f: ClientFile): Signal[] {
  const m = materiality(f),
    out: Signal[] = [];
  const purchases = f.ledger.filter((e) => e.journal === "purchases");
  for (const u of f.company.users.filter((u) => u.approvalLimitMinor)) {
    const L = u.approvalLimitMinor!;
    const bySupplier = new Map<string, LedgerEntry[]>();
    for (const e of purchases) if (e.partyId) bySupplier.set(e.partyId, [...(bySupplier.get(e.partyId) ?? []), e]);
    for (const [sup, es] of bySupplier) {
      const near = es.filter((e) => e.approvedBy === u.id && grossOf(f, e) >= 0.9 * L && grossOf(f, e) < L);
      if (near.length < 3 || near.length / es.length < 0.5) continue;
      const total = near.reduce((s, e) => s + grossOf(f, e), 0),
        first = es.map((e) => e.postingDate).sort()[0];
      const isNew = first > f.company.financialYear.start.replace(/-01-01$/, "-03-31");
      out.push(
        sig({
          id: `approval:below-limit:${sup}`,
          detector: "approval-limit analytics",
          areas: ["purchasesCreditors"],
          assertions: ["occurrence", "accuracy"],
          severity: "elevated",
          amountMinor: total,
          summary: `${near.length} of ${es.length} invoices from ${partyOf(f, sup)?.name ?? sup} (${sup}) fall between 90% and 100% of ${u.id}'s ${gbp(L)} approval limit and were approved by ${u.id}, ${gbp(total)} in all${isNew ? `; first invoice ${first}, a supplier new in the year` : ""}`,
          evidenceIds: [sup, u.id, ...near.map((e) => e.voucher)],
          mustTest: { "PUR-03": near.map((e) => e.voucher), "PUR-02": [sup] },
        }),
      );
    }
  }
  for (const u of f.company.users.filter((u) => u.canPost && u.canApprove)) {
    const self = purchases.filter((e) => e.postedBy === u.id && e.approvedBy === u.id).sort(byValueDesc);
    if (!self.length) continue;
    const total = self.reduce((s, e) => s + grossOf(f, e), 0);
    const known = explainedLastYear(f, u.id, /post|approv/i);
    const control = known && /compensating control|sampled \d+|tested/i.test(known.explanation) ? known.id : null;
    out.push(
      sig({
        id: `approval:self:${u.id}`,
        detector: "approval-limit analytics",
        areas: ["purchasesCreditors"],
        assertions: ["occurrence"],
        severity: known || self.length < 10 ? "info" : "elevated",
        amountMinor: total,
        exposure: false,
        summary: `${u.id} posted and approved ${self.length} purchase invoices (${gbp(total)})${known ? `; the same arrangement was examined last year (${known.id}: ${known.explanation})` : ""}`,
        evidenceIds: uniq([u.id, ...(known ? [known.id] : []), ...self.slice(0, 5).map((e) => e.voucher)]),
        ...(control ? { reliesOn: [control] } : {}),
      }),
    );
  }
  return out;
}

// ---------- 4. related parties ----------

const ADDRESS = /\b\d+[a-z]? [A-Z][a-z]+ (Road|Street|Lane|Avenue|Close|Drive|Way|Crescent|Grove|Terrace|Gardens)\b/;

export function relatedPartySignals(f: ClientFile): Signal[] {
  const m = materiality(f),
    out: Signal[] = [];
  const rp = f.parties.filter((p) => p.relatedParty);
  for (const p of rp.filter((p) => p.type !== "employee")) {
    const es = f.ledger.filter(
      (e) => e.partyId === p.id && (e.journal === "purchases" || e.journal === "sales" || e.journal === "manual"),
    );
    if (!es.length) continue;
    const stems = new Map<string, number>();
    es.forEach((e) => stems.set(stem(e.description), (stems.get(stem(e.description)) ?? 0) + 1));
    const total = es.reduce((s, e) => s + valueOf(e), 0);
    const oneOff = es.filter((e) => stems.get(stem(e.description)) === 1 && valueOf(e) >= m.clearlyTrivial);
    out.push(
      sig({
        id: `rp:transactions:${p.id}`,
        detector: "related-party transactions",
        areas: ["relatedParties"],
        assertions: ["presentation", "occurrence"],
        severity: oneOff.length ? "elevated" : "info",
        amountMinor: oneOff.length ? oneOff.reduce((s, e) => s + valueOf(e), 0) : total,
        exposure: oneOff.length > 0,
        summary: `${es.length} transactions with related party ${p.name} (${p.relation}), ${gbp(total)}${
          oneOff.length
            ? `; outside the recurring pattern: ${oneOff
                .map(
                  (e) =>
                    `${e.voucher} "${e.description}" ${gbp(valueOf(e))} coded to ${e.lines
                      .filter((l) => l.amountMinor > 0)
                      .map((l) => l.account)
                      .join("/")}`,
                )
                .join("; ")}`
            : ""
        }`,
        evidenceIds: uniq([p.id, ...oneOff.map((e) => e.voucher), ...es.slice(0, 3).map((e) => e.voucher)]),
        mustTest: {
          "RP-02": es.map((e) => e.voucher),
          ...(oneOff.length ? { "JNL-03": oneOff.map((e) => e.voucher) } : {}),
        },
      }),
    );
  }
  // related people employed other than as directors: their pay is a related-party transaction (RP-02 population)
  const relEmp = rp.filter((p) => p.type === "employee" && !/director/i.test(p.relation));
  if (relEmp.length)
    out.push(
      sig({
        id: "rp:related-employees",
        detector: "related-party transactions",
        areas: ["relatedParties"],
        assertions: ["presentation"],
        severity: "info",
        amountMinor: null,
        exposure: false,
        summary: `related persons employed other than as directors: ${relEmp.map((p) => `${p.name} (${p.relation})`).join("; ")}; their pay is a related-party transaction`,
        evidenceIds: relEmp.map((p) => p.id),
        mustTest: { "RP-02": relEmp.map((p) => p.id) },
      }),
    );
  // balances with directors or their families
  for (const p of rp.filter((p) => p.type === "employee")) {
    const es = f.ledger.filter(
      (e) =>
        e.journal !== "payroll" &&
        e.lines.some(
          (l) =>
            (l.partyId === p.id || e.partyId === p.id) &&
            accountOf(f, l.account)?.class === "asset" &&
            accountOf(f, l.account)?.category !== "cash",
        ),
    );
    if (!es.length) continue;
    const total = es.reduce((s, e) => s + valueOf(e), 0);
    out.push(
      sig({
        id: `rp:director-balance:${p.id}`,
        detector: "related-party transactions",
        areas: ["relatedParties"],
        assertions: ["presentation", "existence", "rightsAndObligations"],
        severity: total > S197_MINOR ? "significant" : total >= m.clearlyTrivial ? "elevated" : "info",
        amountMinor: total,
        summary: `${p.name} (${p.relation}) had a balance owed to the company: ${es.map((e) => `${e.voucher} "${e.description}" ${gbp(valueOf(e))} posted by ${e.postedBy}${e.approvedBy ? "" : " with no approver"}`).join("; ")}${total > S197_MINOR ? S197_NOTE : ""}`,
        evidenceIds: uniq([p.id, ...es.map((e) => e.voucher), ...es.map((e) => e.postedBy)]),
        mustTest: { "RP-03": es.map((e) => e.voucher) },
      }),
    );
  }
  // possible personal expenditure: costs for a street address that is not the company's
  const office = f.company.registeredOffice;
  const personal = f.ledger.filter(
    (e) =>
      e.journal === "purchases" && ADDRESS.test(e.description) && !office.includes(e.description.match(ADDRESS)![0]),
  );
  if (personal.length) {
    const total = personal.reduce((s, e) => s + valueOf(e), 0),
      paid = personal.reduce((s, e) => s + grossOf(f, e), 0);
    out.push(
      sig({
        id: "rp:personal-expenditure",
        detector: "related-party transactions",
        areas: ["relatedParties", "vat"],
        assertions: ["presentation", "occurrence", "classification"],
        severity: paid > S197_MINOR ? "significant" : total >= m.clearlyTrivial ? "elevated" : "info",
        amountMinor: total,
        summary: `purchase invoices for work at a street address other than the registered office: ${personal
          .map(
            (e) =>
              `${e.voucher} "${e.description}" ${gbp(valueOf(e))}, coded to ${e.lines
                .filter((l) => l.amountMinor > 0)
                .map((l) => l.account)
                .join("/")}${e.lines.some((l) => l.vatMinor > 0) ? ", input VAT reclaimed" : ""}`,
          )
          .join(
            "; ",
          )}${paid > S197_MINOR ? `; the company paid ${gbp(paid)}, so if the work was for a director${S197_NOTE.replace(/^;/, ",")}` : ""}`,
        evidenceIds: uniq([...personal.map((e) => e.voucher), ...personal.map((e) => e.partyId!).filter(Boolean)]),
        mustTest: {
          "RP-02": personal.map((e) => e.voucher),
          "RP-03": personal.map((e) => e.voucher),
          "VAT-02": personal.map((e) => e.voucher),
        },
      }),
    ); // spending for a director's benefit is a related-party transaction too
  }
  return out;
}

// ---------- 5. trial balance and ledger integrity, analytics, estimates ----------

export function balanceSignals(f: ClientFile): Signal[] {
  const m = materiality(f),
    out: Signal[] = [];
  const movement = new Map<string, number>();
  for (const e of f.ledger)
    for (const l of e.lines) movement.set(l.account, (movement.get(l.account) ?? 0) + l.amountMinor);
  const unbalanced = f.ledger.filter((e) => e.lines.reduce((s, l) => s + l.amountMinor, 0) !== 0);
  for (const r of f.tb) {
    const diff = (movement.get(r.account) ?? 0) - (r.closingMinor - r.openingMinor);
    if (diff === 0) continue;
    const culprits = unbalanced.filter(
      (e) =>
        e.lines.some((l) => l.account === r.account) ||
        Math.abs(e.lines.reduce((s, l) => s + l.amountMinor, 0)) === Math.abs(diff),
    );
    out.push(
      sig({
        id: `tb:ledger-mismatch:${r.account}`,
        detector: "ledger to trial balance",
        areas: [areaOfAccount(f, r.account)],
        assertions: ["accuracy", "completeness"],
        severity: Math.abs(diff) >= m.clearlyTrivial ? "elevated" : "info",
        amountMinor: Math.abs(diff),
        summary: `ledger movement on ${r.account} ${r.name} differs from the trial balance by ${gbp(diff)}${culprits.length ? `; unbalanced voucher ${culprits.map((e) => e.voucher).join(", ")}` : ""}`,
        evidenceIds: [r.account, ...culprits.map((e) => e.voucher)],
      }),
    );
  }
  for (const e of unbalanced.filter((e) => !out.some((s) => s.evidenceIds.includes(e.voucher))))
    out.push(
      sig({
        id: `tb:unbalanced:${e.voucher}`,
        detector: "ledger to trial balance",
        areas: ["journalsManagementOverride"],
        assertions: ["accuracy"],
        severity: "info",
        amountMinor: Math.abs(e.lines.reduce((s, l) => s + l.amountMinor, 0)),
        summary: `${e.voucher} does not balance`,
        evidenceIds: [e.voucher],
      }),
    );
  // codes outside the chart's categories
  for (const a of f.accounts.filter((a) => !a.category)) {
    const lines = f.ledger.flatMap((e) => e.lines.filter((l) => l.account === a.code).map((l) => ({ e, l })));
    if (!lines.length) continue;
    const py = f.pyFindings.find((p) => p.subject.includes(a.code));
    const total = lines.reduce((s, x) => s + x.l.amountMinor, 0);
    out.push(
      sig({
        id: `tb:non-standard-code:${a.code}`,
        detector: "ledger to trial balance",
        areas: ["purchasesCreditors"],
        assertions: ["classification"],
        severity: py ? "elevated" : "info",
        amountMinor: Math.abs(total),
        exposure: false,
        summary: `${lines.length} lines (${gbp(total)}) posted to ${a.code}, a code with no category in the chart${py ? `, which ${py.id} last year said would be retired (${py.explanation})` : ""}`,
        evidenceIds: uniq([a.code, ...(py ? [py.id] : []), ...lines.slice(0, 5).map((x) => x.e.voucher)]),
      }),
    );
  }
  // large movements on balance sheet accounts (risk is not size: only large AND disproportionate movements count)
  for (const r of f.tb) {
    const a = accountOf(f, r.account);
    if (!a || !["asset", "liability"].includes(a.class) || a.category === "cash" || /vat|paye/i.test(a.name)) continue;
    const delta = r.closingMinor - r.priorYearMinor;
    if (Math.abs(delta) < m.overall || Math.abs(delta) < 0.5 * Math.max(1, Math.abs(r.priorYearMinor))) continue;
    const area = areaOfAccount(f, r.account);
    out.push(
      sig({
        id: `tb:movement:${r.account}`,
        detector: "balance analytics",
        areas: [area],
        assertions: a.class === "asset" ? ["existence", "valuation"] : ["completeness", "existence"],
        severity: "elevated",
        amountMinor: Math.abs(delta),
        exposure: false,
        summary: `${r.account} ${r.name} moved from ${gbp(r.priorYearMinor)} to ${gbp(r.closingMinor)} (${r.priorYearMinor ? `${Math.round((delta / Math.abs(r.priorYearMinor)) * 100)}%` : "from nil"})`,
        evidenceIds: [r.account],
      }),
    );
  }
  // year-end estimates that have not moved
  for (const r of f.tb.filter((r) => /accrual|provision/i.test(r.name) && r.closingMinor === r.openingMinor)) {
    const touched = f.ledger.some((e) => e.lines.some((l) => l.account === r.account));
    out.push(
      sig({
        id: `estimate:unchanged:${r.account}`,
        detector: "estimates not updated",
        areas: ["accrualsProvisions"],
        assertions: ["completeness", "valuation"],
        severity: "elevated",
        amountMinor: null,
        summary: `${r.account} ${r.name} closes at ${gbp(r.closingMinor)}, exactly its opening balance${touched ? "" : ", with no postings in the year"}: the year-end estimate appears not to have been made`,
        evidenceIds: [r.account],
      }),
    );
  }
  // depreciation not reflecting additions
  const fa = accountsIn(f, "fixedAssets");
  const additions = f.ledger.filter(
    (e) => e.journal !== "manual" && e.lines.some((l) => fa.includes(l.account) && l.amountMinor > 0),
  );
  const addTotal = additions.reduce(
    (s, e) =>
      s + e.lines.filter((l) => fa.includes(l.account) && l.amountMinor > 0).reduce((t, l) => t + l.amountMinor, 0),
    0,
  );
  for (const r of f.tb.filter((r) => /depreciation/i.test(r.name) && accountOf(f, r.account)?.class === "expense")) {
    if (r.closingMinor === r.priorYearMinor && addTotal >= m.performance)
      out.push(
        sig({
          id: `estimate:depreciation-flat:${r.account}`,
          detector: "estimates not updated",
          areas: ["fixedAssets"],
          assertions: ["valuation", "accuracy"],
          severity: "elevated",
          amountMinor: addTotal,
          exposure: false,
          summary: `depreciation (${r.account}) is ${gbp(r.closingMinor)}, the same as last year to the penny, although additions of ${gbp(addTotal)} were made in the year`,
          evidenceIds: [
            r.account,
            ...additions
              .sort(byValueDesc)
              .slice(0, 3)
              .map((e) => e.voucher),
          ],
        }),
      );
  }
  return out;
}

// ---------- 6. classification: loan interest, hospitality ----------

export function classificationSignals(f: ClientFile): Signal[] {
  const m = materiality(f),
    out: Signal[] = [];
  const loans = f.tb.filter((r) => accountOf(f, r.account)?.category === "longTermLiabilities" && r.closingMinor !== 0);
  const interest = f.accounts.filter((a) => /interest/i.test(a.name) && a.class === "expense");
  const interestCharged = f.ledger.reduce(
    (s, e) =>
      s + e.lines.filter((l) => interest.some((a) => a.code === l.account)).reduce((t, l) => t + l.amountMinor, 0),
    0,
  );
  if (loans.length && interestCharged === 0) {
    const repay = f.ledger.filter((e) =>
      e.lines.some((l) => loans.some((r) => r.account === l.account) && l.amountMinor > 0),
    );
    const other = repay.flatMap((e) =>
      e.lines.filter((l) => l.amountMinor > 0 && !loans.some((r) => r.account === l.account)),
    );
    const elsewhere = other.reduce((s, l) => s + l.amountMinor, 0);
    const where = uniq(other.map((l) => `${l.account} ${accountOf(f, l.account)?.name}`));
    out.push(
      sig({
        id: "class:loan-interest",
        detector: "classification",
        areas: ["goingConcern"],
        assertions: ["classification", "accuracy", "presentation"],
        severity: elevatedIf(elsewhere, m.clearlyTrivial),
        amountMinor: elsewhere,
        exposure: false,
        summary: `${loans.map((r) => `${r.account} ${r.name} ${gbp(r.closingMinor)}`).join(", ")} is outstanding but ${interest.map((a) => a.code).join("/") || "no interest account"} shows no interest for the year; the ${repay.length} repayments put ${gbp(elsewhere)} to ${where.join(", ")}. Any covenant computed from these accounts is affected`,
        evidenceIds: uniq([
          ...loans.map((r) => r.account),
          ...interest.map((a) => a.code),
          ...repay.slice(0, 3).map((e) => e.voucher),
          ...other.map((l) => l.account),
        ]),
      }),
    );
  }
  const ent = f.accounts.filter((a) => /entertain/i.test(a.name)).map((a) => a.code);
  const hosp = f.ledger.filter(
    (e) =>
      e.journal === "purchases" &&
      /dinner|lunch|brasserie|restaurant|hospitality|tickets|hamper/i.test(e.description) &&
      e.lines.some((l) => l.vatMinor > 0 && !ent.includes(l.account)),
  );
  if (hosp.length) {
    const lines = hosp.flatMap((e) => e.lines.filter((l) => !ent.includes(l.account) && l.vatMinor > 0));
    const net = lines.reduce((t, l) => t + l.amountMinor, 0),
      vat = lines.reduce((t, l) => t + l.vatMinor, 0);
    // the misstatement in the VAT balance is the VAT reclaimed, not the cost of the dinner
    out.push(
      sig({
        id: "class:hospitality",
        detector: "classification",
        areas: ["vat"],
        assertions: ["classification", "accuracy"],
        severity: elevatedIf(net, m.clearlyTrivial),
        amountMinor: vat,
        summary: `hospitality coded outside the entertaining account with input VAT reclaimed: ${hosp.map((e) => `${e.voucher} "${e.description}"`).join("; ")}; ${gbp(net)} net, ${gbp(vat)} VAT reclaimed`,
        evidenceIds: hosp.map((e) => e.voucher),
        mustTest: { "VAT-02": hosp.map((e) => e.voucher) },
      }),
    );
  }
  return out;
}
const elevatedIf = (amount: number, threshold: number): Severity => (amount >= threshold ? "elevated" : "info");

/**
 * Companies Act 2006 ss.197-198 and 207: a loan, quasi-loan or credit to a director above £10,000 in aggregate needs
 * prior approval by the members, and the company's accounts must disclose it (s.413). Above the threshold the
 * question is no longer only disclosure but whether the transaction was lawful, so the area is significant.
 */
const S197_MINOR = 1_000_000;
const S197_NOTE =
  "; above the £10,000 limit in Companies Act s.207, so members' prior approval (s.197) and disclosure (s.413) are needed";

// ---------- 7. takings series ----------

export function takingsSignals(f: ClientFile): Signal[] {
  const m = materiality(f);
  const tk = f.ledger.filter((e) => e.journal === "cash" && /week (\d+)/i.test(e.description));
  if (!tk.length) return [];
  const weeks = new Map<number, LedgerEntry[]>();
  for (const e of tk) {
    const w = Number(e.description.match(/week (\d+)/i)![1]);
    weeks.set(w, [...(weeks.get(w) ?? []), e]);
  }
  // the series must run to the year end, not to the last week that happens to be recorded: a missing final week is the cut-off risk
  const yearWeeks = Math.ceil((daysBetween(f.company.financialYear.start, f.company.financialYear.end) + 1) / 7);
  const max = Math.max(...weeks.keys(), Math.min(52, yearWeeks));
  const missing = Array.from({ length: max }, (_, i) => i + 1).filter((w) => !weeks.has(w));
  if (!missing.length) return [];
  const revenue = [...accountsIn(f, "revenue")];
  const weekly = [...weeks.values()]
    .map(
      (es) =>
        -es.reduce(
          (s, e) => s + e.lines.filter((l) => revenue.includes(l.account)).reduce((t, l) => t + l.amountMinor, 0),
          0,
        ),
    )
    .sort((a, b) => a - b);
  const median = weekly[Math.floor(weekly.length / 2)];
  return [
    sig({
      id: "takings:missing-weeks",
      detector: "takings series",
      areas: ["revenue"],
      assertions: ["completeness"],
      severity: elevatedIf(median * missing.length, m.clearlyTrivial),
      amountMinor: median * missing.length,
      summary: `no takings are recorded for week${missing.length > 1 ? "s" : ""} ${missing.join(", ")} of ${max}; at the median week (${gbp(median)}) that is about ${gbp(median * missing.length)} of revenue`,
      evidenceIds: uniq(
        missing
          .flatMap((w) => [weeks.get(w - 1)?.[0]?.voucher, weeks.get(w + 1)?.[0]?.voucher])
          .filter((v): v is string => !!v),
      ),
      mustTest: { "REV-06": missing.map((w) => `week ${w}`) },
    }),
  ];
}

// ---------- 8. VAT returns against the VAT control accounts ----------

/**
 * VAT-01 reconciles each return to the control accounts. The file holds both sides: the return journal (or, for the
 * quarter filed after the year end, HMRC's payment or repayment on the bank) and every posting to output and input VAT.
 * A return that declares less than the ledger records is a misstated liability and money owed to HMRC.
 */
export function vatReturnSignals(f: ClientFile): Signal[] {
  const m = materiality(f);
  const acct = (re: RegExp) => f.accounts.find((a) => /vat/i.test(a.name) && re.test(a.name))?.code;
  const output = acct(/output|sales/i),
    input = acct(/input|purchases/i),
    liability = acct(/liabilit|control/i);
  if (!output || !input || !liability) return [];
  const QUARTER = /\bQ([1-4])\s+(\d{4})\b/;
  const quarterOf = (d: string) => `Q${Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1} ${d.slice(0, 4)}`;
  const returns = new Map<string, LedgerEntry>();
  for (const e of f.ledger) {
    const q = QUARTER.exec(e.description);
    if (q && /vat return/i.test(e.description) && e.lines.some((l) => l.account === liability))
      returns.set(`Q${q[1]} ${q[2]}`, e);
  }
  const returnVouchers = new Set([...returns.values()].map((e) => e.voucher));
  const recorded = new Map<string, { out: number; inp: number }>();
  for (const e of f.ledger) {
    if (returnVouchers.has(e.voucher)) continue;
    const q = quarterOf(e.postingDate),
      r = recorded.get(q) ?? { out: 0, inp: 0 };
    for (const l of e.lines) {
      if (l.account === output) r.out -= l.amountMinor;
      if (l.account === input) r.inp += l.amountMinor;
    }
    recorded.set(q, r);
  }
  const hmrc = [...f.bankYear, ...f.bankNext].filter(
    (b) => /hmrc/i.test(b.counterparty) && /vat/i.test(`${b.reference} ${b.description}`) && QUARTER.test(b.reference),
  );
  const rows: { q: string; ledger: number; declared: number; ids: string[] }[] = [];
  for (const [q, r] of [...recorded].sort(([a], [b]) => a.slice(3).localeCompare(b.slice(3)) || a.localeCompare(b))) {
    if (
      q.slice(3) !== f.company.financialYear.end.slice(0, 4) &&
      q.slice(3) !== f.company.financialYear.start.slice(0, 4)
    )
      continue;
    const j = returns.get(q),
      pay = hmrc.find((b) => QUARTER.exec(b.reference)![0].replace(/\s+/, " ") === q);
    // declared net: what the return journal moved to the liability, else what HMRC was paid (a repayment is negative)
    const declared = j
      ? -j.lines.filter((l) => l.account === liability).reduce((t, l) => t + l.amountMinor, 0)
      : pay
        ? -pay.amountMinor
        : null;
    if (declared === null) continue;
    rows.push({ q, ledger: r.out - r.inp, declared, ids: [...(j ? [j.voucher] : []), ...(pay ? [pay.id] : [])] });
  }
  const short = rows.filter((r) => r.ledger - r.declared >= m.clearlyTrivial);
  if (!short.length) return [];
  const total = short.reduce((t, r) => t + r.ledger - r.declared, 0);
  return [
    sig({
      id: "vat:returns-vs-ledger",
      detector: "VAT returns against control accounts",
      areas: ["vat"],
      assertions: ["completeness", "accuracy"],
      severity: total >= m.performance ? "significant" : "elevated",
      amountMinor: total,
      summary: `the VAT returns for ${short.map((r) => r.q).join(" and ")} declare ${gbp(total)} less than the VAT control accounts record: ${short.map((r) => `${r.q} declared ${gbp(r.declared)} against ${gbp(r.ledger)} net in the ledger`).join("; ")}`,
      evidenceIds: uniq(short.flatMap((r) => r.ids)),
      mustTest: { "VAT-01": uniq(short.flatMap((r) => r.ids)) },
    }),
  ];
}

/**
 * Populations the file defines completely, for procedures whose text tests "every" item. Where the population is
 * known, it replaces the sample table, and an empty population is a fact ("none in the file"), not a reason to sample.
 */
/** The accounts that hold an accounting estimate, in the programme's own list: accruals and provisions (clawbacks among them),
 *  useful lives (the depreciation charge, where there are fixed assets) and stock valuation (where stock is material). */
export function estimateAccounts(f: ClientFile): string[] {
  const m = materiality(f),
    name = (a: string) => f.accounts.find((x) => x.code === a)?.name ?? "";
  const stock = accountsIn(f, "stock").filter((a) => f.accounts.find((x) => x.code === a)?.class === "asset");
  return [
    ...f.tb.filter((r) => /accrual|provision/i.test(r.name)).map((r) => r.account),
    ...(accountsIn(f, "fixedAssets").length
      ? f.accounts.filter((a) => /depreciation/i.test(a.name) && a.class === "expense").map((a) => a.code)
      : []),
    ...(Math.abs(closing(f, stock)) >= m.performance ? stock : []),
  ].filter((a, i, xs) => xs.indexOf(a) === i && name(a));
}

export function knownPopulations(f: ClientFile): Record<string, string[]> {
  const { start, end } = f.company.financialYear;
  const inYear = (d: string | null | undefined) => !!d && d >= start && d <= end;
  const revenue = new Set(accountsIn(f, "revenue"));
  return {
    // "for every leaver ... for every starter"
    "PAY-02": f.parties
      .filter((p) => p.type === "employee" && (inYear(p.startDate) || inYear(p.endDate)))
      .map((p) => p.id),
    // "every credit to a revenue account that did not originate in the sales ledger or the till": manual journals that touch revenue
    "REV-03": f.ledger
      .filter((e) => e.journal === "manual" && e.lines.some((l) => revenue.has(l.account)))
      .map((e) => e.voucher),
    // "identify every estimate in the accounts (accruals, provisions, clawbacks, stock valuation, useful lives)": the accounts that carry one
    "JNL-02": estimateAccounts(f),
  };
}

export function allSignals(f: ClientFile): Signal[] {
  const s = [
    ...journalSignals(f),
    ...bankSignals(f),
    ...approvalSignals(f),
    ...relatedPartySignals(f),
    ...balanceSignals(f),
    ...classificationSignals(f),
    ...takingsSignals(f),
    ...vatReturnSignals(f),
  ];
  return s.sort((a, b) => a.id.localeCompare(b.id));
}

export { tbRow };
