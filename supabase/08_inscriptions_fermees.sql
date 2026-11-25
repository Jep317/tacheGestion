-- Refuse la création de tout compte dont l'e-mail n'est pas dans la table autorises.
create or replace function public.bloque_inscription()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  if not exists (select 1 from public.autorises a where lower(a.email) = lower(new.email)) then
    raise exception 'Inscriptions fermées';
  end if;
  return new;
end $$;
revoke all on function public.bloque_inscription() from public, anon, authenticated;

drop trigger if exists bloque_inscription on auth.users;
create trigger bloque_inscription before insert on auth.users
  for each row execute function public.bloque_inscription();

-- TRUNCATE ignore les règles d'accès : personne côté appli n'en a besoin.
revoke truncate on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke truncate on tables from anon, authenticated;
