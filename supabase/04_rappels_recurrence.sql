-- Échéance avec heure, rappels (notifications Android et Windows) et tâches récurrentes.
-- Appliqué le 2026-11-22 (migration rappels_recurrence).

-- ---------- Échéance et récurrence sur les éléments ----------
alter table items add column echeance_heure time;      -- facultative ; sans heure, l'échéance vaut pour la journée
alter table items add column recurrence jsonb;          -- null = pas de répétition, format ci-dessous
alter table items add column suite_id uuid references items(id) on delete set null; -- occurrence créée quand celle-ci a été faite

comment on column items.recurrence is
  'Répétition : {"freq":"jour|semaine|mois|an","intervalle":1,"jours":[1..7 (1=lundi), pour semaine],'
  '"jour":1..31 (pour mois),"depuis":"echeance|fait"}. Quand l''élément passe à fait, la base crée la suivante.';

-- ---------- Rappels ----------
-- Un rappel est une notification à une heure donnée, liée à un élément ou libre (item_id null :
-- message comme le résumé du matin). Les appareils lisent cette table et notifient eux-mêmes.
create table rappels (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid references items(id) on delete cascade,
  titre       text,                 -- null pour un rappel d'élément : on affiche le titre de l'élément
  texte       text,
  quand       timestamptz not null,
  relatif_min integer,              -- si renseigné : minutes après minuit (heure de Paris) du jour d'échéance
                                    -- de l'élément (480 = 8 h le jour même, -360 = la veille à 18 h).
                                    -- Le rappel suit l'échéance quand elle change et passe à l'occurrence suivante.
  cree_le     timestamptz not null default now(),
  check (item_id is not null or titre is not null),
  check (relatif_min is null or item_id is not null)
);
create index rappels_quand_idx on rappels (quand);
create index rappels_item_idx on rappels (item_id);
alter table rappels enable row level security;
create policy "autorises_rappels" on rappels for all to authenticated
  using ((select est_autorise())) with check ((select est_autorise()));
alter publication supabase_realtime add table rappels;

-- Heure absolue d'un rappel relatif.
create or replace function heure_rappel(echeance date, relatif_min integer) returns timestamptz
language sql immutable set search_path = '' as $$
  select ((echeance::timestamp + make_interval(mins => relatif_min)) at time zone 'Europe/Paris')
$$;

-- ---------- Calcul de la prochaine échéance ----------
create or replace function echeance_suivante(r jsonb, d date) returns date
language plpgsql immutable set search_path = '' as $$
declare
  n     int  := greatest(coalesce((r->>'intervalle')::int, 1), 1);
  jours int[] := coalesce(array(select jsonb_array_elements_text(coalesce(r->'jours', '[]'::jsonb))::int), '{}');
  j     int;
  x     date;
  m     date;
begin
  case r->>'freq'
    when 'jour' then return d + n;
    when 'semaine' then
      if cardinality(jours) = 0 then return d + 7 * n; end if;
      x := d + 1;
      while not (extract(isodow from x)::int = any(jours)) loop x := x + 1; end loop;
      -- passage à une nouvelle semaine : on saute les semaines intermédiaires (« toutes les 2 semaines »)
      if date_trunc('week', x) > date_trunc('week', d) then x := x + 7 * (n - 1); end if;
      return x;
    when 'mois' then
      j := coalesce((r->>'jour')::int, extract(day from d)::int);
      m := (date_trunc('month', d) + make_interval(months => n))::date;
      return m + (least(j, extract(day from (m + interval '1 month - 1 day'))::int) - 1);
    when 'an' then return (d + make_interval(years => n))::date;
    else return null;
  end case;
end $$;

-- Horizon d'une tâche selon son échéance (même règle que le tri automatique).
create or replace function horizon_selon_echeance(e date) returns public.item_horizon
language sql stable set search_path = '' as $$
  select case
    when e is null then null
    when e <= (now() at time zone 'Europe/Paris')::date + 1 then 'maintenant'::public.item_horizon
    when e <= (now() at time zone 'Europe/Paris')::date + 7 then 'bientot'::public.item_horizon
    when e <= (now() at time zone 'Europe/Paris')::date + 30 then 'plus_tard'::public.item_horizon
    else 'un_jour'::public.item_horizon end
