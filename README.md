# Benford take-home: Thornbury planning engine

- `starter-ts/` holds the starter pack as received from Benford (first commit is unchanged), and becomes the submission (`DESIGN.md` + `plans/`).
- `notes/` holds working notes, not part of the submission:
  - `ARCHITECTURE.md`: engine design;
  - `PLAN-4H.md`: time-boxed build plan;
  - `DATA-REVIEW.md`: what the data contains (acceptance check);
  - `eval/`: blind reviewers and notes labels (model-made, not ground truth), with the scripts that score the engine against them.
- `ARCHITECTURE.md` and `PLAN-4H.md` predate the build; `DESIGN.md`, the code and `npm test` are authoritative.
- Tests (`starter-ts/test/`): `invariants` (contracts any file must meet), `golden` (the conclusions a reviewer checks first), `mutations` (metamorphic relations), `regressions` (one per blind-review finding).
