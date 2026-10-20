-- The monthly views: income, expenses by category, savings and investments, as the PRD
-- defines them. finos month reads them, and so can finos sql or a dashboard.
--
-- Only statements that passed their checks count. A row belongs to the month of its date. No
-- view has a narration column: narrations are third-party text.

-- Each transaction of an ok statement, with how it counts.
--   kind    the category's kind, or 'transfer' for half of a linked transfer, whatever its
--           category says (a row keeps an old category until finos categorise runs again).
--           Null when the row has no category yet.
--   value   what the row adds to its kind's total. Income: money in adds, money out takes
--           away. Expense: money out adds, money in (a refund) takes away. Investment: money
--           put in adds, money taken out takes away. Null for a transfer or no category.
create view v_transactions as
select
    t.txn_id,
    t.txn_date,
    date_trunc('month', t.txn_date::timestamp)::date as month,
    s.source,
    s.account_last4,
    t.amount,
    t.direction,
    g.counterparty,
    case when l.txn_id is null then g.category end as category,
    l.txn_id is not null as linked,
    case when l.txn_id is not null then 'transfer' else c.kind end as kind,
    coalesce(l.txn_id is null and c.kind = 'expense' and t.direction = 'credit', false)
        as refund,
    case
        when l.txn_id is not null or c.kind is null or c.kind = 'transfer' then null
        when (c.kind = 'income') = (t.direction = 'credit') then t.amount
        else -t.amount
    end as value,
    coalesce(l.txn_id is null and g.needs_review, false) as needs_review
from transactions t
join statements s on s.statement_id = t.statement_id and s.status = 'ok'
left join categorisations g on g.txn_id = t.txn_id
left join categories c on c.name = g.category
left join (
    select debit_txn_id as txn_id from transfer_links
    union all
    select credit_txn_id from transfer_links
) l on l.txn_id = t.txn_id;

-- For each month and account in the record, the days that ok statements cover. Two
-- statements that overlap count each day once. An account with only flagged statements
-- covers nothing, so its months show as partial.
create view v_month_coverage as
with days as (
    select s.source, s.account_last4, d::date as day, s.status = 'ok' as ok
    from statements s
    cross join lateral generate_series(
        s.period_start::timestamp, s.period_end::timestamp, interval '1 day'
    ) as d
),
covered as (
    select date_trunc('month', day::timestamp)::date as month, source, account_last4,
        count(distinct day)::int as days
    from days
    where ok
    group by 1, 2, 3
),
months as (
    select distinct date_trunc('month', day::timestamp)::date as month from days
),
accounts as (
    select distinct source, account_last4 from statements
)
select
    m.month,
    a.source,
    a.account_last4,
    coalesce(c.days, 0) as days_covered,
    extract(day from m.month + interval '1 month' - interval '1 day')::int as days_in_month
from months m
cross join accounts a
left join covered c
    on c.month = m.month and c.source = a.source and c.account_last4 = a.account_last4;

-- Each category's figures for a month. gross is the money in the category's own direction
-- (money in for income, money out for expense and investment); offsets is the other
-- direction (refunds of an expense, money taken out of an investment); net = gross - offsets.
create view v_monthly_by_category as
select
    v.month,
    v.kind,
    v.category,
    c.position,
    count(*)::int as rows,
    sum(case when v.value > 0 then v.amount else 0 end) as gross,
    sum(case when v.value < 0 then v.amount else 0 end) as offsets,
    sum(v.value) as net
from v_transactions v
join categories c on c.name = v.category
where v.kind in ('income', 'expense', 'investment')
group by v.month, v.kind, v.category, c.position;

-- One line per month: the four figures, whether every account covers the whole month, and
-- what is left out of the figures, so nothing disappears without a trace.
create view v_monthly_summary as
with months as (
    select month from v_month_coverage
    union
    select month from v_transactions
),
complete as (
    select month, bool_and(days_covered = days_in_month) as complete
    from v_month_coverage
    group by month
),
totals as (
    select
        m.month,
        coalesce(c.complete, false) as complete,
        coalesce(sum(v.value) filter (where v.kind = 'income'), 0) as income,
        coalesce(sum(v.value) filter (where v.kind = 'expense'), 0) as expenses,
        coalesce(sum(v.amount) filter (
            where v.kind = 'investment' and v.direction = 'debit'), 0) as investments_in,
        coalesce(sum(v.amount) filter (
            where v.kind = 'investment' and v.direction = 'credit'), 0) as investments_out,
        count(v.txn_id) filter (where v.linked)::int as linked_rows,
        coalesce(sum(v.amount) filter (
            where v.linked and v.direction = 'debit'), 0) as linked_out,
        coalesce(sum(v.amount) filter (
            where v.linked and v.direction = 'credit'), 0) as linked_in,
        count(v.txn_id) filter (where v.kind = 'transfer' and not v.linked)::int as own_rows,
        coalesce(sum(v.amount) filter (
            where v.kind = 'transfer' and not v.linked and v.direction = 'debit'), 0) as own_out,
        coalesce(sum(v.amount) filter (
            where v.kind = 'transfer' and not v.linked and v.direction = 'credit'), 0) as own_in,
        count(v.txn_id) filter (where v.needs_review)::int as review_rows,
        coalesce(sum(v.amount) filter (where v.needs_review), 0) as review_amount,
        count(v.txn_id) filter (where v.kind is null)::int as uncategorised_rows,
        coalesce(sum(v.amount) filter (
            where v.kind is null and v.direction = 'debit'), 0) as uncategorised_out,
        coalesce(sum(v.amount) filter (
            where v.kind is null and v.direction = 'credit'), 0) as uncategorised_in
    from months m
    left join complete c on c.month = m.month
    left join v_transactions v on v.month = m.month
    group by m.month, c.complete
)
select
    month,
    complete,
    income,
    expenses,
    income - expenses as savings,
    investments_in,
    investments_out,
    investments_in - investments_out as investments,
    linked_rows,
    linked_out,
    linked_in,
    own_rows,
    own_out,
    own_in,
    review_rows,
    review_amount,
    uncategorised_rows,
    uncategorised_out,
    uncategorised_in
from totals;
