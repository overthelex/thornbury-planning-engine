# Thornbury planning engine starter

```
npm install
npm run cli -- summary           # every client's planning file in numbers
npm run cli -- summary calder    # one client
npm run cli -- plan <client|all> # yours to write: writes plans/<client>/plan.json and PLAN.md
npm test
```

`src/types.ts` describes every file in `data/` and the `AuditPlan` shape the firm expects back. `src/load.ts` reads them; the programme and the planning notes are prose, and the loaders hand them to you as text plus the numbered paragraphs. Read `BRIEF.md` first.
