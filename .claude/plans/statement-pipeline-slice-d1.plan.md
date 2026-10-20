# Plan: Slice D, part 1 — Monthly views

**Parent plan**: `.claude/plans/statement-pipeline.plan.md`, Slice D, Task 13
**Source PRD**: `.claude/prds/statement-pipeline.prd.md`, milestone 1, "Definitions"
**Complexity**: Medium. One migration of SQL views, one new module, two CLI commands, one read-only database call, tests. **No Claude call, so no AI cost.**
**Branch**: `claude/sleepy-newton-amzv4r`, cut from `main` at `9313c1d` (pull request 5).

## Status: done (2026-10-20), with these changes after approval
The three reviews changed parts of the design below. Where they differ, this section wins.

| Change | Why |
|---|---|
| **Migration `0006_views_one_statement_per_day`** replaces the views of `0005`. `0005` stays as it is, because it is already applied on Neon. | Migrations run once each. |
| **`v_counted_transactions`**: on a day that two overlapping `ok` statements of one account cover, only the statement that starts later counts. A card row a few days outside its own period stays, unless a statement whose period overlaps its own covers that day. `transfers.load` reads this view, so the matcher, the categoriser and the figures see the same rows. | `store_statement` replaces a statement only for the same period, so two bank statements with overlapping ranges both stay. Their shared days were counted twice (database review, HIGH). |
| **Months without gaps**: from the first date in the record to the last. A month that no statement covers shows every account with 0 days. | A gap month disappeared, and a card row outside every period gave "0 of 0 accounts" (database and Python reviews, MEDIUM). |
| **`finos sql` errors**: each database error prints on one line. An error that names a password is the credential only if `select 1` fails too; otherwise the message is shown. | A cast error can quote a narration with line breaks (security review, MEDIUM). A query on a "password" column read as a credential failure (Python review, MEDIUM). |
| **`finos sql` output**: at most 20 columns; only the count when a query has no columns; a query may start with `-`; `reset all` after the query; the help text says to query the views and not to select narrations, reasons, handles or notes. | Review findings (LOW). |
| **Smaller items**: `parse_month` accepts only ASCII digits and a year of 1 or more; a link stored in both orders no longer doubles a row; the review line says "Their category stands until you decide"; `_month_lines` is split into three helpers. | Review findings (LOW). |

**Checked on Neon:** a write fails ("cannot execute CREATE TABLE in a read-only transaction"), two statements in one query fail ("cannot insert multiple commands into a prepared statement"), and the only extension is `plpgsql`, so a query has no network access.

**Real run (free):** three months (2026-08 to 2026-10), all partial. The 8 linked transfers and the "Own accounts" rows are left out. The builder's EMI payment reduces Loan EMI, and the landlord's settlement reduces Rent. Both arrived in October, so October's expenses are negative. The figures were shown in the chat on 2026-10-20 and are not in the repository.

## State at the start (2026-10-20)
- `finos check`: all parts ok, 5 PDFs in Drive.
- `finos transfers`: the same 8 pairs, 16 unpaired.
- `finos status`: 5 statements ok, 186 rows categorised, 0 to review, $2.25 of $10 spent this month.
- Statement periods: **no month is fully covered by every account yet.** The views must say so.

