-- À coller dans Supabase > SQL Editor > New query, puis "Run".
-- Effet : seuls les comptes listés dans la table "autorises" voient les tâches depuis l'appli.
create table if not exists autorises (
  email  text primary key,
  ajoute_le timestamptz not null default now()
);
alter table autorises enable row level security;

create or replace function est_autorise() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.autorises a where lower(a.email) = lower(auth.jwt() ->> 'email'))
$$;
revoke execute on function est_autorise() from public, anon;
grant execute on function est_autorise() to authenticated;

create policy "lecture_soi" on autorises for select to authenticated
  using (lower(email) = lower(auth.jwt() ->> 'email'));

drop policy if exists "connecte_items" on items;
drop policy if exists "connecte_journal" on journal;
create policy "autorises_items"   on items   for all to authenticated using ((select est_autorise())) with check ((select est_autorise()));
create policy "autorises_journal" on journal for all to authenticated using ((select est_autorise())) with check ((select est_autorise()));
