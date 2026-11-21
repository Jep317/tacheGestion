-- Gestionnaire de tâches et notes de Jérémie : schéma Supabase (étape 1)
-- Claude est le gestionnaire principal de cette table (tri, ordre, mises à jour).

create type item_type    as enum ('tache', 'note', 'idee', 'course');
create type item_espace  as enum ('perso', 'famille');
create type item_horizon as enum ('maintenant', 'bientot', 'plus_tard', 'un_jour');
create type item_etat    as enum ('a_trier', 'a_faire', 'en_cours', 'fait', 'abandonne');

create table items (
  id            uuid primary key default gen_random_uuid(),
  texte_brut    text not null,                 -- ce que Jérémie a dit/écrit, jamais modifié
  titre         text,                          -- reformulé court par Claude
  details       text,                          -- précisions, contenu d'une note
  type          item_type    not null default 'tache',
  espace        item_espace  not null default 'perso',
  horizon       item_horizon,                  -- null tant que non trié
  etat          item_etat    not null default 'a_trier',
  theme         text,                          -- maison, voiture, santé, enfants, admin...
  projet        text,                          -- regroupe les tâches d'un projet (vue Kanban)
  ordre         integer,                       -- rang dans son horizon, fixé par Claude
  echeance      date,                          -- seulement s'il existe une vraie date
  source        text default 'app',            -- app, widget, claude, vocal
  cree_le       timestamptz not null default now(),
  modifie_le    timestamptz not null default now(),
  trie_le       timestamptz,                   -- dernier passage de tri par Claude
  fait_le       timestamptz
);

create index items_vue_idx on items (etat, horizon, ordre);
create index items_espace_idx on items (espace);

-- Journal de ce que Claude change, pour pouvoir relire ou annuler.
create table journal (
  id        bigint generated always as identity primary key,
  item_id   uuid references items(id) on delete set null,
  action    text not null,                     -- cree, trie, modifie, termine, supprime
  avant     jsonb,
  apres     jsonb,
  par       text not null default 'claude',
  le        timestamptz not null default now()
);

create or replace function touche_modifie_le() returns trigger language plpgsql as $$
begin new.modifie_le := now(); return new; end $$;
create trigger items_modifie_le before update on items
  for each row execute function touche_modifie_le();

-- Sécurité : accès réservé aux utilisateurs connectés (Jérémie, puis la famille si besoin).
alter table items   enable row level security;
alter table journal enable row level security;
create policy "connecte_items"   on items   for all to authenticated using (true) with check (true);
create policy "connecte_journal" on journal for all to authenticated using (true) with check (true);

-- Temps réel pour que l'appli, le widget et le panneau de bureau se mettent à jour seuls.
alter publication supabase_realtime add table items;
