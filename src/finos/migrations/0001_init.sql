-- Statements, their transactions, and where each figure came from.
-- Statements are keyed by the SHA-256 of the downloaded file, so importing the same file
-- twice is a no-op, and a new file for the same account and period replaces the old one.

create table source_files (
    sha256 text primary key,
    name text not null,
    first_seen_at timestamptz not null default now()
);

-- Every Drive file seen, including copies of the same content under another name or ID.
create table drive_files (
    drive_file_id text not null,
    drive_md5 text not null,
    sha256 text not null references source_files,
    seen_at timestamptz not null default now(),
    primary key (drive_file_id, drive_md5)
);

create table statements (
    statement_id text primary key references source_files (sha256),
    source text not null,
    account_last4 text not null,
    period_start date not null,
    period_end date not null,
    printed_totals jsonb not null,
    status text not null check (status in ('ok', 'flagged')),
    problems jsonb not null default '[]',
    imported_at timestamptz not null default now(),
    unique (source, account_last4, period_start, period_end),
    check (period_start <= period_end)
);

create table extractions (
    statement_id text primary key references statements on delete cascade,
    model text not null,
    prompt_version text not null,
    attempts integer not null,
    raw jsonb not null,
    created_at timestamptz not null default now()
);

create table transactions (
    txn_id text primary key,
    statement_id text not null references statements on delete cascade,
    seq integer not null,
    txn_date date not null,
    amount numeric(14, 2) not null check (amount > 0),
    direction text not null check (direction in ('debit', 'credit')),
    narration text not null,
    balance numeric(14, 2),
    unique (statement_id, seq)
);

create index transactions_by_date on transactions (txn_date);

create table ai_usage (
    id bigint generated always as identity primary key,
    at timestamptz not null default now(),
    purpose text not null,
    model text not null,
    input_tokens integer not null,
    output_tokens integer not null,
    cache_read_tokens integer not null default 0,
    cache_write_tokens integer not null default 0,
    cost_usd numeric(10, 4) not null
);
