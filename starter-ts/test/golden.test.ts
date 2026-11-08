/**
 * The audit conclusions a reviewer would check first, one row each, with the reason it is expected.
 * plans/ is already locked byte for byte by invariants.test.ts; this table says which lines of it matter,
 * so a change to a rule that moves one of them fails with a name rather than a diff.
 */
import { describe, expect, it } from "vitest";
import { buildPlan } from "../src/engine";

const plan = Object.fromEntries(["ashworth", "calder", "wetherby"].map((c) => [c, buildPlan(c).plan]));
const area = (c: string, a: string) => plan[c].areas.find((x) => x.area === a)!;
const proc = (c: string, id: string) => plan[c].procedures.find((p) => p.procedureId === id)!;

describe.each([
  [
    "wetherby",
    "accrualsProvisions",
    "significant",
    "R7: N4 needs a clawback provision (£81,600 by code); 2250/2260 unposted",
  ],
  ["wetherby", "vat", "notApplicable", "R5: no VAT control accounts"],
  [
    "wetherby",
    "purchasesCreditors",
    "elevated",
    "R6: one notes paragraph (N7, Sue approves and posts her own invoices) is enough for elevated; nothing in the data makes it significant",
  ],
  [
    "wetherby",
    "revenue",
    "significant",
    "R7 revenue side: the unbooked NHS clawback (N4, £81,600) overstates income recognised in full; accuracy only",
  ],
  [
    "calder",
    "goingConcern",
    "significant",
    "R8: covenants on audited accounts (N5), interest posted to bank charges, overdraft",
  ],
  ["calder", "stock", "significant", "R2: MJ-000016 round £56,000 stock journal plus N8/N16/N18"],
  ["calder", "purchasesCreditors", "elevated", "the stock journal belongs to stock, not purchases"],
  ["ashworth", "payroll", "significant", "R3: FY24-14 leaver recurs, E019 paid £13,986 after leaving"],
  [
    "ashworth",
    "vat",
    "significant",
    "Q2 and Q4 returns declare £215,869 less than the control accounts (MJ-000010, B25-01230, B26-00140)",
  ],
  [
    "calder",
    "vat",
    "significant",
    "Q2 and Q4 returns declare £109,036 less than the control accounts (MJ-000010, B25-00780, B26-00096)",
  ],
  [
    "ashworth",
    "relatedParties",
    "significant",
    "MJ-000016: a £35,000 advance to the MD, above the s.207 £10,000 limit",
  ],
  [
    "calder",
    "relatedParties",
    "significant",
    "PI-000494: £10,080 paid for work at a private address, above the s.207 limit",
  ],
  ["ashworth", "stock", "notApplicable", "R5: no stock"],
])("%s %s", (client, a, level, why) => {
  it(`is ${level}: ${why}`, () => expect(area(client, a).level).toBe(level));
});

describe.each([
  ["ashworth", "FA-01", true, /30h against 3h/, "memo 4: last year's 30h on vans holds FA-01 at programme extent"],
  [
    "ashworth",
    "RP-02",
    true,
    /every item the file identifies: 13 /,
    "every related-party transaction, not only the one-off",
  ],
  ["ashworth", "PAY-03", true, /^all 12 months .*including 2025-07/, "samples months, including the leaver's"],
  ["calder", "GC-02", true, /./, "R8 makes going concern significant"],
  ["calder", "STK-01", true, /roll back to the year-end quantities/, "the count is past: the programme's roll-back"],
  [
    "calder",
    "REV-06",
    true,
    /^40 weeks .*including week 19, week 20, week 33/,
    "a sample of weeks that includes the gaps",
  ],
  [
    "wetherby",
    "REV-06",
    true,
    /including week 52/,
    "takings stop at week 51: the series runs to the year end, not to the last recorded week",
  ],
  [
    "wetherby",
    "REV-04",
    false,
    /raises no sales invoices/,
    "an NHS contract paid monthly is not stage-of-completion revenue",
  ],
  [
    "wetherby",
    "PUR-03",
    true,
    /purchasesCreditors is assessed elevated/,
    "N7 self-approval raises purchases in its own right, not only through last year's compensating control",
  ],
  ["wetherby", "GC-02", false, /no borrowings/, "no borrowing accounts, so no covenants and no partner question"],
  [
    "wetherby",
    "REV-02",
    true,
    /^20 items \(elevated/,
    "the clawback misstates the amount, not cut-off: REV-02 keeps elevated extent",
  ],
  [
    "wetherby",
    "REV-03",
    true,
    /every item the file identifies: 1 \(MJ-000013\)/,
    "every manual revenue entry: the director's refund journal, not a sample of 40",
  ],
  [
    "wetherby",
    "JNL-02",
    true,
    /every item the file identifies: 3 \(2250, 2260, 8000\)/,
    "every estimate in the accounts (accruals, the clawback provision, useful lives), not a general-table sample of 40",
  ],
  [
    "calder",
    "REV-03",
    true,
    /holds no items/,
    "no manual revenue entries: confirm the listing at programme hours, not a sample of 40",
  ],
])("%s %s", (client, id, selected, text, why) => {
  it(`${selected ? "selected" : "not selected"}: ${why}`, () => {
    const p = proc(client, id);
    expect(p.selected).toBe(selected);
    expect(`${p.extent ?? ""} ${p.reason}`).toMatch(text);
  });
});

it("wetherby asks the data-integrity question first: no receipts after the year end", () => {
  expect(plan.wetherby.questions[0]).toMatch(/post-year-end bank statement/);
});
