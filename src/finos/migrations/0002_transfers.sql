-- Own-account transfers: a debit in one of your accounts and the matching credit in another.
-- A linked pair is neither income nor expense. Links are rebuilt from scratch after every
-- change to the record (finos transfers, or a sync that imported something), because a
-- replaced statement gives its transactions new IDs.

-- Text that names you in a narration, such as the digits of the phone number in your UPI IDs.
-- Personal, so it lives here and never in the repository.
create table owner_handles (
    handle text primary key,
    added_at timestamptz not null default now()
);

-- Each transaction is in at most one link. Deleting a statement deletes its transactions,
-- and with them their links.
create table transfer_links (
    debit_txn_id text primary key references transactions on delete cascade,
    credit_txn_id text not null unique references transactions on delete cascade,
    evidence text not null,
    linked_at timestamptz not null default now(),
    check (debit_txn_id <> credit_txn_id)
);