$$;

-- ---------- Création de l'occurrence suivante ----------
create or replace function items_recurrence() returns trigger
language plpgsql set search_path = '' as $$
declare
  aujourd_hui date := (now() at time zone 'Europe/Paris')::date;
  base date;
  prochaine date;
  nouvel_id uuid;
  garde int := 0;
begin
  -- Annulation de « fait » : l'occurrence suivante est retirée par items_recurrence_annulee (après).
  if old.etat = 'fait' and new.etat <> 'fait' then
    new.suite_id := null;
    return new;
  end if;

  if new.etat <> 'fait' or old.etat = 'fait' or new.recurrence is null or new.suite_id is not null then
    return new;
  end if;

  if new.recurrence->>'depuis' = 'fait' then
    prochaine := public.echeance_suivante(new.recurrence, aujourd_hui);
  else
    base := coalesce(new.echeance, aujourd_hui);
    prochaine := public.echeance_suivante(new.recurrence, base);
    -- en retard : on saute jusqu'à la prochaine date à venir, sans empiler les occurrences manquées
    while prochaine is not null and prochaine <= aujourd_hui and garde < 1000 loop
      prochaine := public.echeance_suivante(new.recurrence, prochaine);
      garde := garde + 1;
    end loop;
  end if;
  if prochaine is null then return new; end if;

  insert into public.items (texte_brut, titre, details, type, espace, horizon, etat, theme, projet,
                            categorie_id, echeance, echeance_heure, recurrence, source, trie_le)
  values (new.texte_brut, new.titre, new.details, new.type, new.espace,
          coalesce(public.horizon_selon_echeance(prochaine), new.horizon),
          case when new.titre is null then 'a_trier'::public.item_etat else 'a_faire'::public.item_etat end,
          new.theme, new.projet, new.categorie_id, prochaine, new.echeance_heure, new.recurrence,
          'recurrence', new.trie_le)
  returning id into nouvel_id;

  insert into public.rappels (item_id, titre, texte, relatif_min, quand)
  select nouvel_id, r.titre, r.texte, r.relatif_min, public.heure_rappel(prochaine, r.relatif_min)
  from public.rappels r where r.item_id = new.id and r.relatif_min is not null;

  insert into public.journal (item_id, action, avant, apres, par)
  values (nouvel_id, 'cree', jsonb_build_object('repete', new.id),
          jsonb_build_object('echeance', prochaine, 'recurrence', new.recurrence), 'recurrence');

  new.suite_id := nouvel_id;
  return new;
end $$;

create trigger items_recurrence before update of etat on items
  for each row execute function items_recurrence();

-- Annulation de « fait » : on retire l'occurrence suivante si elle n'a pas encore été touchée.
-- (Trigger « après » : en « avant », la suppression entre en conflit avec la ligne en cours de modification.)
create or replace function items_recurrence_annulee() returns trigger
language plpgsql set search_path = '' as $$
begin
  if old.etat = 'fait' and new.etat <> 'fait' and old.suite_id is not null then
    delete from public.items where id = old.suite_id and etat in ('a_trier', 'a_faire');
  end if;
  return null;
end $$;

create trigger items_recurrence_annulee after update of etat on items
  for each row execute function items_recurrence_annulee();

-- Les rappels relatifs suivent l'échéance quand elle change.
create or replace function items_rappels_suivent() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.echeance is distinct from old.echeance then
    if new.echeance is null then
      update public.rappels set relatif_min = null where item_id = new.id and relatif_min is not null;
    else
      update public.rappels set quand = public.heure_rappel(new.echeance, relatif_min)
      where item_id = new.id and relatif_min is not null;
    end if;
  end if;
  return null;
end $$;

create trigger items_rappels_suivent after update of echeance on items
  for each row execute function items_rappels_suivent();
