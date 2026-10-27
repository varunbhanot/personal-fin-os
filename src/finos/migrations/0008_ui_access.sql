-- The laptop UI (finos ui) reads the record as the group role finos_ui_access. It gets only
-- views without text from a statement, a categorisation or the household: no narration, no
-- reason, no handle, no note, no transfer evidence, no file name, no problem text and no
-- payee name. Views keep their owner's rights; never make one security_invoker. A later view
-- needs its own grant in its migration (no default privileges), and the allow-list test in
-- tests/test_ui_views.py fails until its snapshot is updated.

-- No row can lower the month's AI spend: costs and token counts are never negative.
alter table ai_usage add constraint ai_usage_not_negative check (
    cost_usd >= 0 and input_tokens >= 0 and output_tokens >= 0
    and cache_read_tokens >= 0 and cache_write_tokens >= 0);

-- Rows for the UI and the chat: the columns of v_transactions without counterparty, with the
-- 8-character row ID that finos prints (spread.SHOWN_ID).
create view v_ui_rows as
select left(txn_id, 8) as row_id, txn_date, month, source, account_last4, amount, direction,
    category, linked, kind, refund, value, needs_review
from v_transactions;

-- Spreads without any text: which row, how many months, from when.
create view v_ui_spreads as
select spread_id, left(txn_id, 8) as row_id, txn_date, source, account_last4, direction,
    amount, start_month, months
from spreads;

-- Goal progress without the goal name (user text). The chat's tools read this view, never
-- v_goal_progress, which only the browser's goals panel reads.
create view v_ui_goal_progress as
select goal_id, budget, month, rows, spent, spent_to_date, remaining
from v_goal_progress;

-- AI cost by month, purpose and model. The UI role reads this, not ai_usage.
create view v_ai_spend as
select date_trunc('month', at)::date as month, purpose, model,
    count(*)::int as calls, sum(cost_usd) as cost_usd
from ai_usage
group by 1, 2, 3;

-- Statement status without file names or problem texts (both can hold third-party text).
create view v_statement_health as
select s.source, s.account_last4, s.period_start, s.period_end, s.status,
    count(t.txn_id)::int as rows
from statements s
left join transactions t on t.statement_id = s.statement_id
group by 1, 2, 3, 4, 5;

-- Roles belong to the whole cluster, so a second database on it finds the role made.
do $$ begin
    if not exists (select from pg_roles where rolname = 'finos_ui_access') then
        create role finos_ui_access nologin;
    end if;
end $$;

grant usage on schema public to finos_ui_access;

grant select on v_monthly_summary, v_monthly_summary_spread, v_monthly_by_category,
    v_monthly_by_category_spread, v_month_coverage, v_goal_progress, v_spread_problems,
    v_ui_rows, v_ui_spreads, v_ui_goal_progress, v_ai_spend, v_statement_health
    to finos_ui_access;

grant select (version) on schema_migrations to finos_ui_access;

-- The chat records its own cost. The row's time and ID come from their defaults.
grant insert (purpose, model, input_tokens, output_tokens, cache_read_tokens,
    cache_write_tokens, cost_usd) on ai_usage to finos_ui_access;
