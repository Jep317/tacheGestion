-- Résumé du matin et revue de la semaine (appliqué le 2026-11-22, migration resume_matin_revue_hebdo).

-- 1. Priorités du jour : chaque matin, Claude marque 3 tâches (rang 1 à 3) avec la date du jour (heure de Paris).
alter table items
  add column priorite_jour   date,
  add column priorite_rang   smallint check (priorite_rang between 1 and 5),
  add column priorite_raison text check (length(priorite_raison) <= 200);
create index items_priorite_idx on items (priorite_jour) where priorite_jour is not null;

-- 2. Revue de la semaine : le dimanche, Claude propose ; Jérémie accepte ou refuse dans l'appli.
create table propositions (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references items(id) on delete cascade,
  revue       date not null,                                   -- dimanche de la revue
  action      text not null check (action in ('reporter', 'abandonner', 'planifier')),
  changements jsonb not null default '{}'::jsonb,              -- {"horizon": "plus_tard"} et/ou {"echeance": "2026-12-05"}
  raison      text not null check (length(raison) between 1 and 300),
  statut      text not null default 'en_attente' check (statut in ('en_attente', 'acceptee', 'refusee', 'expiree')),
  cree_le     timestamptz not null default now(),
  repondu_le  timestamptz
);
create index propositions_attente_idx on propositions (statut, revue);
create index propositions_item_idx on propositions (item_id);
alter table propositions enable row level security;
create policy "autorises_propositions" on propositions for all to authenticated
  using ((select est_autorise())) with check ((select est_autorise()));
alter publication supabase_realtime add table propositions;

-- Répondre à une proposition : applique le changement à la tâche (si accepté) et l'écrit au journal.
-- security invoker : les règles d'accès (RLS) de l'utilisateur connecté s'appliquent.
create or replace function repondre_proposition(p_id uuid, p_accepter boolean)
returns text language plpgsql security invoker set search_path = '' as $$
declare
  p public.propositions;
  it public.items;
  maj jsonb := '{}'::jsonb;
begin
  select * into p from public.propositions where id = p_id and statut = 'en_attente' for update;
  if not found then return 'deja_traitee'; end if;

  if not p_accepter then
    update public.propositions set statut = 'refusee', repondu_le = now() where id = p_id;
    return 'refusee';
  end if;

  select * into it from public.items where id = p.item_id for update;
  if not found or it.etat in ('fait', 'abandonne') then
    update public.propositions set statut = 'expiree', repondu_le = now() where id = p_id;
    return 'expiree';
  end if;

  if p.action = 'abandonner' then
    update public.items set etat = 'abandonne' where id = it.id;
    maj := jsonb_build_object('etat', 'abandonne');
  else
    if p.changements ? 'horizon' then
      update public.items set horizon = (p.changements->>'horizon')::public.item_horizon where id = it.id;
      maj := maj || jsonb_build_object('horizon', p.changements->>'horizon');
    end if;
    if p.changements ? 'echeance' then
      update public.items set echeance = (p.changements->>'echeance')::date where id = it.id;
      maj := maj || jsonb_build_object('echeance', p.changements->>'echeance');
    end if;
  end if;

  insert into public.journal (item_id, action, avant, apres, par)
  values (it.id, 'revue_acceptee',
          jsonb_build_object('etat', it.etat, 'horizon', it.horizon, 'echeance', it.echeance),
          maj || jsonb_build_object('proposition', p.action), 'appli');
  update public.propositions set statut = 'acceptee', repondu_le = now() where id = p_id;
  return 'acceptee';
end $$;
revoke execute on function repondre_proposition(uuid, boolean) from public, anon;
grant execute on function repondre_proposition(uuid, boolean) to authenticated;
