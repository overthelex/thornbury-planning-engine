/**
 * Selection, extent and omission reasons. In programme order, for every procedure:
 *  1. not applicable → recorded with the fact that rules it out (not an omission);
 *  2. mandatory → selected, extent set by the area's level;
 *  3. area level ≥ procedure level and the procedure covers an assertion at risk → selected;
 *  4. otherwise → omitted, with the area's level and what set it.
 * Extent: the procedure's own sample table, else the general table; must-test items from the signals are listed
 * and, where the programme says "plus all must test" (JNL-01), added on top. Prior-year caps hold the extent.
 */
import type { PlannedProcedure, RiskLevel } from "./types";
import type { Programme, ProgrammeProcedure, SampleTable } from "./programme";
import { LEVEL_RANK } from "./programme";
import { knownPopulations, type Signal } from "./signals";
import type { AreaRisk } from "./risk";
import type { Feedback } from "./feedback";
import { APPLICABILITY, type ApplicabilityContext } from "./applicability";
import { AREAS } from "./notes";
import { type ClientFile, yearEnd } from "./file";

/** The periods (months "2025-07" or weeks "week 19") in which the flagged items fall. */
function periodsOf(f: ClientFile, ids: string[], period: "months" | "weeks"): string[] {
  if (period === "weeks") return ids.filter((i) => i.startsWith("week "));
  const dates = new Map<string, string>([...f.bankYear, ...f.bankNext].map((b) => [b.id, b.date]));
  for (const e of f.ledger) dates.set(e.voucher, e.postingDate);
  return [...new Set(ids.map((i) => dates.get(i)?.slice(0, 7)).filter((d): d is string => !!d))].sort();
}

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
/** The planning file's own dates (note section headings such as "Planning meeting, 11 February 2026"): if the latest is after the year end, the year-end count is past. */
export function countIsPast(f: ClientFile): { date: string; evidence: string[] } | null {
  const dated = f.notes
    .map((n) => ({ n, m: /(\d{1,2}) ([A-Za-z]+) (\d{4})/.exec(n.section) }))
    .filter((x) => x.m && MONTHS.includes(x.m[2].toLowerCase()))
    .map((x) => ({
      id: x.n.id,
      date: `${x.m![3]}-${String(MONTHS.indexOf(x.m![2].toLowerCase()) + 1).padStart(2, "0")}-${x.m![1].padStart(2, "0")}`,
    }));
  if (!dated.length) return null;
  const last = dated.reduce((a, b) => (b.date > a.date ? b : a));
  if (last.date <= yearEnd(f)) return null;
  const said = f.notes
    .filter((n) => /count (?:was done|that has already happened|took place)/i.test(n.text))
    .map((n) => n.id);
  return { date: last.date, evidence: said.length ? [`the notes say so: ${said.join(", ")}`] : [] };
}

/** Procedures whose text responds to another area's risk as well as their own (JNL-02 names accruals, provisions, clawbacks, stock valuation and useful lives). */
export const ALSO_RESPONDS: Record<string, string[]> = {
  "JNL-02": ["accrualsProvisions", "stock", "fixedAssets"],
  "JNL-03": ["relatedParties"],
  "REV-05": ["debtors"],
};

export type ProcedureStatus = "selected" | "omitted" | "notApplicable";
export interface PlannedLine extends PlannedProcedure {
  status: ProcedureStatus;
  area: string;
  level: string;
  unknown?: boolean;
  extentArea?: string;
}

const roundHalf = (h: number) => Math.round(h * 2) / 2;
const levelKey = (l: RiskLevel): keyof SampleTable =>
  l === "significant" ? "significant" : l === "elevated" ? "elevated" : "baseline";

/** Items the signals say this procedure must cover, and the signals that said so. */
function mustTestFor(signals: Signal[], id: string) {
  return {
    must: [...new Set(signals.flatMap((s) => s.mustTest[id] ?? []))].sort(),
    mustFrom: signals.filter((s) => s.mustTest[id]?.length),
  };
}

/**
 * The risk a procedure answers to. Its own area, unless it also responds to another area (ALSO_RESPONDS) that is
 * assessed higher and shares one of its assertions, or whose assertions are not at risk in its own area at all
 * (REV-05 tests debtors' existence and valuation).
 */
function governingRisk(p: ProgrammeProcedure, risks: AreaRisk[]): { own: AreaRisk; also: AreaRisk | undefined } {
  const own = risks.find((r) => r.area === p.area)!;
  const ownCovers = p.assertions.some((x) => own.assertions.includes(x));
  const also = (ALSO_RESPONDS[p.id] ?? [])
    .map((a) => risks.find((r) => r.area === a)!)
    .filter(
      (r) =>
        r.level !== "notApplicable" &&
        (LEVEL_RANK[r.level] > LEVEL_RANK[own.level] || !ownCovers) &&
        p.assertions.some((x) => r.assertions.includes(x)),
    )
    .sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level])[0];
  return { own, also };
}

