-- Liste de courses permanente (2026-11-22, migration liste_courses).
-- Une tâche spéciale « 🛒 Courses », toujours en cours ; ses articles sont les lignes de sa checklist.

-- 1. Marqueur des éléments spéciaux (un seul pour l'instant : 'courses').
alter table items add column special text unique check (special in ('courses'));
comment on column items.special is 'Élément permanent géré par l''appli (''courses'' = liste de courses). Le tri ne le touche pas.';

insert into items (texte_brut, titre, details, type, etat, horizon, special, source)
values ('Liste de courses', '🛒 Courses', 'Liste de courses permanente : les articles sont les lignes de sa checklist.',
        'course', 'en_cours', 'maintenant', 'courses', 'app');

-- 2. La liste de courses reste toujours en cours, sans parent, et ne peut pas être supprimée.
create or replace function protege_special() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.special is not null then raise exception 'La liste de courses ne peut pas être supprimée'; end if;
    return old;
  end if;
  if old.special is not null then
    if new.etat is distinct from 'en_cours' then raise exception 'La liste de courses reste toujours en cours'; end if;
    if new.special is distinct from old.special then raise exception 'La liste de courses ne peut pas être modifiée ainsi'; end if;
    if new.parent_id is not null then raise exception 'La liste de courses ne peut pas être une sous-tâche'; end if;
  end if;
  return new;
end $$;

create trigger items_protege_special before update or delete on items
  for each row execute function protege_special();

-- Rien ne peut devenir sous-tâche de la liste de courses (ses articles sont dans la checklist).
create or replace function refuse_parent_courses() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.parent_id is not null and exists (select 1 from items where id = new.parent_id and special = 'courses') then
    raise exception 'Ajoute plutôt un article à la liste de courses';
  end if;
  return new;
end $$;

create trigger items_refuse_parent_courses before insert or update of parent_id on items
  for each row execute function refuse_parent_courses();

-- 3. Articles déjà achetés, pour les suggestions (« la » → « lait »).
create table articles_courses (
  nom     text not null check (length(trim(nom)) between 1 and 200),
  fois    integer not null default 1,
  dernier timestamptz not null default now()
);
create unique index articles_courses_nom_idx on articles_courses (lower(nom));
alter table articles_courses enable row level security;
create policy "autorises_articles_courses" on articles_courses for all to authenticated
  using ((select est_autorise())) with check ((select est_autorise()));

create or replace function retient_article() returns trigger
language plpgsql set search_path = public as $$
begin
  if exists (select 1 from items where id = new.item_id and special = 'courses') then
    insert into articles_courses (nom) values (trim(new.texte))
    on conflict ((lower(nom))) do update set fois = articles_courses.fois + 1, dernier = now(), nom = excluded.nom;
  end if;
  return new;
end $$;

create trigger checklist_retient_article after insert on checklist
  for each row execute function retient_article();
