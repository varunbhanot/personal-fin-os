-- No free text in ai_usage.purpose or ai_usage.model: finos status shows them in cloud
-- sessions, and the UI's group role can insert rows (migration 0008). The purpose allows "-"
-- for eval-extract and eval-categorise. A separate migration, because 0008 was already applied
-- by file name: an edit to it would never reach a database that ran it.
alter table ai_usage add constraint ai_usage_text check (
    purpose ~ '^[a-z_-]{1,20}$' and model ~ '^claude-[a-z0-9-]{1,60}$');