/** Why a procedure that applies is still not run: the level is below its programme level, or none of its assertions is at risk. */
function omissionReason(
  p: ProgrammeProcedure,
  risk: AreaRisk,
  levelOk: boolean,
  must: string[],
  mustFrom: Signal[],
): string {
  const why = !levelOk
    ? `${p.area} is assessed ${risk.level}${risk.rules.length ? ` (${risk.rules.join("; ")})` : " (no source in the file raises it)"}; ${p.id} runs from ${p.level} upward`
    : `${p.area} is ${risk.level} for ${risk.assertions.join(", ")}; ${p.id} addresses ${p.assertions.join(", ")}, none of which is at risk`;
  if (!must.length) return `Not selected: ${why}.`;
  const coveredBy =
    mustFrom
      .flatMap((s) => Object.keys(s.mustTest))
      .filter((x) => x !== p.id)
      .join(", ") || "no other selected procedure";
  return `Not selected: ${why}. Note: the signals name ${must.join(", ")} for this procedure; they are covered by ${coveredBy}.`;
}

interface Extent {
  extent: string | null;
  hours: number;
  /** the procedure tests its whole population, so the level does not change it */
  whole: boolean;
}

/**
 * How much of a scalable procedure to do, from the programme's sample tables at the effective level:
 *  - a whole population the file identifies ("every leaver", "every estimate") is listed, not sampled;
 *  - a procedure sampling months or weeks is capped at the periods in the year and names the flagged ones;
 *  - a fixed programme extent is quoted as such;
 *  - otherwise the table's number, with must-test items added (mustTestAll) or at least included.
 * Hours scale with the sample against the table's baseline.
 */
function extentOf(p: ProgrammeProcedure, prog: Programme, f: ClientFile, effective: RiskLevel, must: string[]): Extent {
  if (!p.scalable) return { extent: null, hours: p.hours, whole: false };
  const own = p.ownSampleTable;
  const table = own ?? prog.generalSampleTable;
  const tableName = own ? `${p.id}'s own table` : "the firm's general table";
  const level = levelKey(effective);
  const fixedExtent = !own && /Extent: (.+?)(?:;|\.)/.exec(p.description)?.[1];
  const everyItem = /\b(every|each)\b/i.test(p.description) && !/\bsample\b/i.test(p.description) && !p.mustTestAll;
  const known = everyItem ? knownPopulations(f)[p.id] : undefined;
  const population = known ? [...new Set([...known, ...must])].sort() : must;
  const wholePopulation =
    everyItem && (known !== undefined || population.length > 0) && population.length <= table.baseline;
  const period = /sample of (months|weeks)/i.exec(p.description)?.[1].toLowerCase() as "months" | "weeks" | undefined;

  if (wholePopulation)
    return {
      whole: true,
      hours: p.hours,
      extent: population.length
        ? `every item the file identifies: ${population.length} (${population.join(", ")}); the procedure tests the whole population, so the risk level does not change the sample`
        : "the file holds no items in this procedure's population; confirm the client's own listing agrees, at programme hours",
    };
  if (period) {
    const periods = period === "months" ? 12 : 52;
    const n = Math.min(table[level], periods);
    const base = Math.min(table.baseline, periods);
    const named = periodsOf(f, must, period);
    return {
      whole: false,
      hours: (p.hours * n) / base,
      extent: `${n === periods ? `all ${periods}` : n} ${period} (${level}, ${tableName}, capped at the ${periods} ${period} in the year)${named.length ? `, including ${named.join(", ")}` : ""}`,
    };
  }
  if (fixedExtent) return { whole: false, hours: p.hours, extent: `${fixedExtent} (programme extent)` };
  if (p.mustTestAll) {
    const n = table[level];
    return {
      whole: false,
      hours: (p.hours * (n + must.length)) / table.baseline,
      extent: `sample of ${n} (${level}, ${tableName})${must.length ? ` plus ${must.length} must-test: ${must.join(", ")}` : ""}`,
    };
  }
  const n = Math.max(table[level], must.length);
  return {
    whole: false,
    hours: (p.hours * n) / table.baseline,
    extent: `${n} items (${level}, ${tableName})${must.length ? `, including ${must.join(", ")}` : ""}`,
  };
}

