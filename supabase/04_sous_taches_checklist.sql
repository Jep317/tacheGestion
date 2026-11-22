-- Sous-tâches, notes attachées et checklists (2026-11-22, migration sous_taches_checklist).

-- 1. Lien parent / enfant dans items.
--    Une tâche (ou course) peut avoir des sous-tâches, sur 3 niveaux au plus.
--    Une note ou idée peut être attachée à n'importe quelle tâche ou sous-tâche (elle ne compte pas comme un niveau).
--    Si le parent est supprimé, les enfants redeviennent des éléments indépendants.
alter table items add column parent_id uuid references items(id) on delete set null;
create index items_parent_idx on items (parent_id);
comment on column items.parent_id is 'Tâche parente : sous-tâche (type tache/course, 3 niveaux max) ou note/idée attachée à une tâche.';

create or replace function verifie_parent() returns trigger
language plpgsql set search_path = public as $$
declare
  p uuid;
  t item_type;
  profondeur int := 0;   -- nombre d'ancêtres de new
  hauteur int;           -- niveaux de sous-tâches sous new
begin
  if new.parent_id is null then return new; end if;
  if new.parent_id = new.id then raise exception 'Un élément ne peut pas être son propre parent'; end if;
  select type into t from items where id = new.parent_id;
  if t is null then raise exception 'Tâche parente introuvable'; end if;
  if t not in ('tache', 'course') then raise exception 'Le parent doit être une tâche'; end if;
  p := new.parent_id;
  while p is not null loop
    if p = new.id then raise exception 'Lien circulaire entre tâches'; end if;
    profondeur := profondeur + 1;
    select parent_id into p from items where id = p;
  end loop;
  if new.type in ('note', 'idee') then return new; end if;
  with recursive sous(id, n) as (
    select i.id, 1 from items i where i.parent_id = new.id and i.type in ('tache', 'course')
    union all
    select i.id, s.n + 1 from items i join sous s on i.parent_id = s.id where i.type in ('tache', 'course') and s.n < 5
  ) select coalesce(max(n), 0) into hauteur from sous;
  if profondeur + hauteur > 2 then raise exception 'Trois niveaux de sous-tâches au maximum'; end if;
  return new;
end $$;

create trigger items_verifie_parent before insert or update of parent_id, type on items
  for each row execute function verifie_parent();

-- 2. Checklist simple d'une tâche (réutilisée par la liste de courses).
create table checklist (
  id       uuid primary key default gen_random_uuid(),
  item_id  uuid not null references items(id) on delete cascade,
  texte    text not null check (length(trim(texte)) between 1 and 200),
  coche    boolean not null default false,
  ordre    integer not null default 0,
  cree_le  timestamptz not null default now()
);
create index checklist_item_idx on checklist (item_id, ordre);
alter table checklist enable row level security;
create policy "autorises_checklist" on checklist for all to authenticated
  using ((select est_autorise())) with check ((select est_autorise()));
alter publication supabase_realtime add table checklist;
