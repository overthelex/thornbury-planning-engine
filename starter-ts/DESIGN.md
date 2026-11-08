# Design

```
 ledger, bank, TB ──► detectors (code) ──► signals ──┐
 planning notes ───► committed LLM extraction ───────┼─► risk rules R1–R8 ─► selection + extent ─► budget check ─► plan.json + PLAN.md
 prior-year plan ──► feedback (caps, missed cover) ──┘          ▲                    ▲
 audit programme ──► parser ─────────────────────────────────────┴────────────────────┘
                     every cited id ─► evidence index (the build fails if one does not resolve)
```

**Built.** Every level, selection, extent and omission cites file ids an index resolves (memo 1, 3).

- **Detectors.** Eight client-agnostic detectors read ledger and bank, not only the TB (memo 6).
- **Risk rules** (`risk.ts`, ruleset `2026.11-2`): R1 highest source sets the level; R2 two source kinds, exposure ≥ performance materiality → significant; R3 recurring error +1; R4 ISA 240 presumption; R5 scope on facts only; R6 one notes paragraph → elevated, never significant; R7 unbooked needed estimate → significant (revenue too, for accuracy, if income-reducing); R8 covenants plus misstated inputs or liquidity stress → significant.
- **Selection.** One applicability rule per procedure; extent from the programme's tables.
- **Risk is not size.** Balances never count as exposure (memo 4).
- **Budget.** Never cut; the gap and a lowest-risk-first deferral list are reported (memo 2).
- **Prior year.** Last year's overrun caps FA-01; missed coverage becomes a source (memo 8).

**Where the model is.** Only reading the notes into claims, each with a paragraph id and verbatim quote (Opus 5.5 twice, Sonnet 5.5 once). A claim survives only if its quote is in the paragraph, any amount is in the quote, and two runs agree. The quote proves provenance, not the reading: claims are hypotheses for fieldwork. Raw output, prompt and notes hash are committed; `plan` never calls a model and refuses changed notes: plans reproduce offline (memo 5).

**Where it is not.** Arithmetic (code computes the £81,600 clawback from N4), levels, selection, journal testing: published results show models weak at multi-step numbers.

**Deferred.**
- **Risk per (area, assertion), as ISA 315 assesses it.** A rewrite.
- **Rule firings as data** (premises → conclusion); reasons are prose today.
- **ML ranking of JNL-01 picks.** Too few entries to learn from.
- **Benford tests.** Too few manual entries.
- **Recurring-invoice gaps** (Wetherby S016).
- **Procedure yield across years.** One year only.

**Assumptions.** Hours scale linearly with sample size. A procedure's Level is a floor unless its applicability names a sufficient condition. Unposted accrual and provision accounts mean no estimate was made. Notes record judgment, not evidence.

**Calibration.** Rules were tuned on all three clients, none held out. No correct plan exists, so tests state metamorphic relations (change one fact, predict what moves; arXiv 2205.04998); they found three defects. Blind agent reviewers (`notes/eval/`) prompted VAT-return, s.207 and takings-gap rules. Against their own ceiling: on Wetherby they agree 11/14 with each other, 9–10 with the engine. Notes claims vs blind model labels: precision 0.89, recall 0.81 (consistency, not correctness).

**Questions for Ingrid.**
1. Plans exceed budget (207.5/120h, 216.5/150h, 114/60h): how does the partner approve an overrun?
2. Should significant risks be recorded per area or per assertion?
3. When applicability names a condition (GC-02 covenants, PUR-03 reliance), does the procedure run at any level?
4. Wetherby: can we rely on last year's BACS release test (FY24-W03)?
5. What levels did these clients get last year? (To calibrate R2, R6.)
6. Wetherby: no receipts after the year end. Is the file complete?