## Requirements restated
1. For each month: income, expenses by category, savings and investments, per the PRD definitions.
2. A row in `transfer_links` is a transfer. Its category does not count (handoff 3.2.6; known limit 22).
3. A category of the kind `transfer` ("Own accounts") is neither income nor spending.
4. An expense category on money in is a refund. It reduces that category's spending (the builder's EMI payment, the landlord's settlement).
5. "Loan EMI" counts the full EMI as spending.
6. "Investments" is neither income nor spending. It is shown separately: money in, money out and net.
7. Savings = Income − Expenses.
8. Only statements with the status `ok` count. A flagged statement is reported, not counted.
9. Each month shows how much of it each account covers, so a partial month is never read as a full one.
10. `finos month 2026-09` and `finos sql "<query>"` read the views. Neither prints a narration.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Which month a row belongs to | Its transaction date (`txn_date`), not the statement's period. | A card statement covers parts of two months. Spending belongs to the month it happened. |
| Where the arithmetic lives | In SQL views (migration `0005_views.sql`). `finos month` only reads and formats them. | One definition serves `finos month`, `finos sql` and any later dashboard (PRD: the record is the product). |
| How a row counts | `v_transactions` gives each row a `kind` (`income`, `expense`, `investment`, `transfer` or null) and a signed `value`. Income: credit +, debit −. Expense: debit +, credit − (a refund). Investment: debit + (money in), credit − (money out). Transfer and no category: no value. | `sum(value)` by kind gives each total, and refunds net out by themselves. |
| A linked transfer with an old category | `transfer_links` wins: kind `transfer`, whatever the category says. | A row keeps its old category until the next categorise run (known limit 22). |
| Rows that wait for review | They count with their current category. `finos month` shows how many there are and their amount. | Today none wait. Leaving them out would hide real spending. |
| Rows with no category | They do not count. `finos month` shows how many there are and their amount, with "Run finos categorise". | A guessed kind would make a figure up. |
| Stale transfer links | `finos month` compares the stored links with a live match, as `finos status` does, and warns when they differ. It does not write. | `finos month` stays read-only. `finos transfers` fixes the links for free. |
| Coverage | `v_month_coverage`: for each month and account in the record, the number of days that `ok` statements cover. Overlapping statements count each day once. A month is complete when every account covers every day. | With five statements, every month is partial. This makes it visible. |
| Narrations | No view has a narration column. Views carry the counterparty name, which is already cleaned (letters, digits and `. & ' , -`). | Narrations are third-party text. `finos sql` output lands in the transcript. |
| `finos sql` safety | One query in a read-only transaction: `set transaction read only`, a `select 1` that fixes the mode, a 15 s statement timeout, then the query. The query is sent as typed, with no `%s` conversion, so `like '%x%'` works. Output: at most 200 rows, each cell cleaned with `_plain` and cut to 60 characters. | A write, a DDL statement or a later `set transaction read write` fails. The cap keeps the transcript small. |
| `finos month` with no month | A table of every month: income, expenses, savings, investments and "complete" or "partial". | Month-to-month comparison is the point of the record. |
| Amount format | Indian grouping with paise, for example `1,08,000.00`. | The figures are in rupees and the user reads them in lakhs. |

## Views (`src/finos/migrations/0005_views.sql`)
- **`v_transactions`**: one row per transaction of an `ok` statement. Columns: `txn_id`, `txn_date`, `month` (first day of the month), `source`, `account_last4`, `amount`, `direction`, `counterparty`, `category`, `linked` (in `transfer_links`), `kind`, `refund` (an expense category on a credit), `value`, `needs_review`.
- **`v_monthly_by_category`**: `month`, `kind`, `category`, `position`, `rows`, `gross` (debits for expense and investment, credits for income), `offsets` (refunds, or the other direction), `net` = `sum(value)`. Kinds `income`, `expense` and `investment` only.
- **`v_monthly_summary`**: `month`, `income`, `expenses`, `savings`, `investments_in`, `investments_out`, `investments` (net), plus the counts and amounts that are left out: linked transfers, "Own accounts" out and in, rows that wait for review, rows with no category.
- **`v_month_coverage`**: `month`, `source`, `account_last4`, `days_covered`, `days_in_month`.

Task 14 (spread costs) adds a spread version beside these. These views keep the cash version.

## `finos month` output (example shape, made-up figures)
```
2026-09  partial: 2 of 5 accounts cover the whole month
  axis-bank             30 of 30 days
  sbi-card *04          21 of 30 days
  ...
Income                          1,50,000.00
  Salary                        1,45,000.00
  Interest & dividends              5,000.00
Expenses                          98,500.00
  Rent                            40,000.00   (refunds 5,000.00)
  Loan EMI                        30,000.00   (refunds 10,000.00)
  ...
Savings                           51,500.00   (34% of income)
Investments                       20,000.00   (in 25,000.00, out 5,000.00)
Not counted: 4 linked transfers (2,40,000.00); Own accounts 30,000.00 out, 12,000.00 in
```
Warnings follow when they apply: rows that wait for review, rows with no category, a flagged statement in the month, stale transfer links.

## Patterns to mirror
| Category | Source | Pattern |
|---|---|---|
| Schema | `src/finos/migrations/0003_categories.sql` | Numbered SQL file; comments explain each view |
| Read path | `src/finos/report.py` | Dataclasses built from `db.execute`, formatted in `cli.py` |
| Live link check | `report.status` | `find(load(db), profiles, handles(db))` |
| CLI | `cli.py` | Typer command, `_db()` or `_session()`, `_plain()` on every printed value |
| Tests | `tests/test_transfers.py:store`, `tests/test_categorise.py` | Synthetic statements in a throwaway Postgres behind the Neon emulator |

