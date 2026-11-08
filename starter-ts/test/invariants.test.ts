/**
 * What must hold for any client file. These tests are about the engine, not about Ashworth, Calder or Wetherby:
 * each one is a memo item or a contract the plan relies on.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPlan } from "../src/engine";
import { loadClientFile, type ClientFile } from "../src/file";
import { bankSignals, journalSignals } from "../src/signals";
import { mergeRuns, validatePayload, type ExtractionFile, type ExtractionPayload } from "../src/notes";
import { buildEvidenceIndex, assertEvidence } from "../src/evidence";
import { shortfallBound } from "../src/risk";
import { parseProgramme } from "../src/programme";
import { listClients } from "../src/load";
import type { LedgerEntry } from "../src/types";

const clone = (f: ClientFile): ClientFile => JSON.parse(JSON.stringify(f));
const plans = listClients().map((c) => ({ client: c, ...buildPlan(c) }));

describe("memo 5: the same file gives the same plan", () => {
  it.each(listClients())("%s reproduces the committed plans/ byte for byte, offline", (client) => {
    const committed = readFileSync(join(__dirname, "..", "plans", client, "plan.json"), "utf8");
    expect(JSON.stringify(plans.find((p) => p.client === client)!.plan, null, 2) + "\n").toBe(committed);
  });
});

describe("memo 1 and 3: every reason points at the file", () => {
  it("refuses an id that is not in the file", () => {
    const ix = buildEvidenceIndex(loadClientFile("wetherby"));
    expect(() => assertEvidence(ix, ["N4", "MJ-000013"], "t")).not.toThrow();
    expect(() => assertEvidence(ix, ["MJ-999999"], "t")).toThrow(/not in the file/);
  });
  it("every procedure, selected or not, carries a reason; every raised area cites evidence", () => {
    for (const { plan } of plans) {
      for (const p of plan.procedures) expect(p.reason.length, p.procedureId).toBeGreaterThan(20);
      for (const r of plan.riskAssessment.filter((r) => r.level !== "baseline"))
        expect(r.evidenceIds.length, `${plan.clientId} ${r.area}`).toBeGreaterThan(0);
    }
  });
});

describe("R6: the notes alone raise an area, never to significant", () => {
  it("an area whose only raising sources are notes is elevated, whatever the number of paragraphs", () => {
    for (const { plan } of plans)
      for (const a of plan.areas.filter(
        (a) =>
          a.sources.some((s) => s.severity !== "info") &&
          a.sources.filter((s) => s.severity !== "info").every((s) => s.kind === "notes"),
      ))
        expect(a.level, `${plan.clientId} ${a.area}`).toBe("elevated");
  });
});

describe("memo 2: the budget is reported, never met by cutting", () => {
  it("total hours are the sum of what was selected, and every applicable mandatory procedure is selected", () => {
    const mandatory = parseProgramme()
      .procedures.filter((p) => p.level === "mandatory")
      .map((p) => p.id);
    for (const { plan } of plans) {
      expect(plan.totalHours).toBe(plan.procedures.filter((p) => p.selected).reduce((s, p) => s + p.hours, 0));
      for (const p of plan.procedures.filter((p) => mandatory.includes(p.procedureId) && p.status !== "notApplicable"))
        expect(p.selected, `${plan.clientId} ${p.procedureId}`).toBe(true);
      if (plan.totalHours > plan.budgetHours) expect(plan.budget.deferrable.length).toBeGreaterThan(0);
    }
  });
});

describe("memo 6: detectors read the ledger and the bank (synthetic fixtures)", () => {
  it("a manual revenue journal keyed after the year end with no approver is significant and must be tested", () => {
    const f = clone(loadClientFile("wetherby"));
    const e: LedgerEntry = {
      voucher: "MJ-TEST-1",
      journal: "manual",
      postingDate: "2025-12-30",
      transactionDate: "2025-12-30",
      systemEntryTime: "2026-02-20T10:00:00Z",
      postedBy: "sue.pm",
      approvedBy: null,
      description: "Private fees adjustment December",
      partyId: null,
      externalReference: null,
      isReversal: false,
      reversalOf: null,
      lines: [
        {
          line: 1,
          account: "1200",
          amountMinor: 3_000_000,
          taxCode: null,
          vatMinor: 0,
          partyId: null,
          description: null,
        },
        {
          line: 2,
          account: "4040",
          amountMinor: -3_000_000,
          taxCode: "T2",
          vatMinor: 0,
          partyId: null,
          description: null,
        },
      ],
    };
    f.ledger.push(e);
    const s = journalSignals(f).find((x) => x.id === "journal:MJ-TEST-1")!;
    expect(s.severity).toBe("significant");
    expect(s.mustTest["JNL-01"]).toEqual(["MJ-TEST-1"]);
    expect(s.mustTest["REV-03"]).toEqual(["MJ-TEST-1"]);
  });
  it("routine recurring journals raise nothing", () => {
    expect(journalSignals(loadClientFile("wetherby")).some((s) => /depreciation/i.test(s.summary))).toBe(false);
  });
  it("a leaver paid after leaving is found on the bank statement, where the ledger has one payroll line", () => {
    const f = clone(loadClientFile("wetherby"));
    f.parties.push({
      id: "E099",
      type: "employee",
      name: "Test Leaver",
      relatedParty: false,
      relation: "",
      startDate: "2020-01-01",
      endDate: "2025-03-31",
    });
    f.bankYear.push({
      id: "B25-TEST",
      date: "2025-04-28",
      amountMinor: -150_000,
      counterparty: "TEST LEAVER",
      reference: "PAYROLL 2025-04",
      description: "BACS",
      balanceMinor: 0,
    });
    const s = bankSignals(f).find((x) => x.id === "payroll:leaver-paid:E099")!;
    expect(s.amountMinor).toBe(150_000);
    expect(s.evidenceIds).toEqual(["E099", "B25-TEST"]);
  });
});

describe("memo 7: the notes are read by a model, checked by code", () => {
  const notes = loadClientFile("wetherby").notes;
  const claim = (over: Partial<ExtractionPayload["claims"][number]> = {}) => ({
    noteId: "N4",
    area: "accrualsProvisions" as const,
    assertions: ["completeness" as const],
    direction: "raises" as const,
    claim: "c",
    quote: "No provision has been made",
    amountMinor: null,
    ...over,
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
  it("drops a claim whose quote is not in its paragraph, or whose amount the quote does not state", () => {
    const v = validatePayload(
      payload([claim(), claim({ quote: "a provision of 80,000 is needed" }), claim({ amountMinor: 4_000_000 })]),
      notes,
    );
    expect(v.payload.claims).toHaveLength(1);
    expect(v.errors).toHaveLength(2);
  });
  it("keeps only what two of three runs agree on, and records the rest", () => {
    const run = (p: ExtractionPayload) => ({
      model: "m",
      effort: "high",
      raw: JSON.stringify(p),
      stopReason: "end_turn",
      usage: {},
    });
    const other = claim({ noteId: "N7", area: "purchasesCreditors", quote: "Sue said the arrangement" });
    const file: ExtractionFile = {
      client: "wetherby",
      inputSha256: "x",
      promptSha256: "y",
      prompt: "",
      runs: [run(payload([claim(), other])), run(payload([claim()])), run(payload([]))],
    };
    const m = mergeRuns(file, notes);
    expect(m.claims.map((c) => c.noteId)).toEqual(["N4"]);
    expect(m.disagreements.some((d) => d.includes("N7"))).toBe(true);
  });
  it("numbers the model reads are computed by code, and refused when one is missing", () => {
    expect(
      shortfallBound('they had delivered "about 92%" of the contracted UDAs. The contract value is 1,020,000.'),
    ).toEqual({ amountMinor: 8_160_000, basis: "8% undelivered of a £1,020,000 contract" });
    expect(shortfallBound("delivered about 92% of the contract")).toBeNull();
  });
});
