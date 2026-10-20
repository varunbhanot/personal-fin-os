-- Spread costs and goals (Slice D, part 2), and the table finos eval reports into.
-- The cash views of 0006 do not change. Each figure view gets a spread version next to it,
-- with the same counting rules.
--
-- Spreads and goal rows name a transaction by txn_id with no foreign key: a replaced
-- statement gives its rows new IDs, and a cascade would drop your decision without a word,
-- while a plain foreign key would stop finos sync from replacing the statement. They keep a
-- copy of the row's date, account, direction and amount instead, so v_spread_problems can name
-- a row whose ID is gone.

-- One row's value counted in equal parts across months in a row, from start_month.
create table spreads (
    spread_id bigint generated always as identity primary key,
    txn_id text not null unique,
    txn_date date not null,
    source text not null,
    account_last4 text not null,
    direction text not null check (direction in ('debit', 'credit')),
    amount numeric(14, 2) not null check (amount > 0),
    start_month date not null check (start_month = date_trunc('month', start_month)::date),
    months integer not null check (months between 1 and 60),
    created_at timestamptz not null default now()
);

-- Something you save or spend for, such as a trip, with a budget. Names are personal, so they
-- live here and never in the repository.
create table goals (
    goal_id bigint generated always as identity primary key,
    name text not null check (length(name) between 1 and 60),
    budget numeric(14, 2) not null check (budget > 0),
    created_at timestamptz not null default now()
);

create unique index goals_by_lower_name on goals (lower(name));

-- The rows of each goal. A row belongs to one goal at most.
create table goal_rows (
    txn_id text primary key,
    goal_id bigint not null references goals on delete cascade,
    txn_date date not null,
    source text not null,
    account_last4 text not null,
    direction text not null check (direction in ('debit', 'credit')),
    amount numeric(14, 2) not null check (amount > 0),
    added_at timestamptz not null default now()
);

create index goal_rows_by_goal on goal_rows (goal_id);

-- One line per finos eval run: counts and rates only, no text from a statement.
create table eval_runs (
    id bigint generated always as identity primary key,
    at timestamptz not null default now(),
    model text not null,
    reference_model text not null,
    statements integer not null,
    skipped integer not null,
    rows_stored integer not null,
    rows_matched integer not null,
    amount_mismatches integer not null,
    rows_missing integer not null,
    rows_extra integer not null,
    verified integer not null,
    categories_asked integer,
    categories_agreed integer,
    cost_usd numeric(10, 4) not null
);

-- v_transactions with each spread row split into its parts. A row without a spread keeps its
-- one line. A spread row gives one line per month: month = start_month + i months, and value
-- = the part, in paise, toward zero, the last month taking what is left so the parts add up
-- to the row (finos.spread.parts does the same). A spread row with no value (now half of a
-- transfer, or with no category) keeps its one cash line, as in v_transactions.
--   txn_month   the month of the row's date (the cash month)
--   spread_id   the spread the line comes from, or null
create view v_transactions_spread as
select
    v.txn_id,
    v.txn_date,
    coalesce((p.start_month + make_interval(months => i.n))::date, v.month) as month,
    v.source,
    v.account_last4,
    coalesce(abs(x.part), v.amount) as amount,
    v.direction,
    v.counterparty,
    v.category,
    v.linked,
    v.kind,
    v.refund,
    coalesce(x.part, v.value) as value,
    v.needs_review,
    v.month as txn_month,
    p.spread_id
from v_transactions v
left join spreads p on p.txn_id = v.txn_id and v.value is not null
cross join lateral generate_series(0, coalesce(p.months, 1) - 1) as i (n)
cross join lateral (
    select (trunc(v.value * 100 / p.months) / 100)::numeric(14, 2) as share
) e
cross join lateral (
    select case
        when p.spread_id is null then null
        when i.n < p.months - 1 then e.share
        else v.value - (p.months - 1) * e.share
    end as part
) x;

-- v_monthly_by_category, from v_transactions_spread.
create view v_monthly_by_category_spread as
select
    v.month,
    v.kind,
    v.category,
    c.position,
    count(*)::int as rows,
    sum(case when v.value > 0 then v.amount else 0 end) as gross,
    sum(case when v.value < 0 then v.amount else 0 end) as offsets,
    sum(v.value) as net
from v_transactions_spread v
join categories c on c.name = v.category
where v.kind in ('income', 'expense', 'investment')
group by v.month, v.kind, v.category, c.position;

-- v_monthly_summary, from v_transactions_spread, with the same columns in the same order. The
-- months are those of v_month_coverage and every month a spread part falls in; a month that
-- no statement covers is not complete.
create view v_monthly_summary_spread as
with complete as (
    select month, bool_and(days_covered = days_in_month) as complete
    from v_month_coverage
    group by month
    union all
    select distinct s.month, false
    from v_transactions_spread s
    where s.spread_id is not null
        and not exists (select 1 from v_month_coverage c where c.month = s.month)
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
    left join v_transactions_spread v on v.month = m.month
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

-- Each goal's spending, month by month (the cash month of each row), then a total line with
-- month null. spent adds the goal's expense rows; a refund takes away. spent_to_date runs by
-- month, and remaining = budget - spent_to_date. A goal with no counted rows has one total
-- line of 0. A goal row that no longer counts, or is no longer an expense, adds nothing.
create view v_goal_progress as
with counted as (
    select r.goal_id, v.month, v.value
    from goal_rows r
    join v_transactions v on v.txn_id = r.txn_id and v.kind = 'expense'
),
lines as (
    select
        g.goal_id,
        c.month,
        grouping(c.month) = 1 as total,
        count(c.value)::int as rows,
        coalesce(sum(c.value), 0) as spent
    from goals g
    left join counted c on c.goal_id = g.goal_id
    group by grouping sets ((g.goal_id, c.month), (g.goal_id))
),
running as (
    select
        l.*,
        sum(l.spent) over (partition by l.goal_id, l.total order by l.month) as spent_to_date
    from lines l
    where l.total or l.month is not null
)
select
    r.goal_id,
    g.name as goal,
    g.budget,
    r.month,
    r.rows,
    r.spent,
    r.spent_to_date,
    g.budget - r.spent_to_date as remaining
from running r
join goals g on g.goal_id = r.goal_id;

-- Spreads and goal rows that add nothing now, named by their stored copy (never a narration):
--   state  'not counted'     the row is not in v_transactions (its statement was replaced or
--                            flagged, or a later statement covers its day)
--          'transfer'        a spread row that is now half of a transfer, or "Own accounts"
--          'no category'     a spread row with no category
--          'not an expense'  a goal row whose kind is no longer expense
create view v_spread_problems as
select
    'spread' as what,
    p.spread_id as id,
    p.txn_id,
    p.txn_date,
    p.source,
    p.account_last4,
    p.direction,
    p.amount,
    case
        when v.txn_id is null then 'not counted'
        when v.kind is null then 'no category'
        else 'transfer'
    end as state
from spreads p
left join v_transactions v on v.txn_id = p.txn_id
where v.value is null
union all
select
    'goal',
    r.goal_id,
    r.txn_id,
    r.txn_date,
    r.source,
    r.account_last4,
    r.direction,
    r.amount,
    case when v.txn_id is null then 'not counted' else 'not an expense' end
from goal_rows r
left join v_transactions v on v.txn_id = r.txn_id
where v.kind is distinct from 'expense';
