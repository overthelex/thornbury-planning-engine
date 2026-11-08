/**
 * Memo 9: does a rule hold on a file it was not tuned on? There is no correct plan to compare against (the oracle
 * problem), so these are metamorphic relations, as in metamorphic testing of tax software (arXiv 2205.04998): each
 * test changes one fact in a real client file and states what an auditor would expect to move, and what must not.
 * A rule fitted to one client's quirks fails here.
 * Two of these found defects when first written: the plan depended on row order, and R7 still fired after the
 * provision was booked.
 */
import { describe, expect, it } from "vitest";
import { buildPlanFromFile, type EnginePlan } from "../src/engine";
import { loadClientFile, type ClientFile } from "../src/file";
import { listClients } from "../src/load";
import type { LedgerEntry } from "../src/types";
import { journalSignals, relatedPartySignals, takingsSignals, vatReturnSignals } from "../src/signals";

const clone = (f: ClientFile): ClientFile => JSON.parse(JSON.stringify(f));
const level = (p: EnginePlan, a: string) => p.areas.find((x) => x.area === a)!;
const proc = (p: EnginePlan, id: string) => p.procedures.find((x) => x.procedureId === id)!;
const LEVELS = ["notApplicable", "baseline", "elevated", "significant"];

/** Post a balanced manual journal and keep the trial balance in step with it. */
function post(
  f: ClientFile,
  voucher: string,
  date: string,
  keyed: string,
  description: string,
  lines: [string, number][],
) {
  const e: LedgerEntry = {
    voucher,
    journal: "manual",
    postingDate: date,
    transactionDate: date,
    systemEntryTime: keyed,
    postedBy: f.ledger.find((x) => x.journal === "manual")!.postedBy,
    approvedBy: null,
    description,
    partyId: null,
    externalReference: null,
    isReversal: false,
    reversalOf: null,
    lines: lines.map(([account, amountMinor], i) => ({
      line: i + 1,
      account,
      amountMinor,
      taxCode: null,
      vatMinor: 0,
      partyId: null,
      description: null,
    })),
  };
  f.ledger.push(e);
  for (const [account, amount] of lines) f.tb.find((t) => t.account === account)!.closingMinor += amount;
}

/** Areas whose level differs between two plans. */
const moved = (a: EnginePlan, b: EnginePlan) =>
  a.areas
    .filter((x) => level(b, x.area).level !== x.level)
    .map((x) => x.area)
    .sort();

const base = Object.fromEntries(listClients().map((c) => [c, loadClientFile(c)]));
const before = Object.fromEntries(listClients().map((c) => [c, buildPlanFromFile(base[c]).plan]));
const after = (c: string, change: (f: ClientFile) => void) => {
  const f = clone(base[c]);
  change(f);
  return buildPlanFromFile(f).plan;
};

describe("what must not move the plan", () => {
  it.each(listClients())("%s: the order of rows in every file", (c) => {
    const p = after(c, (f) => {
      for (const k of ["ledger", "bankYear", "bankNext", "parties", "tb", "accounts", "pyFindings"] as const)
        (f[k] as unknown[]).reverse();
    });
    expect(JSON.stringify(p)).toBe(JSON.stringify(before[c]));
  });
  it("the budget: doubling it changes no selection or extent (memo 2)", () => {
    const p = after("wetherby", (f) => {
      f.company.engagement.fieldworkBudgetHours *= 2;
    });
    expect(p.procedures).toEqual(before.wetherby.procedures);
  });
  it.each(listClients())("%s: raising materiality tenfold can only lower a level, never raise one", (c) => {
    const p = after(c, (f) => {
      const m = f.company.engagement.materialityMinor;
      m.overall *= 10;
      m.performance *= 10;
      m.clearlyTrivial *= 10;
    });
    for (const a of before[c].areas)
      expect(LEVELS.indexOf(level(p, a.area).level), a.area).toBeLessThanOrEqual(LEVELS.indexOf(a.level));
  });
});

