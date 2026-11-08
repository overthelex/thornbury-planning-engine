# 4-hour build plan

The clock starts after reading (done: see `notes/DATA-REVIEW.md`). The work is ordered so that a plan exists end to end by 2:30. Everything after that deepens it.

> **Written before the build (5 November).** Kept as a record of the plan. Where it differs from the code, `starter-ts/DESIGN.md` and the code are authoritative: rules, thresholds and numbers have moved since.

| Time | Block | Output | Done when |
|---|---|---|---|
| 0:00–0:15 | Setup | `npm install`, `summary` and `npm test` green; add `"cash"` to `Journal`; remove `plans/` from `.gitignore` | tests pass |
| 0:15–0:45 | Programme parser + applicability predicates | `src/programme.ts`, `src/applicability.ts` | test: 40 procedures / 14 areas; every procedure has a predicate; REV-02/JNL-01 own tables |
| 0:45–1:00 | Evidence index | `src/evidence.ts` | unresolved id throws |
| 1:00–1:50 | Detectors, core 5 | journal profile, bank↔ledger + leaver, approval limits, related parties, TB analytics | one unit test each on a tiny fixture |
| 1:50–2:30 | Risk rules + selector + extent + omissions + budget gap | `src/risk.ts`, `src/select.ts`, `src/budget.ts`, `plan` command writing JSON | `plan all` runs, JSON validates against `AuditPlan` |
| 2:30–2:55 | Notes extraction | prompt, offline run for 3 clients, committed JSON + validator + hash check | validator test; plan cites N# |
| 2:55–3:15 | Prior-year feedback | yield, missed coverage, recurrence | FA-01 capped at Ashworth; PAY-02/RP-03 considered |
| 3:15–3:35 | PLAN.md renderer | area → level → reasons → evidence → procedures; omissions; budget | read Wetherby's plan end to end (least-tuned client, memo 9) |
| 3:35–3:45 | Golden + integrity tests | determinism test, every evidenceId resolves | `npm test` green |
| 3:45–4:05 | DESIGN.md | ≤500 words + 1 diagram, from `notes/ARCHITECTURE.md` | word count checked |

## Cut lines if behind
1. Skip detectors beyond the core five: takings gaps, classification and estimates-not-booked go to "limitations" in the plan.
2. If the LLM extraction slips, use a fallback: a deterministic keyword→area map over notes. It is marked as such in the doc and has lower recall, which is stated.
3. Feedback: keep only missed coverage + the FA-01 cap; recurrence goes to the doc.
4. Never cut: evidence integrity, omissions with reasons, budget gap reporting, determinism.
