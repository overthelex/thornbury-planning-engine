/**
 * Offline step: reads one client's planning notes and asks the models for claims and facts.
 * Writes data/derived/<client>/notes_extraction.json with the prompt, its hash, the notes hash and every raw response.
 * `plan` never runs this; it reads the committed file. Usage: npm run extract -- <client|all>
 */
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { listClients, loadCompany, loadPlanningNotesMarkdown } from "../load";
import {
  AREAS,
  ASSERTIONS,
  FACT_KEYS,
  extractionPath,
  sha256,
  type ExtractionFile,
  type ExtractionRun,
} from "../notes";

/** Two runs of the primary model and one of a second model: the merge keeps what at least two agree on. */
export const RUNS: { model: string; effort: "high" }[] = [
  { model: "claude-opus-5-5", effort: "high" },
  { model: "claude-opus-5-5", effort: "high" },
  { model: "claude-sonnet-5-5", effort: "high" },
];

export const SYSTEM = `You read an audit senior's planning notes for a UK owner-managed company and extract, paragraph by paragraph, what each paragraph tells an auditor about where the accounts could be materially wrong.

You do not assess risk levels, choose procedures or estimate hours. Another system does that from the ledger and from what you return. Your job is to read the prose the way an experienced engagement partner would, including what is implied: hesitation, contradiction, a director volunteering something, a control that exists only in someone's head, a figure nobody has checked.

Audit areas (use these ids exactly):
- revenue: sales, takings, contract revenue, NHS or other contract income, cut-off of income
- debtors: trade debtors, retentions, other debtors and prepayments
- purchasesCreditors: purchases, suppliers, subcontractors, approval of invoices, creditors
- payroll: wages, starters and leavers, pension, PAYE
- fixedAssets: additions, vehicles, equipment, depreciation, impairment
- bankCash: bank, cash handling, bank payments, overdraft
- relatedParties: directors, their families and companies, director loans, personal expenditure through the company
- journalsManagementOverride: who can post journals, management's ability to override controls, pressure or incentive to manipulate results
- goingConcern: borrowings, covenants, cash headroom, the business's ability to continue
- stock: stock counts, work in progress, stock valuation
- openingBalances: balances brought forward from a year the firm did not audit
- vat: VAT returns, input VAT recovery
- accrualsProvisions: accruals, provisions, clawbacks, accounting estimates
- completion: laws and regulations, sector registrations, subsequent events, disclosure

Assertions (use these ids exactly): existence, completeness, accuracy, cutOff, valuation, rightsAndObligations, classification, presentation, occurrence.

For each paragraph [N#] return zero or more claims. A claim is one (paragraph, area, direction):
- direction "raises": the paragraph points to a way the accounts in that area could be wrong. Say how, in one sentence, in plain English.
- direction "lowers": the paragraph is genuine evidence that the risk in that area is lower (not merely the absence of bad news).
- Paragraphs with nothing for the auditor (parking, small talk) get no claims.
- One paragraph may raise several areas. Use context from other paragraphs to interpret a paragraph, but the quote must come from the paragraph the claim is about.
- quote: copy a short, exact, contiguous span of that paragraph's text that the claim rests on. Do not paraphrase or join fragments.
- amountMinor: only if the quoted span itself states an amount; give it in pence (pounds times 100). Otherwise null.

Facts: answer each from the notes only. value true or false only when a paragraph says so, with its id and an exact quote; otherwise value null, noteId null, quote null.
- longTermContractsSpanYearEnd: contracts in progress at the year end whose revenue depends on stage of completion or payment schedules.
- borrowingCovenants: borrowing facilities with covenants tested on the accounts.
- impairmentIndicators: assets under-used, idle, obsolete or damaged.
- assetRegisterVerifiedWithinThreeYears: whether the fixed asset register has been physically verified in the last three years.

Estimates: list every accounting estimate the notes mention (provisions, clawbacks, accruals, stock or WIP valuation, useful lives), with the paragraph id, an exact quote, and amountMinor only if the quote states an amount.`;

const fact = {
  type: "object",
  additionalProperties: false,
  required: ["value", "noteId", "quote"],
  properties: {
    value: { type: ["boolean", "null"] },
    noteId: { type: ["string", "null"] },
    quote: { type: ["string", "null"] },
  },
};
export const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["claims", "facts", "estimates"],
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["noteId", "area", "assertions", "direction", "claim", "quote", "amountMinor"],
        properties: {
          noteId: { type: "string" },
          area: { type: "string", enum: AREAS },
          assertions: { type: "array", items: { type: "string", enum: ASSERTIONS } },
          direction: { type: "string", enum: ["raises", "lowers"] },
          claim: { type: "string" },
          quote: { type: "string" },
          amountMinor: { type: ["integer", "null"] },
        },
      },
    },
    facts: {
      type: "object",
      additionalProperties: false,
      required: [...FACT_KEYS],
      properties: Object.fromEntries(FACT_KEYS.map((k) => [k, fact])),
    },
    estimates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "noteId", "quote", "amountMinor"],
        properties: {
          description: { type: "string" },
          noteId: { type: "string" },
          quote: { type: "string" },
          amountMinor: { type: ["integer", "null"] },
        },
      },
    },
  },
};

export const userPrompt = (companyName: string, notesMd: string) =>
  `Client: ${companyName}\n\nPlanning notes, exactly as written:\n\n<notes>\n${notesMd}\n</notes>`;

async function extract(client: string, anthropic: Anthropic) {
  const notesMd = loadPlanningNotesMarkdown(client);
  const prompt = `${SYSTEM}\n\n---\nSCHEMA ${JSON.stringify(SCHEMA)}`;
  const runs: ExtractionRun[] = [];
  for (const r of RUNS) {
    const res = await anthropic.messages
      .stream({
        model: r.model,
        max_tokens: 32000,
        system: SYSTEM,
        output_config: { effort: r.effort, format: { type: "json_schema", schema: SCHEMA } },
        messages: [{ role: "user", content: userPrompt(loadCompany(client).name, notesMd) }],
      } as Anthropic.MessageStreamParams)
      .finalMessage();
    const raw = res.content
      .filter((b) => b.type === "text")
      .map((b) => (b as Anthropic.TextBlock).text)
      .join("");
    runs.push({ model: res.model, effort: r.effort, raw, stopReason: String(res.stop_reason), usage: res.usage });
    console.log(`${client}: ${r.model} ${res.stop_reason} in=${res.usage.input_tokens} out=${res.usage.output_tokens}`);
  }
  const file: ExtractionFile = { client, inputSha256: sha256(notesMd), promptSha256: sha256(prompt), prompt, runs };
  const path = extractionPath(client);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
  console.log(`wrote ${path}`);
}

if (require.main === module) {
  const arg = process.argv[2] ?? "all";
  const anthropic = new Anthropic();
  (async () => {
    for (const c of arg === "all" ? listClients() : [arg]) await extract(c, anthropic);
  })().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
