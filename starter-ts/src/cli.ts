import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildPlan } from "./engine";
import { renderPlan } from "./render";
import { ALSO_RESPONDS } from "./select";
import {
  listClients,
  loadAccounts,
  loadBankStatement,
  loadCompany,
  loadLedger,
  loadParties,
  loadPlanningNotes,
  loadPriorYearFindings,
  loadPriorYearPlan,
  loadProgrammeMarkdown,
  loadTrialBalance,
} from "./load";

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
    const byJournal = ledger.reduce<Record<string, number>>(
      (acc, e) => ((acc[e.journal] = (acc[e.journal] ?? 0) + 1), acc),
      {},
    );
    const e = company.engagement;
    console.log(
      `\n${client}: ${company.name}  FY ${company.financialYear.start} to ${company.financialYear.end}${e.firstYear ? "  (first-year engagement)" : `  (year ${e.yearsAsAuditor} as auditors)`}`,
    );
    console.log(
      `  materiality overall ${gbp(e.materialityMinor.overall)}, performance ${gbp(e.materialityMinor.performance)}, trivial ${gbp(e.materialityMinor.clearlyTrivial)}; budget ${e.fieldworkBudgetHours}h`,
    );
    console.log(
      `  entries: ${ledger.length}  lines: ${lines.length}  ${Object.entries(byJournal)
        .map(([j, n]) => `${j}=${n}`)
        .join("  ")}`,
    );
    console.log(`  total debits ${gbp(debits)}  total credits ${gbp(credits)}`);
    console.log(
      `  accounts: ${loadAccounts(client).length}  parties: ${loadParties(client).length}  trial balance rows: ${loadTrialBalance(client).length}`,
    );
    console.log(
      `  bank: ${loadBankStatement(client, "year").length} lines in year, ${loadBankStatement(client, "next").length} in Q1 after`,
    );
    console.log(
      `  prior-year findings: ${loadPriorYearFindings(client).length}  prior-year plan: ${loadPriorYearPlan(client)?.length ?? "none"}  planning notes: ${loadPlanningNotes(client).length} paragraphs`,
    );
  }
  const programme = loadProgrammeMarkdown();
  console.log(
    `\nprogramme: ${programme.split("\n").filter((l) => l.startsWith("### ")).length} procedures in ${programme.length} characters of markdown`,
  );
} else if (command === "plan") {
  if (!arg) {
    console.error("usage: npm run cli -- plan <client|all>");
    process.exitCode = 2;
  } else
    for (const client of arg === "all" ? listClients() : [arg]) {
      const result = buildPlan(client);
      const dir = join(__dirname, "..", "plans", client);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "plan.json"), JSON.stringify(result.plan, null, 2) + "\n");
      writeFileSync(join(dir, "PLAN.md"), renderPlan(result));
      const p = result.plan;
      console.log(
        `${client}: ${
          p.areas
            .filter((a) => a.level === "significant")
            .map((a) => a.area)
            .join(", ") || "no"
        } significant; ${p.procedures.filter((x) => x.selected).length} procedures selected, ${p.totalHours}h of ${p.budgetHours}h -> plans/${client}/`,
      );
    }
} else if (command === "explain") {
  // the walk Ingrid asked for: one area, from its level to the rules, to each piece of evidence, to the procedures it drives
  const areaId = process.argv[4];
  if (!arg || !areaId) {
    console.error("usage: npm run cli -- explain <client> <area>");
    process.exitCode = 2;
  } else {
    const { plan, evidence } = buildPlan(arg);
    const a = plan.areas.find((x) => x.area === areaId);
    if (!a) {
      console.error(`unknown area ${areaId}; one of: ${plan.areas.map((x) => x.area).join(", ")}`);
      process.exitCode = 2;
    } else {
      const ev = (ids: string[]) => ids.map((id) => `        ${id.padEnd(14)} ${evidence.get(id)}`).join("\n");
      console.log(
        `\n${plan.clientId} / ${a.area}: ${a.level.toUpperCase()}   assertions at risk: ${a.assertions.join(", ") || "none"}`,
      );
      console.log(`\n  RULES (ruleset ${plan.rulesetVersion})`);
      for (const r of a.rules) console.log(`    ${r}`);
      if (a.scopeReason) console.log(`\n  OUT OF SCOPE: ${a.scopeReason}\n${ev(a.scopeEvidence)}`);
      const raising = a.sources.filter((s) => s.severity !== "info");
      if (raising.length) console.log(`\n  WHY (${raising.length} sources)`);
      for (const s of raising)
        console.log(
          `\n    [${s.kind}${s.severity === "significant" ? ", significant" : ""}] ${s.text}\n${ev(s.evidenceIds)}`,
        );
      const ctx = [...a.sources.filter((s) => s.severity === "info"), ...a.mitigating];
      if (ctx.length) {
        console.log(`\n  CONSIDERED, NOT RAISING`);
        for (const s of ctx) console.log(`    ${s.text}`);
      }
      const procs = plan.procedures.filter(
        (p) => p.area === a.area || p.extentArea === a.area || (ALSO_RESPONDS[p.procedureId] ?? []).includes(a.area),
      );
      console.log(`\n  PROCEDURES`);
      for (const p of procs)
        console.log(
          `\n    ${p.status === "selected" ? "SELECTED " : p.status === "omitted" ? "OMITTED  " : "N/A      "}${p.procedureId}${p.area !== a.area ? ` (from ${p.area})` : ""}  ${p.hours}h${p.extent ? `  extent: ${p.extent}` : ""}\n      ${p.reason}`,
        );
      if (raising.some((s) => s.kind === "notes"))
        console.log(
          `\n  Notes claims come from ${plan.notesExtraction.file}: ${plan.notesExtraction.models.join(", ")}, kept only where two runs agree and the quote is in the paragraph. The quote proves where a claim comes from, not that the reading is right: each is a hypothesis for fieldwork.`,
        );
      console.log("");
    }
  }
} else {
  console.error(
    `unknown command: ${command}\nusage: npm run cli -- summary [client] | plan <client|all> | explain <client> <area>`,
  );
  process.exitCode = 2;
}
