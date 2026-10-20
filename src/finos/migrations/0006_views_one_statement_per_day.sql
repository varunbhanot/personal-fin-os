-- Replaces the views of 0005 after its reviews:
-- - two statements of one account whose periods overlap no longer count their shared days
--   twice (v_counted_transactions);
-- - the months run without a gap from the first date in the record to the last, so a month
--   that no statement covers shows as partial instead of disappearing;
-- - a transaction in transfer_links twice no longer appears twice.

drop view v_monthly_summary;

drop view v_monthly_by_category;

drop view v_month_coverage;

drop view v_transactions;

-- The transactions that count: those of ok statements, with each day of an account taken
-- from one statement. Bank statements can be downloaded for any range, so two statements of
-- one account can overlap. On a day both cover, the one that starts later (then ends later)
-- wins. A card row dated a few days outside its own period (period_slack_days) is kept unless
-- a statement whose period overlaps its own covers that day. transfers.load reads this view
-- too, so linking, categorising and the figures see the same rows.
create view v_counted_transactions as
select t.txn_id, s.statement_id, s.source, s.account_last4
from transactions t
join statements s on s.statement_id = t.statement_id and s.status = 'ok'
where not exists (
    select 1
    from statements o
    where o.status = 'ok'
        and o.source = s.source
        and o.account_last4 = s.account_last4
        and o.statement_id <> s.statement_id
        and o.period_start <= s.period_end
        and o.period_end >= s.period_start
        and t.txn_date between o.period_start and o.period_end
        and (o.period_start, o.period_end, o.statement_id)
            > (s.period_start, s.period_end, s.statement_id)
);

-- Each transaction that counts, with how it counts.
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
    n.source,
    n.account_last4,
    t.amount,
    t.direction,
    g.counterparty,
    case when not k.linked then g.category end as category,
    k.linked,
    case when k.linked then 'transfer' else c.kind end as kind,
    coalesce(not k.linked and c.kind = 'expense' and t.direction = 'credit', false) as refund,
    case
        when k.linked or c.kind is null or c.kind = 'transfer' then null
        when (c.kind = 'income') = (t.direction = 'credit') then t.amount
        else -t.amount
    end as value,
    coalesce(not k.linked and g.needs_review, false) as needs_review
from v_counted_transactions n
join transactions t on t.txn_id = n.txn_id
left join categorisations g on g.txn_id = t.txn_id
left join categories c on c.name = g.category
cross join lateral (
    select exists (
        select 1 from transfer_links l
        where l.debit_txn_id = t.txn_id or l.credit_txn_id = t.txn_id
    ) as linked
) k;

-- For each month and account in the record, the days that ok statements cover. Two
-- statements that overlap count each day once. The months run from the first date in the
-- record (a period start or a transaction date) to the last, so a month that no statement
-- covers is listed with 0 days. An account with only flagged statements covers nothing.
create view v_month_coverage as
with days as (
    select s.source, s.account_last4, d::date as day
    from statements s
    cross join lateral generate_series(
        s.period_start::timestamp, s.period_end::timestamp, interval '1 day'
    ) as d
    where s.status = 'ok'
),
covered as (
    select date_trunc('month', day::timestamp)::date as month, source, account_last4,
        count(distinct day)::int as days
    from days
    group by 1, 2, 3
),
bounds as (
    select min(d) as first, max(d) as last
    from (
        select period_start as d from statements
        union all
        select period_end from statements
        union all
        select t.txn_date from v_counted_transactions n join transactions t using (txn_id)
    ) as dates
),
months as (
    select m::date as month
    from bounds
    cross join lateral generate_series(
        date_trunc('month', bounds.first::timestamp), bounds.last::timestamp, interval '1 month'
    ) as m
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
with complete as (
    select month, bool_and(days_covered = days_in_month) as complete
    from v_month_coverage
    group by month
),
totals as (
    select
        m.month,
        m.complete,
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
    from complete m
    left join v_transactions v on v.month = m.month
    group by m.month, m.complete
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
