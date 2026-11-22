-- Catégories choisies par Jérémie (remplacent les espaces fixes Perso / Famille).
-- Appliqué le 2026-11-21 (migration categories_personnalisables).
create table categories (
  id      uuid primary key default gen_random_uuid(),
  nom     text not null check (length(trim(nom)) between 1 and 40),
  ordre   integer not null default 0,
  cree_le timestamptz not null default now()
);
create unique index categories_nom_unique on categories (lower(trim(nom)));
alter table categories enable row level security;
create policy "autorises_categories" on categories for all to authenticated
  using ((select est_autorise())) with check ((select est_autorise()));

alter table items add column categorie_id uuid references categories(id) on delete set null;
create index items_categorie_idx on items (categorie_id);
comment on column items.espace is 'Obsolète : remplacé par categorie_id (catégories gérées par Jérémie).';

alter publication supabase_realtime add table categories;

insert into categories (nom, ordre) values ('Maison',1),('Enfants',2),('Voiture',3),('Achats',4),('Administratif',5);