describe("what must move it, and only there", () => {
  it("removing the round stock journal (Calder MJ-000016) lowers stock and journals, nothing else", () => {
    const p = after("calder", (f) => {
      const e = f.ledger.find((x) => x.voucher === "MJ-000016")!;
      f.ledger.splice(f.ledger.indexOf(e), 1);
      for (const l of e.lines) f.tb.find((t) => t.account === l.account)!.closingMinor -= l.amountMinor;
    });
    expect(moved(before.calder, p)).toEqual(["journalsManagementOverride", "stock"]);
    expect(level(p, "stock").level).toBe("elevated");
  });
  it("a manual journal crediting revenue removes the ISA 240 rebuttal (Wetherby)", () => {
    expect(level(before.wetherby, "revenue").rules.join(" ")).toMatch(/rebutted/);
    const p = after("wetherby", (f) =>
      post(f, "MJ-T1", "2025-11-30", "2025-12-01T10:00:00Z", "Private fees correction", [
        ["1200", 50_000],
        ["4040", -50_000],
      ]),
    );
    expect(level(p, "revenue").level).toBe("significant");
    expect(proc(p, "REV-03").selected).toBe(true);
  });
  it("booking the clawback provision stops R7; the estimate stays significant on its size (Wetherby)", () => {
    const p = after("wetherby", (f) =>
      post(f, "MJ-T2", "2025-12-31", "2026-01-12T10:00:00Z", "NHS clawback provision 2025/26", [
        ["4030", 8_160_000],
        ["2260", -8_160_000],
      ]),
    );
    const a = level(p, "accrualsProvisions");
    expect(a.rules.some((r) => r.startsWith("R7"))).toBe(false);
    expect(a.level).toBe("significant");
    expect(level(before.wetherby, "revenue").rules.some((r) => r.startsWith("R7"))).toBe(true);
    expect(level(p, "revenue").rules.some((r) => r.startsWith("R7"))).toBe(false); // booked: income is no longer overstated by it
  });
  it("a suspicious journal repeated monthly is periodic, yet its round sum is not waived and every copy is tested (Calder MJ-000016)", () => {
    const copy = (f: ClientFile, voucher: string, month: string) => {
      const e = clone(base.calder).ledger.find((x) => x.voucher === "MJ-000016")!;
      e.voucher = voucher;
      e.postingDate = e.transactionDate = `2025-${month}-28`;
      f.ledger.push(e);
      for (const l of e.lines) f.tb.find((t) => t.account === l.account)!.closingMinor += l.amountMinor;
    };
    const g = clone(base.calder);
    copy(g, "MJ-T8", "10");
    copy(g, "MJ-T9", "11");
    for (const v of ["MJ-000016", "MJ-T8", "MJ-T9"]) {
      const s = journalSignals(g).find((x) => x.id === `journal:${v}`)!;
      expect(s.summary, v).toMatch(/round sum/);
      expect(s.mustTest["JNL-01"]).toEqual([v]);
    }
  });
  it("routine depreciation raises nothing, but the month whose amount differs does (Wetherby)", () => {
    expect(journalSignals(base.wetherby).some((s) => /Depreciation/.test(s.summary))).toBe(false);
    const f = clone(base.wetherby),
      e = f.ledger.find((x) => x.journal === "manual" && /Depreciation June/.test(x.description))!;
    for (const l of e.lines) l.amountMinor *= 3;
    expect(journalSignals(f).find((s) => s.id === `journal:${e.voucher}`)?.summary).toMatch(
      /where every other entry of this routine is £2,200/,
    );
  });
  it("a borrowing the notes do not mention makes covenants a partner question, not an assumption (Wetherby)", () => {
    expect(proc(before.wetherby, "GC-02").reason).toMatch(/no borrowings/);
    const p = after("wetherby", (f) => {
      f.accounts.push({
        code: "2300",
        name: "Bank loan",
        class: "liability",
        category: "longTermLiabilities",
      } as ClientFile["accounts"][number]);
      f.tb.push({
        ...f.tb.find((t) => t.account === "2260")!,
        account: "2300",
        name: "Bank loan",
        openingMinor: 0,
        closingMinor: 0,
        priorYearMinor: 0,
      });
      post(f, "MJ-T3", "2025-06-30", "2025-07-01T10:00:00Z", "Loan drawdown", [
        ["1200", 10_000_000],
        ["2300", -10_000_000],
      ]);
    });
    expect(p.questions.some((q) => q.startsWith("GC-02"))).toBe(true);
  });
  it("PAY-02 tests every starter and leaver in the year, not only the one flagged (Ashworth)", () => {
    const p = after("ashworth", (f) => {
      const e = f.parties.find((x) => x.type === "employee" && !x.endDate)!;
      e.endDate = "2025-09-30";
    });
    const leaver = base.ashworth.parties.find((x) => x.type === "employee" && !x.endDate)!.id;
    expect(proc(before.ashworth, "PAY-02").extent).toMatch(/: 1 \(E019\)/);
    expect(proc(p, "PAY-02").extent).toMatch(/identifies: 2 /);
    for (const id of ["E019", leaver]) expect(proc(p, "PAY-02").extent).toContain(id);
    expect(level(p, "payroll").level).toBe("significant");
  });
  it("a supplier newly marked related brings all its invoices into RP-02 (Ashworth); payments settle them and are not extra items", () => {
    const used = new Set(base.ashworth.ledger.filter((e) => e.journal === "purchases").map((e) => e.partyId));
    const s = base.ashworth.parties.find((x) => x.type === "supplier" && !x.relatedParty && used.has(x.id))!;
    const p = after("ashworth", (f) => {
      const x = f.parties.find((y) => y.id === s.id)!;
      x.relatedParty = true;
      x.relation = "owned by a director's brother";
    });
    const invoices = base.ashworth.ledger
      .filter((e) => e.partyId === s.id && e.journal === "purchases")
      .map((e) => e.voucher);
    expect(invoices.length).toBeGreaterThan(5);
    for (const v of invoices) expect(proc(p, "RP-02").extent).toContain(v);
  });

  it("a VAT return that agrees to the control accounts drops out of the VAT finding (Ashworth Q2)", () => {
    const quarter = (f: ClientFile, acct: string) =>
      f.ledger
        .filter(
          (e) => e.postingDate >= "2025-04-01" && e.postingDate <= "2025-06-30" && !/VAT return/.test(e.description),
        )
        .reduce((t, e) => t + e.lines.filter((l) => l.account === acct).reduce((u, l) => u + l.amountMinor, 0), 0);
    const f = clone(base.ashworth);
    const j = f.ledger.find((e) => e.voucher === "MJ-000010")!,
      out = -quarter(f, "2200"),
      inp = quarter(f, "2201");
    j.lines = [
      { ...j.lines[0], account: "2200", amountMinor: out },
      { ...j.lines[1], account: "2201", amountMinor: -inp },
      { ...j.lines[2], account: "2202", amountMinor: inp - out },
    ];
    expect(vatReturnSignals(base.ashworth)[0].summary).toMatch(/Q2 2025 and Q4 2025/);
    expect(vatReturnSignals(f)[0].summary).not.toMatch(/Q2 2025/);
  });
  it("a director's advance is significant above the £10,000 statutory limit, elevated below it (Ashworth MJ-000016)", () => {
    const rp = (f: ClientFile) => relatedPartySignals(f).find((s) => s.id.startsWith("rp:director-balance"))!;
    expect(rp(base.ashworth).severity).toBe("significant");
    const f = clone(base.ashworth);
    for (const l of f.ledger.find((e) => e.voucher === "MJ-000016")!.lines)
      l.amountMinor = Math.sign(l.amountMinor) * 900_000;
    expect(rp(f).severity).toBe("elevated");
  });
  it("takings that stop before the year end are a gap, not the end of the series (Calder without week 52)", () => {
    const f = clone(base.calder);
    f.ledger = f.ledger.filter((e) => !(e.journal === "cash" && /week 52\b/i.test(e.description)));
    expect(takingsSignals(f)[0].mustTest["REV-06"]).toContain("week 52");
  });
});
