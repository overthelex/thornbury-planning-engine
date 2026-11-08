import { listClients, loadAccounts, loadBankStatement, loadCompany, loadLedger, loadParties, loadPlanningNotes, loadPriorYearFindings, loadPriorYearPlan, loadProgrammeMarkdown, loadTrialBalance } from "./load";

const gbp = (minor: number) => (minor / 100).toLocaleString("en-GB", { style: "currency", currency: "GBP" });
const [command = "summary", arg] = process.argv.slice(2);

if (command === "summary") {
  const clients = arg ? [arg] : listClients();
  for (const client of clients) {
    const company = loadCompany(client);
    const ledger = loadLedger(client);
    const lines = ledger.flatMap((e) => e.lines);
    const debits = lines.filter((l) => l.amountMinor > 0).reduce((s, l) => s + l.amountMinor, 0);
    const credits = lines.filter((l) => l.amountMinor < 0).reduce((s, l) => s - l.amountMinor, 0);
    const byJournal = ledger.reduce<Record<string, number>>((acc, e) => ((acc[e.journal] = (acc[e.journal] ?? 0) + 1), acc), {});
    const e = company.engagement;
    console.log(`\n${client}: ${company.name}  FY ${company.financialYear.start} to ${company.financialYear.end}${e.firstYear ? "  (first-year engagement)" : `  (year ${e.yearsAsAuditor} as auditors)`}`);
    console.log(`  materiality overall ${gbp(e.materialityMinor.overall)}, performance ${gbp(e.materialityMinor.performance)}, trivial ${gbp(e.materialityMinor.clearlyTrivial)}; budget ${e.fieldworkBudgetHours}h`);
    console.log(`  entries: ${ledger.length}  lines: ${lines.length}  ${Object.entries(byJournal).map(([j, n]) => `${j}=${n}`).join("  ")}`);
    console.log(`  total debits ${gbp(debits)}  total credits ${gbp(credits)}`);
    console.log(`  accounts: ${loadAccounts(client).length}  parties: ${loadParties(client).length}  trial balance rows: ${loadTrialBalance(client).length}`);
    console.log(`  bank: ${loadBankStatement(client, "year").length} lines in year, ${loadBankStatement(client, "next").length} in Q1 after`);
    console.log(`  prior-year findings: ${loadPriorYearFindings(client).length}  prior-year plan: ${loadPriorYearPlan(client)?.length ?? "none"}  planning notes: ${loadPlanningNotes(client).length} paragraphs`);
  }
  const programme = loadProgrammeMarkdown();
  console.log(`\nprogramme: ${programme.split("\n").filter((l) => l.startsWith("### ")).length} procedures in ${programme.length} characters of markdown`);
} else if (command === "plan") {
  console.log(`Not implemented. This is where your engine goes. Usage: npm run cli -- plan <client|all>. It should write plans/<client>/plan.json (an AuditPlan from src/types.ts).`);
  process.exitCode = 1;
} else {
  console.error(`unknown command: ${command}\nusage: npm run cli -- summary [client] | plan <client|all>`);
  process.exitCode = 2;
}
