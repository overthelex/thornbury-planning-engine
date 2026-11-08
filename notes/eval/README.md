# Evaluation artefacts

Model-generated, not human-labelled: each file comes from a separate agent that saw only BRIEF.md and the client's own
data, never `src/`, `plans/`, `data/derived/` or another reviewer's output. Treat them as an independent second opinion, not as ground truth.

| File | What it is |
|---|---|
| `review_<client>.json` | blind risk assessment per client (14 area levels, procedures, findings) |
| `review2_wetherby.json` | a second, independent blind assessment of Wetherby, to measure reviewer-to-reviewer agreement |
| `notes_gold.json` | blind paragraph-level labels of all 51 planning-note paragraphs: (area, direction, assertions, confidence) |
| `extracted.json` | the engine's notes claims as (paragraph, area, direction): merged 2-of-3, and each run, after quote validation |

Reproduce (from `starter-ts/`):

```bash
python3 -I ../notes/eval/score_notes.py ../notes/eval                 # extraction precision / recall against notes_gold
for c in ashworth calder wetherby; do python3 -I ../notes/eval/compare_levels.py $c ../notes/eval; done
python3 -I ../notes/eval/compare_reviewers.py ../notes/eval plans/wetherby/plan.json
```

Results at commit time:

- Notes, "raises" claims: merged precision 0.89, recall 0.81 (best single run 0.85 / 0.81). "Lowers": precision 0.80, recall 0.33; the extractor under-reports mitigating evidence, which errs towards more work, not less.
- Area levels, engine against reviewer: Ashworth 12/14, Calder 12/14, Wetherby 9/14 (24/42 before the fixes, 29/42 after them, 33/42 once R6 stopped counting paragraphs).
- Wetherby, two reviewers against each other: 11/14; engine against them 9 and 10. Where both agree and the engine differs: payroll, fixedAssets, vat (revenue closed by the revenue side of R7; purchasesCreditors and completion by R6 accepting one paragraph; payroll opened by it, N6).
