# Statement Pipeline — Personal Finance OS, Phase 1

## Problem
I get 4–6 bank and credit card statements a month from Indian banks, as password-protected PDFs, each laid out differently. Turning them into an answer to "where did my money go" takes 5–6 hours of manual unlocking and ad-hoc AI questioning. The answers have no structure and no history, and I can't tell whether the numbers are right. Without a record I trust, I can't see month-to-month trends, spot avoidable spending, or decide whether I can invest more.

## Evidence
- Volume: 4–6 statements a month (at most 6), all available as PDF, from five sources:
  - SBI Card Aurum (credit card)
  - HDFC Tata Neu credit card
  - Axis Bank account
  - SBI bank account
  - Canara Bank loan account, which also carries a few UPI payments
- History: statements available from January 2026.
- Time: 5–6 hours a month, repeating the same manual steps each time.
- Current routine: open each PDF, unlock it on a third-party website (which receives the file and its password), save an unlocked copy, load it into Claude Code and ask questions.
- Outcome of the current routine: no structure, no trends across months, and no way to tell whether a monthly figure was made up.
- Needs the current routine can't serve:
  - a quarterly school fee for my daughter should show as a monthly cost;
  - a trip has a budget spread over 12 months, but its spending lands over 2–3 months (bookings first, then the trip itself).
- Assumption — how accurately transactions can be categorised from Indian bank narrations (especially UPI) needs validation via the first month of real statements.

## Users
- **Primary**: me, managing my household's finances across two bank accounts (Axis Bank, SBI), a loan account (Canara Bank) and two credit cards (SBI Card Aurum, HDFC Tata Neu), with statements arriving monthly. The need comes up every month when statements arrive, and whenever I want to know if I can invest more or cut spending.
- **Not for**: other people, families sharing one setup, businesses, or accounts outside India. Multi-user use may come later; it shapes nothing in this phase.

## Definitions
- **Income**: money received from outside my own accounts, such as salary and interest. Refunds reduce the expense they reverse rather than counting as income.
- **Expenses**: money spent, wherever it is paid from (bank account or card). Loan EMIs count in full as expenses.
- **Savings** = Income − Expenses.
- **Investments**: the part of savings put to work — SIPs, brokerage transfers, PPF, fixed deposits.
- **Own-account transfers** (card bill payments, moving money between my accounts) are neither income nor expenses.
- **Spread cost**: an expense counted evenly across the months it covers, alongside the month it was actually paid.

## Hypothesis
We believe **a repeatable pipeline that turns my monthly bank and card statements into one checked, categorised, queryable record of transactions — with own-account transfers excluded and uneven costs spread across months —** will **replace my 5–6 hour manual routine with numbers I trust and can compare month to month** for **me**.
We'll know we're right when **two consecutive months each take ≤15 minutes of my time, every statement matches its own printed totals (or the gap is flagged), and I can query income, expenses, savings and investments for every month since January 2026**.

## Success Metrics
| Metric | Target | How measured |
|---|---|---|
| My time per month | ≤15 min (from 5–6 h) | Self-timed over two consecutive months |
| Statements that match their printed totals | 100% across all five sources, or flagged with the gap shown | Per-statement check after each import |
| Repeatability | Same statement gives identical transactions every run; re-importing never duplicates | Re-import an already-loaded month and compare |
| Own-account transfers counted as spending | 0 | Review of card bill payments and self-transfers in the first two months |
| Categorised correctly without my correction | TBD — needs validation via first month of real statements (proposed ≥90% from the second month) | Count of my corrections per month |
| History available for trends | Every month from January 2026 | Months present in the record |

## Scope
**MVP** — the data pipeline. Dashboards and analysis are built on top of the record afterwards with ordinary AI-tool capabilities, so the record itself is the product.
- I put PDF statements, password-protected or not, into a folder. All five sources must read correctly: SBI Card Aurum, HDFC Tata Neu credit card, Axis Bank, SBI, and the Canara Bank loan account.
- Each statement unlocks with a password I set once per bank or card. The third-party unlock website is no longer needed.
- Every transaction is extracted and checked against the statement's printed totals. A mismatch is flagged, never guessed at.
- The same statement always gives the same result, and importing it again creates no duplicates.
- Transactions are categorised. When I correct one, similar future transactions follow the correction.
- Transfers between my own accounts are recognised and kept out of income and expenses.
- Each month shows income, expenses by category, savings and investments, per the definitions above.
- Spreading:
  - periodic costs (for example the quarterly school fee) are spread across the months they cover;
  - spending can be grouped under a goal with its own budget (for example a trip budgeted over 12 months), showing budget against actual spend across the months it happened.
