import type { Area, Assertion, Procedure, ProcedureLevel, RiskLevel } from "./types";
import { loadProgrammeMarkdown } from "./load";

/** Sample sizes by risk level, as the programme states them. */
export interface SampleTable {
  baseline: number;
  elevated: number;
  significant: number;
}

export interface ProgrammeProcedure extends Procedure {
  /** The procedure's own sample table, when its text quotes one; otherwise null and the general table applies. */
  ownSampleTable: SampleTable | null;
  /** True when the text asks for every entry meeting a "must test" criterion on top of the sample (JNL-01). */
  mustTestAll: boolean;
}

export interface Programme {
  procedures: ProgrammeProcedure[];
  generalSampleTable: SampleTable;
}

const AREA_BY_HEADING: Record<string, Area> = {
  revenue: "revenue",
  debtors: "debtors",
  "purchases and creditors": "purchasesCreditors",
  payroll: "payroll",
  "fixed assets": "fixedAssets",
  "bank and cash": "bankCash",
  "related parties": "relatedParties",
  "journals and management override": "journalsManagementOverride",
  "going concern": "goingConcern",
  stock: "stock",
  "opening balances": "openingBalances",
  vat: "vat",
  "accruals and provisions": "accrualsProvisions",
  completion: "completion",
};
const ASSERTIONS: Assertion[] = [
  "existence",
  "completeness",
  "accuracy",
  "cutOff",
  "valuation",
  "rightsAndObligations",
  "classification",
  "presentation",
  "occurrence",
];
const LEVELS: ProcedureLevel[] = ["mandatory", "baseline", "elevated", "significant"];

function sampleTableIn(text: string): SampleTable | null {
  const m =
    text.match(/(\d+) at baseline, (\d+) at elevated,? (?:and )?(\d+) at significant/) ??
    text.match(/baseline (\d+), elevated (\d+),? (?:and )?significant (\d+)/);
  return m ? { baseline: Number(m[1]), elevated: Number(m[2]), significant: Number(m[3]) } : null;
}

/** Parses the programme exactly as the firm exports it. Throws on anything it does not recognise, so a changed programme fails loudly. */
export function parseProgramme(md: string = loadProgrammeMarkdown()): Programme {
  const general = sampleTableIn(md.slice(0, md.indexOf("\n## Revenue")));
  if (!general) throw new Error("programme: general sample-size table not found");
  const procedures: ProgrammeProcedure[] = [];
  let area: Area | null = null;
  const blocks = md.split(/\n(?=## |### )/);
  for (const block of blocks) {
    const h2 = block.match(/^## (.+)/);
    if (h2) {
      const key = h2[1].trim().toLowerCase();
      area = AREA_BY_HEADING[key] ?? null;
      if (!area && key !== "how to read this programme") throw new Error(`programme: unknown area heading "${h2[1]}"`);
      continue;
    }
    const h3 = block.match(/^### ([A-Z]+-\d+) (.+)/);
    if (!h3) continue;
    if (!area) throw new Error(`programme: ${h3[1]} is outside an area`);
    const meta = block.match(
      /\*\*Assertions:\*\* (.+?) · \*\*Level:\*\* (\w+) · \*\*Hours:\*\* (\d+(?:\.\d+)?) · \*\*Scalable:\*\* (yes|no)/,
    );
    const appl = block.match(/\*\*Applicability:\*\* (.+)/);
    if (!meta || !appl) throw new Error(`programme: ${h3[1]} has no metadata line`);
    const assertions = meta[1].split(",").map((s) => s.trim()) as Assertion[];
    for (const a of assertions)
      if (!ASSERTIONS.includes(a)) throw new Error(`programme: ${h3[1]} unknown assertion ${a}`);
    const level = meta[2] as ProcedureLevel;
    if (!LEVELS.includes(level)) throw new Error(`programme: ${h3[1]} unknown level ${level}`);
    const description = block.slice(block.indexOf(appl[0]) + appl[0].length).trim();
    procedures.push({
      id: h3[1],
      area,
      title: h3[2].trim(),
      description,
      assertions,
      level,
      hours: Number(meta[3]),
      scalable: meta[4] === "yes",
      applicability: appl[1].trim(),
      ownSampleTable: sampleTableIn(description),
      mustTestAll: /must test/i.test(description),
    });
  }
  return { procedures, generalSampleTable: general };
}

export const LEVEL_RANK: Record<RiskLevel | ProcedureLevel | "info", number> = {
  notApplicable: -1,
  info: 0,
  mandatory: 0,
  baseline: 1,
  elevated: 2,
  significant: 3,
};
