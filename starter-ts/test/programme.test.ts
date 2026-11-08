import { describe, expect, it } from "vitest";
import { parseProgramme } from "../src/programme";
import { APPLICABILITY } from "../src/applicability";

describe("programme parser", () => {
  const p = parseProgramme();
  it("reads forty procedures across fourteen areas", () => {
    expect(p.procedures).toHaveLength(40);
    expect(new Set(p.procedures.map((x) => x.area)).size).toBe(14);
  });
  it("reads the general sample table and each procedure's own table where it quotes one", () => {
    expect(p.generalSampleTable).toEqual({ baseline: 15, elevated: 25, significant: 40 });
    expect(p.procedures.find((x) => x.id === "REV-02")!.ownSampleTable).toEqual({
      baseline: 10,
      elevated: 20,
      significant: 40,
    });
    const jnl = p.procedures.find((x) => x.id === "JNL-01")!;
    expect(jnl.ownSampleTable).toEqual({ baseline: 15, elevated: 30, significant: 50 });
    expect(jnl.mustTestAll).toBe(true);
    expect(jnl.level).toBe("mandatory");
  });
  it("has an applicability rule for every procedure, and none for procedures that do not exist", () => {
    const ids = p.procedures.map((x) => x.id).sort();
    expect(Object.keys(APPLICABILITY).sort()).toEqual(ids);
  });
});
