-- Précisions rattachées et questions simples (appliqué le 2026-11-22, migration questions_rattachement).
-- Quand Claude hésite à rattacher une précision dictée à une tâche ou une note existante, il range l'élément
-- comme un nouvel élément ET pose une question avec 2 à 4 choix. Jérémie répond d'un tap dans l'appli.

create table questions (
  id          uuid primary key default gen_random_uuid(),
  item_id     uuid not null references items(id) on delete cascade, -- l'élément capturé dont il est question
  question    text not null check (length(question) between 1 and 200),
  -- [{"libelle": "Étagères armoire Basile", "cible_id": "<uuid>", "ajout": "22/11 : pas urgent",
  --   "changements": {"horizon": "un_jour", "echeance": "2026-12-12", "echeance_heure": "09:00", "etat": "fait"}},
  --  {"libelle": "Garder à part", "cible_id": null}]
  choix       jsonb not null check (jsonb_typeof(choix) = 'array' and jsonb_array_length(choix) between 2 and 4),
  statut      text not null default 'en_attente' check (statut in ('en_attente', 'repondue', 'expiree')),
  reponse     smallint,
  cree_le     timestamptz not null default now(),
  repondu_le  timestamptz
);
create index questions_attente_idx on questions (statut);
create index questions_item_idx on questions (item_id);
alter table questions enable row level security;
create policy "autorises_questions" on questions for all to authenticated
  using ((select est_autorise())) with check ((select est_autorise()));
alter publication supabase_realtime add table questions;

-- Répondre : si le choix vise une tâche ou note existante, la précision y est ajoutée (détails + changements)
-- et l'élément capturé passe en « fait » avec le titre « Précision ajoutée à : … ». Sinon, rien ne bouge.
create or replace function repondre_question(p_id uuid, p_choix integer)
returns text language plpgsql security invoker set search_path = '' as $$
declare
  q public.questions;
  ch jsonb;
  cible public.items;
  it public.items;
  chg jsonb;
  ajout text;
begin
  select * into q from public.questions where id = p_id and statut = 'en_attente' for update;
  if not found then return 'deja_traitee'; end if;
  ch := q.choix -> p_choix;
  if ch is null then raise exception 'Choix inconnu'; end if;

  if coalesce(ch->>'cible_id', '') = '' then
    update public.questions set statut = 'repondue', reponse = p_choix, repondu_le = now() where id = p_id;
    insert into public.journal (item_id, action, apres, par)
    values (q.item_id, 'question_repondue', jsonb_build_object('question', q.question, 'choix', ch->>'libelle'), 'appli');
    return 'garde';
  end if;

  select * into it from public.items where id = q.item_id for update;
  select * into cible from public.items where id = (ch->>'cible_id')::uuid for update;
  if it.id is null or cible.id is null or cible.etat in ('fait', 'abandonne') or it.etat in ('fait', 'abandonne') then
    update public.questions set statut = 'expiree', repondu_le = now() where id = p_id;
    return 'expiree';
  end if;

  chg := coalesce(ch->'changements', '{}'::jsonb);
  ajout := coalesce(nullif(ch->>'ajout', ''),
                    to_char(it.cree_le at time zone 'Europe/Paris', 'DD/MM') || ' : ' || it.texte_brut);

  update public.items set
    details        = case when coalesce(details, '') = '' then ajout else details || E'\n' || ajout end,
    horizon        = coalesce((chg->>'horizon')::public.item_horizon, horizon),
    echeance       = case when chg ? 'echeance' then (chg->>'echeance')::date else echeance end,
    echeance_heure = case when chg ? 'echeance_heure' then (chg->>'echeance_heure')::time else echeance_heure end,
    etat           = coalesce((chg->>'etat')::public.item_etat, etat),
    fait_le        = case when chg->>'etat' = 'fait' then now() else fait_le end
  where id = cible.id;

  -- Les rappels posés sur l'élément capturé suivent la tâche ou la note à laquelle il est rattaché.
  update public.rappels set item_id = cible.id where item_id = it.id;
  update public.items set etat = 'fait', fait_le = now(),
    titre = left('Précision ajoutée à : ' || coalesce(cible.titre, cible.texte_brut), 200)
  where id = it.id;

  insert into public.journal (item_id, action, avant, apres, par) values
    (cible.id, 'precision',
     jsonb_build_object('details', cible.details, 'horizon', cible.horizon, 'echeance', cible.echeance, 'etat', cible.etat),
     chg || jsonb_build_object('ajout', ajout, 'depuis', it.id), 'appli'),
    (it.id, 'precision', jsonb_build_object('etat', it.etat, 'titre', it.titre),
     jsonb_build_object('etat', 'fait', 'rattache_a', cible.id), 'appli');
  update public.questions set statut = 'repondue', reponse = p_choix, repondu_le = now() where id = p_id;
  return 'rattachee';
end $$;
revoke execute on function repondre_question(uuid, integer) from public, anon;
grant execute on function repondre_question(uuid, integer) to authenticated;
