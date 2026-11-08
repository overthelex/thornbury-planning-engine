# Thornbury Audit: a risk engine for audit planning

## Context

Thornbury Audit LLP is a twelve-partner audit firm in Leeds. Before fieldwork on any audit, the team assesses where the accounts could be materially wrong, area by area, and picks the procedures from the firm's programme that respond to that risk. Today the assessment lives in a senior's head and a Word document, the programme is a checklist the team ticks from habit, and the partner reviews it in an hour the night before. The firm wants software that reads the planning file and proposes the plan. You are building the first version.

Three clients are in planning right now. Their plans go to the partner in three weeks.

## What you get

- `starter-ts/`: a TypeScript project with typed loaders for every file in `data/`, a `summary` command, and no engine. Run `npm install`, `npm run cli -- summary`, `npm test`.
- `data/programme/audit_programme.md`: the firm's audit programme, exported from Word. Forty procedures across fourteen areas, each with the assertions it covers, the risk level it responds to, hours at baseline extent, and when it applies. It exists only in this form.
- `data/clients/<client>/`, one folder per client:
  - `company.json`: who the client is, who can post and approve, the client's controls, and the engagement facts: materiality, fieldwork budget, whether this is a first-year audit.
  - `planning_notes.md`: the senior's notes from the planning meeting and the engagement file, as written, with numbered paragraphs.
  - `prior_year_findings.jsonl`: what the team raised last year and how each item was resolved.
  - `prior_year_plan.jsonl` (continuing clients only): last year's programme as executed: what was selected, hours budgeted and spent, and which findings each procedure raised.
  - `trial_balance.csv`: prior-year comparatives, opening and closing balances.
  - `ledger.jsonl`: the full general ledger for the year, every journal. It arrives before planning, as it always does now. Amounts are pence, debit positive.
  - `accounts.csv`, `tax_codes.csv`, `parties.csv`: chart of accounts, VAT codes, every customer, supplier and employee with related-party flags and leaver dates.
  - two bank statements, from the bank: the year and the quarter after.
- This brief.

## The clients, in one line each

- **Ashworth Electrical Ltd**: electrical contractor, revenue about 5 million, owner-managed, fourth year as our client. Budget 120 hours.
- **Calder Valley Brewing Co Ltd**: brewery with a taproom, revenue about 2 million, bank loan, first ever audit. Budget 150 hours.
- **Wetherby Dental Practice Ltd**: two-surgery dental practice, revenue about 1.7 million, sixth year as our client. Budget 60 hours.

Everything else is in the notes.

**This is not an estimating exercise.** The programme already gives every procedure its hours at baseline extent, and a plan's hours follow from which procedures it selects and how far it extends them. The work is deciding which procedures run for each client, how much of each, and why, and then saying why the rest do not. The budget is a constraint to report against, not the thing to predict.

## The memo from Ingrid, engagement partner on all three

Here is what I need from the engine before I will sign a plan it wrote.

1. **Assess the risk per audit area**, with the assertions at risk, and say why. Every reason must point at something in the file: a paragraph of the notes, a prior-year finding, a balance, a transaction. If it cannot point, it does not count.
2. **Select the procedures** from our programme that respond to that risk, and set their extent. Each client has a budget. If the risk needs more than the budget, I want to know that, not a plan that fits by cutting the wrong thing.
3. **Explain every omission** as carefully as every selection. When the regulator asks why we did not do a procedure, "the engine did not pick it" is not an answer.
4. **Do not audit what does not need auditing.** Last year at Ashworth we spent thirty hours on vans because the number was big. Risk is not the same as size.
5. **Reproducibility.** The same file must produce the same plan and the same reasons in 2028.
6. **Use the ledger.** It is on the server before we plan. I want the plan to reflect what is actually in it, not just the trial balance and what the client tells us.
7. **The notes carry the judgment.** Eleven years of what I would look at is in there, in prose. Use it.
8. **Learn from what happened.** After fieldwork every finding is marked misstatement, explained, or not an exception, and every procedure either found something or did not. Last year's plans and findings are in the file. Next year's plan should be better for it.
9. **It has to work on the next client.** I will judge it on whichever of the three you spent least time on.
10. This list is incomplete. **If something important is missing, propose it**, and build it if you judge it worth the time over the items above.

## Your job

1. **Design doc, max 500 words. One diagram is allowed on top and does not count.** Cover: what you built and what you deferred, with reasons for both; where a language model belongs in this engine and where it does not, and how you know its output is right; your assumptions; the questions you would put to Ingrid before the plans go to her.
2. **Build an MVP of the engine that covers some of the memo** as `npm run cli -- plan <client|all>`, which writes `plans/<client>/plan.json`, an `AuditPlan` from `src/types.ts`, and `plans/<client>/PLAN.md`, the same plan in the form Ingrid will read. Add fields to the JSON if you need them. Include the output of a run for all three clients.
3. **Have something to show.** The conversation opens with you showing the result, as you would to Ingrid. Run it, open one client's plan, and walk us from one risk level to the evidence behind it and the procedures it selected. PLAN.md is enough; a page or view is fine if it helps. Whatever you show must come from the engine running on the file, not be written by hand. We judge the reasoning it shows, not how polished it looks.
4. **Add the tests your change makes necessary**, no more.

## Ground rules

- Read the data and the memo before you start the clock. The build is time-boxed to roughly **3 to 4 hours**. The task is deliberately larger than that; completeness earns nothing.
- Some memo items are better answered in the doc than in code. Deciding which is which is part of the task.
- Use any tools you like, including AI agents and any model provider, on your own key. Your engine may call a model when it runs. **Memo 5 applies to your submission too:** we review it later, without your key. If your plans depend on model output, commit that output with the model and prompt that produced it, so that we can trace every line of a plan back to what the model said, and so that `plan` reproduces your committed plans from it. Say in the doc how.
- We grade decisions, not volume. We will read one code path deeply; we choose which one.
- Afterwards: a **45-minute conversation** about what you built and why.

## Glossary, for anyone who has not sat in an audit

- **Assertion**: the specific claim about a balance or transaction that could be wrong. The firm uses nine: *existence* (it is real), *occurrence* (it happened), *completeness* (nothing is missing), *accuracy* (the amount is right), *cutOff* (it is in the right period), *valuation* (it is worth what it says), *rightsAndObligations* (the company owns or owes it), *classification* (it is in the right account), *presentation* (it is disclosed correctly).
- **Area**: a slice of the accounts the programme is organised by. The fourteen are listed in `src/types.ts` and in the programme.
- **Risk level**: the firm uses *baseline*, *elevated*, *significant*, and *notApplicable*. A significant risk is one the partner must specifically respond to and document.
- **Mandatory procedure**: runs on every engagement where it applies, whatever the risk level, because a standard requires it. The budget does not change that.
- **Extent**: how much of a procedure to do: a sample size, a set of months, "every leaver". Scalable procedures carry the firm's sample table in their text where one exists; otherwise the extent is yours to set and justify.
- **Materiality**: the size above which a misstatement would change a reader's view of the accounts. Performance materiality is the working threshold the team plans to. Clearly trivial items are not accumulated. None of these is a ceiling on risk: a small item can carry a large risk.

## Submitting

Send back `starter-ts/` without `node_modules`, with `DESIGN.md` in its root and `plans/` filled in for all three clients.
