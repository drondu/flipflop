-- FlipLedger schema. Run in Supabase → SQL Editor → New query → Run.
-- One row per storage key, scoped to the owning user. Mirrors the app's
-- existing key/value access pattern so the UI code needs no changes.

create table if not exists public.kv (
  user_id uuid not null references auth.users(id) on delete cascade,
  key     text not null,
  value   jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

alter table public.kv enable row level security;

-- Each policy re-checks auth.uid(), so a row is only ever visible to its owner.
drop policy if exists "kv_select_own" on public.kv;
create policy "kv_select_own" on public.kv
  for select using (auth.uid() = user_id);

drop policy if exists "kv_insert_own" on public.kv;
create policy "kv_insert_own" on public.kv
  for insert with check (auth.uid() = user_id);

drop policy if exists "kv_update_own" on public.kv;
create policy "kv_update_own" on public.kv
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "kv_delete_own" on public.kv;
create policy "kv_delete_own" on public.kv
  for delete using (auth.uid() = user_id);

create index if not exists kv_user_idx on public.kv (user_id);
