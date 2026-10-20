-- Categories, the memory of confirmed counterparties, and the review queue.
-- The category list comes from finos/categories.yaml and is copied here on each run, so views
-- can join on it for the kind. Notes, counterparties and corrections hold names, so they live
-- here and never in the repository.

create table categories (
    name text primary key,
    kind text not null check (kind in ('expense', 'income', 'investment', 'transfer')),
    description text not null,
    position integer not null
);

-- Facts about the household that help Claude, such as who the cook is.
create table household_notes (
    id bigint generated always as identity primary key,
    note text not null check (length(note) between 1 and 300),
    added_at timestamptz not null default now()
);

-- The memory: counterparties you have confirmed or corrected, and their category. A row whose
-- counterparty is here is categorised without asking you again. Names are matched ignoring case.
create table counterparties (
    name text primary key check (length(name) between 1 and 40),
    category text not null references categories,
    confirmed_at timestamptz not null default now()
);

create unique index counterparties_by_lower_name on counterparties (lower(name));

-- One answer per transaction. narration_key groups rows with the same payee text (null when
-- the text is too short to tell payees apart). A replaced statement's transactions get new
-- IDs, so their answers go with them, and memory answers the new rows.
create table categorisations (
    txn_id text primary key references transactions on delete cascade,
    narration_key text,
    counterparty text not null check (length(counterparty) between 1 and 40),
    category text not null references categories,
    confidence text not null check (confidence in ('high', 'medium', 'low')),
    reason text not null check (length(reason) <= 100),
    origin text not null check (origin in ('memory', 'ai', 'user')),
    needs_review boolean not null,
    problem text,
    model text,
    prompt_version text,
    created_at timestamptz not null default now(),
    check (problem is null or needs_review)
);

-- correct and accept find a counterparty's rows ignoring case.
create index categorisations_by_counterparty on categorisations (lower(counterparty));

-- Which counterparty each narration key belongs to. It outlives the transactions, so the rows
-- of a replaced statement are recognised again without asking Claude.
create table narration_keys (
    narration_key text primary key,
    counterparty text not null,
    updated_at timestamptz not null default now()
);

-- Each time you changed a category: the accuracy count, and examples for later requests.
create table corrections (
    id bigint generated always as identity primary key,
    counterparty text not null,
    from_category text not null,
    to_category text not null,
    at timestamptz not null default now(),
    check (from_category <> to_category)
);
