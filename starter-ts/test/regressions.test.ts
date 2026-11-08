/**
 * Regressions from the blind agent review of 6 November 2026 (see DESIGN.md, Calibration): one test per finding, each the reviewer's own reproduction.
 * Each failed before its fix (R7 linkage ba222d5, routine journals 5c9b75c, notes merge 7b962f3, R6 48ed376,
 * presentation 6ff6f6e). If one fails again, the finding it names has come back.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPlan, buildPlanFromFile } from "../src/engine";
import { canonical, loadClientFile, type ClientFile } from "../src/file";
import { allSignals, estimateAccounts, journalSignals } from "../src/signals";
import { loadMergedNotes, mergeRuns, type ExtractionFile, type ExtractionPayload } from "../src/notes";
import { assessRisk } from "../src/risk";
import { priorYearFeedback } from "../src/feedback";
import { parseProgramme } from "../src/programme";
import { listClients } from "../src/load";
import type { LedgerEntry } from "../src/types";

const clone = (f: ClientFile): ClientFile => JSON.parse(JSON.stringify(f));
const plans = Object.fromEntries(listClients().map((c) => [c, buildPlan(c).plan]));
const area = (p: (typeof plans)[string], a: string) => p.areas.find((x) => x.area === a)!;
const doc = (rel: string) => readFileSync(join(__dirname, "..", rel), "utf8");

/** Post a balanced manual journal and keep the trial balance in step with it. */
function post(
  f: ClientFile,
  voucher: string,
  description: string,
  lines: [string, number][],
  reversalOf: string | null = null,
) {
  const e: LedgerEntry = {
    voucher,
    journal: "manual",
    postingDate: "2025-12-31",
    transactionDate: "2025-12-31",
    systemEntryTime: "2026-01-12T10:00:00Z",
    postedBy: f.ledger.find((x) => x.journal === "manual")!.postedBy,
    approvedBy: null,
    description,
    partyId: null,
    externalReference: null,
    isReversal: reversalOf !== null,
    reversalOf,
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

describe("review 2026-11-06", () => {
  it("1. an unrelated £1 accrual does not clear R7: the clawback stays unprovided, revenue stays significant, the partner is asked (Wetherby)", () => {
    const p = buildPlanFromFile(
      (() => {
        const f = clone(loadClientFile("wetherby"));
        post(f, "MJ-R1", "Accrue rent December", [
          ["7100", 100],
          ["2250", -100],
        ]);
        return f;
      })(),
    ).plan;
    expect(area(p, "accrualsProvisions").level).toBe("significant");
    expect(area(p, "accrualsProvisions").rules.find((r) => r.startsWith("R7"))).toMatch(
      /no posting can be linked to it: .*MJ-R1.*undetermined/,
    );
    expect(area(p, "revenue").level).toBe("significant");
    expect(area(p, "revenue").rules.some((r) => r.startsWith("R7"))).toBe(true);
    expect(p.questions.some((q) => /^N4: .*MJ-R1/.test(q))).toBe(true);
  });

  it("1b. a word in common is a candidate, not the provision: an NHS pension accrual leaves R7 undetermined; a correctly named £1,200 against £81,600 is booked but short (Wetherby)", () => {
    const run = (description: string, lines: [string, number][]) =>
      buildPlanFromFile(
        (() => {
          const f = clone(loadClientFile("wetherby"));
          post(f, "MJ-R1b", description, lines);
          return f;
        })(),
      ).plan;
    const pension = run("NHS pension contributions accrual", [
      ["7000", 200_000],
      ["2250", -200_000],
    ]);
    expect(area(pension, "accrualsProvisions").rules.find((r) => r.startsWith("R7"))).toMatch(
      /MJ-R1b \("NHS pension contributions accrual", debiting 7000 Gross wages, not income\) shares only a word with the estimate: a candidate, not a match.*undetermined/,
    );
    expect(area(pension, "revenue").level).toBe("significant");
    expect(pension.questions.some((q) => /^N4: .*MJ-R1b/.test(q))).toBe(true);
    const short = run("NHS clawback provision 2025/26", [
      ["4030", 120_000],
      ["2260", -120_000],
    ]);
    expect(area(short, "accrualsProvisions").level).toBe("significant");
    expect(area(short, "accrualsProvisions").rules.find((r) => r.startsWith("R7"))).toMatch(
      /booked but not adequately: MJ-R1b books £1,200 against an indicative £81,600, short by £80,400/,
    );
    expect(area(short, "revenue").rules.find((r) => r.startsWith("R7"))).toMatch(
      /what is booked falls short of it .*overstated by up to £80,400/,
    );
    expect(area(short, "revenue").level).toBe("significant");
  });

  it("1c. a provision booked and reversed in the year is no provision: R7 returns in full; a partial reversal leaves it short (Wetherby)", () => {
    const run = (reverseMinor: number) =>
      buildPlanFromFile(
        (() => {
          const f = clone(loadClientFile("wetherby"));
          post(f, "MJ-R1c", "NHS clawback provision 2025/26", [
            ["4030", 8_160_000],
            ["2260", -8_160_000],
          ]);
          post(
            f,
            "MJ-R1d",
            "Reverse NHS clawback provision 2025/26",
            [
              ["2260", reverseMinor],
              ["4030", -reverseMinor],
            ],
            "MJ-R1c",
          );
          return f;
        })(),
      ).plan;
    const full = run(8_160_000);
    expect(area(full, "accrualsProvisions").level).toBe("significant");
    expect(area(full, "accrualsProvisions").rules.find((r) => r.startsWith("R7"))).toMatch(
      /MJ-R1c booked £81,600 and MJ-R1d \(reversal of MJ-R1c\) releases £81,600 in the same year: £0 remains/,
    );
    expect(area(full, "revenue").rules.find((r) => r.startsWith("R7"))).toMatch(
      /what was booked for it was reversed in the year .*overstated by up to £81,600/,
    );
    const part = run(5_000_000);
    expect(area(part, "accrualsProvisions").rules.find((r) => r.startsWith("R7"))).toMatch(
      /booked but not adequately: MJ-R1c books £31,600 net of MJ-R1d against an indicative £81,600, short by £50,000/,
    );
    expect(area(part, "revenue").rules.find((r) => r.startsWith("R7"))).toMatch(/overstated by up to £50,000/);
  });

  it("2. two copies of Calder MJ-000016 with new ids do not make it routine: all three keep the signal and are tested", () => {
    const base = loadClientFile("calder"),
      f = clone(base);
    for (const v of ["MJ-R2a", "MJ-R2b"]) {
      const e = clone(base).ledger.find((x) => x.voucher === "MJ-000016")!;
      e.voucher = v;
      f.ledger.push(e);
      for (const l of e.lines) f.tb.find((t) => t.account === l.account)!.closingMinor += l.amountMinor;
    }
    const was = journalSignals(base).find((s) => s.id === "journal:MJ-000016")!;
    for (const v of ["MJ-000016", "MJ-R2a", "MJ-R2b"]) {
      const s = journalSignals(f).find((x) => x.id === `journal:${v}`);
      expect(s?.severity, v).toBe(was.severity);
      expect(s?.mustTest["JNL-01"], v).toEqual([v]);
    }
  });

  it("3. two runs must agree, always: a lone valid run yields nothing, and unshared assertions are not borrowed from the first run", () => {
    const notes = loadClientFile("wetherby").notes;
    const claim = (assertions: ExtractionPayload["claims"][number]["assertions"]) => ({
      noteId: "N4",
      area: "accrualsProvisions" as const,
      assertions,
      direction: "raises" as const,
      claim: "c",
      quote: "No provision has been made",
      amountMinor: null,
    });
    const payload = (claims: ExtractionPayload["claims"]): ExtractionPayload => ({
      claims,
      estimates: [],
      facts: {
        longTermContractsSpanYearEnd: { value: null, noteId: null, quote: null },
        borrowingCovenants: { value: null, noteId: null, quote: null },
        impairmentIndicators: { value: null, noteId: null, quote: null },
        assetRegisterVerifiedWithinThreeYears: { value: null, noteId: null, quote: null },
      },
    });
    const file = (raws: string[]): ExtractionFile => ({
      client: "wetherby",
      inputSha256: "x",
      promptSha256: "y",
      prompt: "",
      runs: raws.map((raw) => ({ model: "m", effort: "high", raw, stopReason: "end_turn", usage: {} })),
    });
    const lone = mergeRuns(file([JSON.stringify(payload([claim(["completeness"])])), "not json", "{"]), notes);
    expect(lone.claims).toEqual([]);
    expect(lone.disagreements.some((d) => /^extraction: only 1 of 3 runs are valid/.test(d))).toBe(true);
    const split = mergeRuns(
      file([
        JSON.stringify(payload([claim(["completeness"])])),
        JSON.stringify(payload([claim(["valuation"])])),
        JSON.stringify(payload([])),
      ]),
      notes,
    );
    expect(split.claims.map((c) => c.assertions)).toEqual([[]]);
    expect(split.disagreements.some((d) => /no assertion is named by two.*completeness vs valuation/.test(d))).toBe(
      true,
    );
  });

  it("4. R6 does not count paragraphs: one (Wetherby N7) raises purchases to elevated, and three saying the same do not make it significant", () => {
    const f = canonical(loadClientFile("wetherby")),
      signals = allSignals(f),
      fb = priorYearFeedback(f, parseProgramme().procedures);
    const notes = loadMergedNotes("wetherby", f.notes);
    const n7 = notes.claims.filter((c) => c.area === "purchasesCreditors");
    expect(n7.map((c) => c.noteId)).toEqual(["N7"]);
    const level = (claims: typeof notes.claims) =>
      assessRisk(
        f,
        signals,
        { ...notes, claims: [...notes.claims.filter((c) => c.area !== "purchasesCreditors"), ...claims] },
        fb,
      ).find((r) => r.area === "purchasesCreditors")!;
    expect(level([]).level).toBe("baseline");
    expect(level(n7).level).toBe("elevated");
    expect(level(n7).rules.some((r) => r.startsWith("R6"))).toBe(true);
    expect(level(["N6", "N7", "N8"].map((id) => ({ ...n7[0], noteId: id }))).level).toBe("elevated");
  });

  it("5. notes claims are labelled hypotheses, and JNL-02 tests the estimates the file holds, not a general-table sample", () => {
    for (const p of Object.values(plans)) {
      for (const s of p.areas.flatMap((a) => a.sources).filter((s) => s.ref.startsWith("note:")))
        expect(s.text, s.ref).toMatch(/^N\d+ \(hypothesis from the notes, to confirm in fieldwork\): /);
      const jnl02 = p.procedures.find((x) => x.procedureId === "JNL-02")!;
      const expected = estimateAccounts(loadClientFile(p.clientId));
      expect(jnl02.extent, p.clientId).toBe(
        `every item the file identifies: ${expected.length} (${[...expected].sort().join(", ")}); the procedure tests the whole population, so the risk level does not change the sample`,
      );
    }
  });

  it("6. DESIGN.md agrees with the engine: hours as planned, the budget question asks how an overrun is approved, precision is not called correctness", () => {
    // only what ships in starter-ts/ is checked here
    const design = doc("DESIGN.md");
    const quoted = /\(([\d.]+)\/(\d+)h, ([\d.]+)\/(\d+)h, ([\d.]+)\/(\d+)h\)/.exec(design)!.slice(1).map(Number);
    expect(quoted).toEqual(
      ["ashworth", "calder", "wetherby"].flatMap((c) => [plans[c].totalHours, plans[c].budgetHours]),
    );
    expect(design).toContain(`ruleset \`${plans.wetherby.rulesetVersion}\``);
    expect(design).not.toMatch(/budget a ceiling/i);
    expect(design).toMatch(/how does the partner approve an overrun/);
    expect(design).toMatch(/precision 0\.89, recall 0\.81 \(consistency, not correctness\)/);
  });
});
