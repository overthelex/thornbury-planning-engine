# Data review (pre-clock reading)

Found with throwaway Python over `data/`. The engine must find all of these on its own; this list is the acceptance check, not an input.

## Programme
- 40 procedures in 14 areas.
- **Sample tables:** the general table is 15/25/40, but REV-02 quotes 10/20/40 and JNL-01 quotes 15/30/50 plus all must-test items.
- FA-01 forbids extending to the whole register without a documented reason.

## Starter code
- `Journal` type lacks `"cash"` (used by Calder and Wetherby takings).
- `.gitignore` ignores `plans/`, but the submission requires them.

## Ashworth (120h, continuing, sale in 2026 at an EBITDA multiple: N2)
- **Brightwater revenue (MJ-000024):** £187.5k manual revenue by tom.finance, keyed 2026-02-11 with posting date 2025-12-30. No approver, and no receipt in Q1 2026. Links to N5 and FY24-08.
- **Leaver paid:** Callum Reed (E019) left 2025-06-30 but received bank payroll Jul–Dec 2025 (6 × £2,331). The ledger payroll carries no party, so this shows only in the bank statement. Recurrence of FY24-14; PAY-02 was not selected last year.
- **Wharfedale Site Services (S033):** new in July, no contract (N11), 9/9 invoices at £9.6k–£9.98k, just under the £10k MD-approval limit, all approved by tom.finance. Accrual MJ-000017 of £12,000 was reversed by MJ-000018 at £10,200.
- **Director advance (MJ-000016):** £35k, posted by martin.md, no approval, outstanding at YE in 1150. Above the s.197 threshold; recurrence of FY24-03.
- **"Transfer" (MJ-000019):** £9.5k, martin.md, 20:05, to advertising, T9. No bank statement line. Statement closing 1,041,135.09 vs TB 1,031,635.09: the difference is exactly £9.5k.
- **Unit 4 refurbishment (PI-000769):** £24k + VAT to Ashworth Property Ltd (related party), coded to rent 7100, no board minute (N8).
- **Loan to J Price (MJ-000020):** £2.5k loan to an employee, coded to subcontractors 5100.
- **PI-000776 unbalanced:** missing the input VAT line of £624, which explains the 2201 TB-vs-ledger difference of 62,400p.
- **Client dinner (PI-000770):** Hendersons Brasserie coded to 7500 with VAT T1. Recurrence of FY24-06.
- **MISC-OPS:** still used, 65 lines, £31.6k (FY24-09 said retire; N16).
- **Trade debtors:** £158k → £671k.
- **Fixed assets:** FY24 FA-01 took 30h with 0 misstatements, so the extent should be capped (memo 4).

## Calder (150h, first year, loan with covenants)
- **Loan interest:** each repayment posts £8,333.33 capital + £3,000 to 7900 bank charges. 7903 interest = 0 in FY25 (34,500 in FY24). This affects the covenant computation (N5).
- **Overdraft:** overdrawn on the statement in late May–early June and mid-September, and at YE (−£1,308.93). The bank letter (N17) says 4 days in September.
- **Kitchen (PI-000494):** Hebden Kitchen Studio, "Kitchen supply and fit - 14 Birchcliffe Road", £8.4k + VAT reclaimed, coded to 7700 and approved by dan.md. This is the N11 personal expenditure; the DLA (2310) is nil.
- **Stock adjustment (MJ-000016):** round £56k "per count sheets", posted by kate.office and approved by dan.md. The count story is contradictory (N8), the WIP valuation is a rule of thumb, and the opening stock is "Dan's figure" (N16, PY-HILL-01).
- **Taproom takings:** no entry for weeks 19, 20 and 33, although it was open every week except Christmas (N9).
- **Self-approval:** kate.office self-approves 384 purchase invoices and 3 VAT journals.
- **Accruals:** unchanged at £6.2k, so YE journals are apparently not yet posted.
- **Related party:** Rosie Crossley (E002) is on the payroll (N10).
- **Opening balances:** unaudited (OB-01 is mandatory).

## Wetherby (60h, continuing, "nothing changes")
- **NHS clawback:** UDA delivery about 92% of a £1.02M contract (N4), so the clawback is about £81.6k for the contract year, roughly £61k attributable to FY25. Provisions (2260) = 0 vs materiality £24k. FY24 was 99% (N13, FY24-W02).
- **Depreciation:** flat at 2,640,000 (= PY) despite the £45.6k chair addition (PI-000373). Several P&L lines equal PY exactly, and accruals are unchanged.
- **Self-approval:** sue.pm posts and approves 353 purchase invoices (FY24-W03 compensating control).
- **Refund (MJ-000013):** £1.9k patient refund posted by raj.md, no approver. Trivial.
- **VAT:** not VAT-registered, so VAT-01 and VAT-02 do not apply. Yet the Q1 2026 statement has an "HMRC VAT Q4 2025" £0 line, which is a question.
- **Q1 2026 statement:** no receipts at all and ends on 2026-02-09, which is a question.
- **Private takings:** week 52 missing (Christmas closure?).