## Files to change
| File | Action | Why |
|---|---|---|
| `src/finos/migrations/0005_views.sql` | CREATE | The four views |
| `src/finos/month.py` | CREATE | Read the views into dataclasses; the stale-link check |
| `src/finos/db.py` | UPDATE | `NeonHttpDb.read_only(sql)` for `finos sql` |
| `src/finos/cli.py` | UPDATE | `finos month [YYYY-MM]`, `finos sql "<query>"`, Indian amount format, app help |
| `tests/test_month.py` | CREATE | The cases below |
| `tests/test_db.py`, `tests/test_cli.py` | UPDATE | Read-only query; command output |
| `README.md`, `docs/handoff.md`, parent plan | UPDATE | Commands, status, handoff in ASD-STE100 |

## Tasks

### D1.1 Views (tests first)
One synthetic month holds every kind of row, and the test pins every figure:
1. Salary and interest credits count as income.
2. Groceries and rent debits count as expenses.
3. A rent credit (a settlement) is a refund: it reduces Rent, and income does not change.
4. A Loan EMI debit counts in full; a Loan EMI credit (the builder) reduces it.
5. An Investments debit and credit give in, out and net; neither changes income or expenses.
6. A linked pair whose debit still has the category Shopping counts as a transfer, not as Shopping.
7. An "Own accounts" debit and credit count as neither, and show in the left-out amounts.
8. A row that waits for review counts with its category, and shows in the counts.
9. A row with no category does not count, and shows in the counts.
10. A row of a flagged statement does not count anywhere.
11. A card row dated in the previous month counts in that month, not in the statement's month.
12. Savings = income − expenses.
13. A category whose refunds are larger than its spending shows a negative net.

### D1.2 Coverage (tests first)
1. A statement of 22 Aug–21 Sep covers 10 of 31 days of August and 21 of 30 days of September.
2. Two overlapping statements of one account count each day once.
3. A flagged statement covers nothing.
4. A month is complete only when every account in the record covers every day.

### D1.3 `finos month` (tests first)
1. `finos month` lists each month with its four figures and "complete" or "partial".
2. `finos month 2026-09` shows coverage, income and expenses by category with refunds, savings, investments and the left-out amounts.
3. A bad month (`2026-13`, `Sept`) is refused with a clear message.
4. A month with no data says that no statement covers it.
5. Stale links give a warning; current links give none.
6. No output contains a narration.
7. Amounts use Indian grouping: `108000` prints as `1,08,000.00`; a negative net keeps its sign.

### D1.4 `finos sql` (tests first)
1. A `select` on a view prints a table.
2. `insert`, `delete`, `create table`, a writable CTE and `set transaction read write` all fail, and the data does not change.
3. A query with `%` (`like '%x%'`) works.
4. More than 200 rows print 200 and say how many were cut.
5. A cell with control characters or more than 60 characters is cleaned and cut.
6. A database error prints its cleaned message and exits with code 1.

### D1.5 Real data (free)
1. Run `uv run finos month` and `uv run finos month 2026-09`.
2. Check by hand that the 8 linked transfers and the "Own accounts" rows are left out.
3. Check that the builder's EMI payment reduces Loan EMI and the landlord's settlement reduces Rent.
4. Tell the user the figures in the chat. They do not go into the repository.

### D1.6 Review and handoff
1. Run the Python, database and security reviews. Correct the critical and high findings.
2. Update `README.md`, the parent plan (Task 13 done) and `docs/handoff.md` (ASD-STE100).
3. Ask the user before the commit.

## Validation
```bash
uv run ruff check . && uv run ruff format --check .
uv run pytest --cov=finos --cov-fail-under=80
uv run finos month
uv run finos month 2026-09
uv run finos sql "select month, income, expenses, savings from v_monthly_summary"
```

## Risks
| Risk | Likelihood | Mitigation |
|---|---|---|
| A partial month is read as a full one | High until the back-fill | Coverage is printed first in every month view, and the list marks each month complete or partial. |
| An unsure small category is wrong (known limit 19) | Medium | The month view shows spending by category. A strange figure is the cue for `finos correct`. |
| `finos sql` changes data | Low | A read-only transaction fixed before the query runs, with tests for each kind of write. The Neon role itself can still write; a read-only role needs a second connection string, which the network secret form cannot hold for the same host. |
| A query from `finos sql` prints a narration | Medium | The views carry none. A query on `transactions` can still select one. Output is cleaned and bounded, and `CLAUDE.md` says to treat it as data. |
| Stale transfer links change a figure | Low | `finos month` warns. `finos transfers` corrects them for free. |