export function selectProcedures(
  prog: Programme,
  risks: AreaRisk[],
  signals: Signal[],
  fb: Feedback,
  ctx: ApplicabilityContext,
): PlannedLine[] {
  const out: PlannedLine[] = [];
  for (const p of prog.procedures) {
    const { own, also: alsoRisk } = governingRisk(p, risks);
    const risk = alsoRisk ?? own;
    const appl = APPLICABILITY[p.id](ctx);
    const base = { procedureId: p.id, area: p.area, level: p.level };

    // 1. does it apply?
    if (!appl.applies) {
      out.push({
        ...base,
        status: "notApplicable",
        selected: false,
        reason: `Does not apply: ${appl.because}. Programme: "${p.applicability}"`,
        evidenceIds: appl.evidenceIds,
        extent: null,
        hours: 0,
        unknown: appl.unknown,
      });
      continue;
    }

    // 2. is it selected? mandatory and baseline always; a sufficient condition always; otherwise the level and an assertion at risk
    const { must, mustFrom } = mustTestFor(signals, p.id);
    const atRisk = p.assertions.filter((a) => risk.assertions.includes(a));
    const always = p.level === "mandatory" || p.level === "baseline" || appl.selects === true;
    const levelOk = always || LEVEL_RANK[risk.level] >= LEVEL_RANK[p.level];
    const coversRisk = always || atRisk.length > 0;
    if (!levelOk || !coversRisk) {
      out.push({
        ...base,
        status: "omitted",
        selected: false,
        reason: omissionReason(p, risk, levelOk, must, mustFrom),
        evidenceIds: [
          ...new Set(risk.sources.filter((s) => s.severity !== "info").flatMap((s) => s.evidenceIds)),
        ].slice(0, 6),
        extent: null,
        hours: 0,
      });
      continue;
    }

    // 3. how much? the level for the assertions at risk, unless last year capped it or nothing here is at risk
    const cap = fb.caps.find((c) => c.procedureId === p.id);
    const areaLevel: RiskLevel =
      risk.liftedAssertions && !p.assertions.some((a) => risk.liftedAssertions!.includes(a))
        ? risk.otherAssertionsLevel!
        : risk.level;
    const effective: RiskLevel =
      cap || risk.level === "notApplicable" || (!atRisk.length && !must.length) ? "baseline" : areaLevel;
    let { extent, hours, whole } = extentOf(p, prog, ctx.f, effective, must);
    // the programme's own alternative when the year-end count is already past (planning dated after the year end)
    const alt = /Where the count has taken place without the auditor, (.+?)\./.exec(p.description);
    const past = countIsPast(ctx.f);
    if (alt && past)
      extent = `the year-end count took place without us (planning is dated ${past.date}, after the year end ${yearEnd(ctx.f)}${past.evidence.length ? `; ${past.evidence.join(", ")}` : ""}), so per the programme: ${alt[1]}`;
    hours = roundHalf(hours);

    // 4. why, in the order a reviewer asks
    const reasonBits = [
      p.level === "mandatory"
        ? `mandatory: runs on every engagement where it applies`
        : `${p.area} is assessed ${risk.level}`,
      alsoRisk
        ? whole
          ? `also responds to ${alsoRisk.area} (${alsoRisk.level}); a whole-population test, so that level does not change the extent`
          : `extent set by ${alsoRisk.area} (${alsoRisk.level}), which this procedure also responds to`
        : "",
      atRisk.length ? `responds to ${atRisk.join(", ")} at risk` : "",
      p.level !== "mandatory" && p.level !== "baseline" ? `programme level ${p.level}` : "",
      appl.because !== "applies to all engagements" ? `applies because ${appl.because}` : "",
      mustFrom.length ? `must cover: ${mustFrom.map((s) => s.summary.split(":")[0]).join("; ")}` : "",
      cap ? cap.reason : "",
    ].filter(Boolean);
    const sentence = (b: string) =>
      (AREAS as readonly string[]).includes(b.split(" ")[0]) ? b : b[0].toUpperCase() + b.slice(1);
    out.push({
      ...base,
      ...(alsoRisk ? { extentArea: alsoRisk.area } : {}),
      status: "selected",
      selected: true,
      reason: reasonBits.map(sentence).join(". ") + ".",
      evidenceIds: [
        ...new Set([
          ...appl.evidenceIds,
          ...must.filter((m) => !m.startsWith("week ")),
          ...(cap?.evidenceIds ?? []),
          ...mustFrom.flatMap((s) => s.evidenceIds.slice(0, 2)),
        ]),
      ],
      extent,
      hours,
    });
  }
  return out;
}

export interface Budget {
  totalHours: number;
  budgetHours: number;
  gapHours: number;
  mandatoryHours: number;
  deferrable: { procedureId: string; hours: number; consequence: string }[];
}

export function budgetCheck(lines: PlannedLine[], risks: AreaRisk[], prog: Programme, budgetHours: number): Budget {
  const sel = lines.filter((l) => l.selected);
  const total = roundHalf(sel.reduce((s, l) => s + l.hours, 0));
  const mand = roundHalf(
    sel
      .filter((l) => prog.procedures.find((p) => p.id === l.procedureId)!.level === "mandatory")
      .reduce((s, l) => s + l.hours, 0),
  );
  const deferrable = sel
    .map((l) => ({
      l,
      p: prog.procedures.find((p) => p.id === l.procedureId)!,
      r: risks.find((r) => r.area === (l.extentArea ?? l.area))!,
    }))
    .filter((x) => x.p.level !== "mandatory")
    .sort(
      (a, b) => LEVEL_RANK[a.r.level] - LEVEL_RANK[b.r.level] || b.l.hours - a.l.hours || a.p.id.localeCompare(b.p.id),
    )
    .map((x) => ({
      procedureId: x.p.id,
      hours: x.l.hours,
      consequence: `${x.r.area} (${x.r.level}) loses its ${x.p.assertions.join("/")} procedure "${x.p.title}"`,
    }));
  return { totalHours: total, budgetHours, gapHours: roundHalf(total - budgetHours), mandatoryHours: mand, deferrable };
}

export type { ProgrammeProcedure };
