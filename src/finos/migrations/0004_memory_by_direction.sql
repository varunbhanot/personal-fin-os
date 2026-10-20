-- Memory per payee and direction. Money out and money in can mean different things for one
-- payee: for your own name, an EMI out and a transfer in; for a bank, fees out and interest in.

alter table counterparties drop constraint counterparties_pkey;

drop index counterparties_by_lower_name;

alter table counterparties add column direction text not null default 'debit'
    check (direction in ('debit', 'credit'));

-- A decision made before this change covered both directions, so it is kept for both.
insert into counterparties (name, direction, category, confirmed_at)
    select name, 'credit', category, confirmed_at from counterparties;

alter table counterparties alter column direction drop default;

alter table counterparties add primary key (name, direction);

create unique index counterparties_by_lower_name on counterparties (lower(name), direction);

-- The review rule changed: only a row with a problem, or an unsure answer for 10,000 rupees or
-- more, waits for you. Rows stored before follow it too; rows you decided on stay as they are.
update categorisations g
    set needs_review = (g.problem is not null or (g.confidence <> 'high' and t.amount >= 10000))
    from transactions t
    where t.txn_id = g.txn_id and g.origin <> 'user';
