import { describe, expect, it } from "vitest";
import {
  listClients,
  loadAccounts,
  loadLedger,
  loadPlanningNotes,
  loadProgrammeMarkdown,
  loadTrialBalance,
} from "../src/load";

describe("data loads", () => {
  it("lists three clients", () => {
    expect(listClients()).toEqual(["ashworth", "calder", "wetherby"]);
  });

  it("reads every client's ledger and trial balance, and the trial balance foots", () => {
    for (const client of listClients()) {
      const ledger = loadLedger(client);
      expect(ledger.length).toBeGreaterThan(500);
      expect(ledger[0].lines[0]).toHaveProperty("amountMinor");
      expect(loadTrialBalance(client).reduce((s, r) => s + r.closingMinor, 0)).toBe(0);
      expect(loadAccounts(client).some((a) => a.code === "1200")).toBe(true);
    }
  });

  it("splits the planning notes into numbered paragraphs", () => {
    const notes = loadPlanningNotes("ashworth");
    expect(notes.length).toBeGreaterThan(10);
    expect(notes[0].id).toBe("N1");
    expect(notes.every((n) => n.section.length > 0)).toBe(true);
  });

  it("reads the programme as markdown", () => {
    expect(loadProgrammeMarkdown()).toContain("### JNL-01");
  });
});