- The result is a structured record I can query directly and build dashboards on.
- It runs inside Claude Code on my own machine, with no hosted server.
- Statements from January 2026 onward load the same way, so trends exist from the start.

**Out of scope**
- Dashboards, charts or any UI — I'll build these on top of the record myself.
- Fetching statements from Gmail — milestone 2; dropping files in by hand is enough to test the hypothesis.
- Excel statements and banks beyond the five above — every current source offers PDF; new sources can be added later.
- Other users, a hosted server or a web app — single user, runs locally.
- Bank APIs and the Account Aggregator framework — statements are the only source.
- Working out statement passwords automatically — I set each one once.
- Tracking investment holdings (mutual fund or stock portfolios) — only the money moved into investments counts.
- Tax, bill payment, moving money, and accounts outside India.

## Delivery Milestones
<!-- Business outcomes, not engineering tasks. /plan turns each into a plan. -->
<!-- Status: pending | in-progress | complete -->

| # | Milestone | Outcome | Status | Plan |
|---|---|---|---|---|
| 1 | Trusted monthly record | My statements become a checked, categorised, queryable record with transfers excluded and costs spread, covering January 2026 onward | in-progress | `.claude/plans/statement-pipeline.plan.md` |
| 2 | Statements from Gmail | Each month's statements are collected from my inbox instead of downloaded by hand | pending | — |
| 3 | Any AI tool | The same workflow runs in Claude Cowork, Codex and OpenCode, not only Claude Code | pending | — |
| 4 | Insights | I see where I overspend, which costs are avoidable, and how much more I could invest | pending | — |

## Open Questions
- [x] Which banks and cards, and in which format? Answered: SBI Card Aurum, HDFC Tata Neu credit card, Axis Bank, SBI and Canara Bank (loan account), all as PDF.
- [x] How many months of past statements can be loaded? Answered: everything from January 2026.
- [x] Loan repayments (Canara): does the full EMI count as an expense, or only the interest? Answered: the full EMI is an expense.
- [ ] Which category list to start from, and how fine-grained? TBD — needs validation via the first month of real statements.
- [ ] Are spreading rules and goal budgets set up by me once, or suggested from my history?
- [ ] Where do statements and the record live (my machine, S3 or Google Drive)? Cloud AI sessions start empty each time, so the record must live outside them if I use one. To be decided in `/plan`.
- [ ] Gmail (milestone 2) outside Claude Code.
  - Tested 2026-10-18: in Claude Code, Claude's built-in Gmail connector returned an HDFC card statement email in full through its raw-message option, and the password-protected PDF inside came out intact.
  - Anthropic's help page says Gmail attachments are "metadata only", so this behaviour is undocumented and could change.
  - Still open: whether Cowork can do the same, and whether Codex and OpenCode need my own Google sign-in for the Gmail API. TBD — needs validation via the same test in each tool.
- [ ] Insights (milestone 4): judged against budgets I set, or against patterns in my own history?

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A bank changes its statement layout | High over time | Medium — missing or wrong transactions | The printed-totals check fails loudly instead of passing bad data |
| Extraction errors that look plausible (today's "is this made up?" problem) | Medium | High — destroys trust in every figure | Numbers come only from the statement, every statement is checked against its totals, and runs are repeatable |
| Card bill payments and self-transfers double-counted as spending | High | High — expenses inflated | Own-account transfers are recognised explicitly; tracked as a success metric |
| Statement passwords or files leak (into git, a shared folder or a third-party site) | Medium | High — account details exposed | Passwords and statements never enter the repo; the unlock website step is removed; storage decided in `/plan` |
| UPI narrations too cryptic to categorise well | Medium | Medium — many manual corrections | Corrections carry forward to similar transactions; accuracy measured from month one |
| Record lost between cloud AI sessions | Medium | Medium — re-import needed | Record stored outside the session; decided in `/plan` |
| Gmail fetching relies on undocumented connector behaviour (raw-message download) | Medium | Low for MVP — falls back to downloading by hand | Deferred to milestone 2; my own Gmail API access is the fallback |

---
*Status: DRAFT — requirements only. Implementation planning pending via /plan.*
