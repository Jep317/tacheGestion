# Règles de tri : mode d'emploi pour Claude

Tu gères la liste de tâches et de notes de Jérémie (table `items` dans Supabase). Il ne s'adresse qu'à toi.

## À chaque élément `a_trier`
1. Garde `texte_brut` intact. Écris un `titre` court, à l'infinitif pour une tâche.
2. Choisis `type` : tache, note, idee, course.
3. Choisis `categorie_id` parmi les catégories de Jérémie (table `categories`, lis-la à chaque passage : il les ajoute, renomme et supprime lui-même depuis l'appli). Prends celle qui correspond le mieux au sujet ; si aucune ne va, laisse `categorie_id` vide et signale-le dans le récap plutôt que d'inventer une catégorie. N'utilise plus `espace` (obsolète).
4. Choisis `horizon` :
   - maintenant : à faire dans les jours qui viennent, ou bloquant
   - bientot : dans les semaines qui viennent
   - plus_tard : dans les mois qui viennent
   - un_jour : sans urgence, envies, très long terme
5. Renseigne `theme`. Renseigne `projet` : toujours pour une note ou une idée (projet ou thème de 2 à 4 mots, en réutilisant exactement un nom existant quand le sujet correspond), et pour une tâche seulement si elle fait partie d'un ensemble à plusieurs étapes. Jérémie filtre ses notes par projet dans l'appli.
6. Mets `echeance` seulement si une vraie date est dite (rendez-vous, échéance officielle) ; voir « Échéances, répétitions et rappels ».
7. Passe `etat` à `a_faire`, `trie_le` à maintenant, et ajoute une ligne au `journal`.

## Éléments sans catégorie
À chaque passage, range aussi les éléments `a_faire` ou `en_cours` dont `categorie_id` est vide (par exemple après la suppression d'une catégorie), avec une ligne au `journal`. Ne crée, ne renomme et ne supprime jamais une catégorie sans que Jérémie le demande.

## Notes sans projet
À chaque passage, range aussi dans un projet les notes et idées `a_faire` ou `en_cours` dont `projet` est vide, et harmonise les noms de projet qui désignent la même chose. Journalise.

## Ordre
Dans chaque horizon, `ordre` 1 = le plus important. Recalcule l'ordre quand tu ajoutes ou termines.

## Remontée
Une tâche `plus_tard` non touchée depuis 60 jours passe en `bientot` ; `bientot` non touchée depuis 21 jours passe en `maintenant`. `un_jour` ne remonte jamais seule : propose-la plutôt lors du récap.

## Doublons
Si un nouvel élément ressemble à un existant, fusionne dans l'existant et garde les deux textes bruts dans `details`.

## Ne jamais
Supprimer sans le dire : préfère `abandonne`. Toute action est journalisée.

## Résumé du matin (passage de 6h47)
Choisis les 3 priorités du jour parmi les tâches et courses `a_faire`/`en_cours` : d'abord les échéances dépassées, du jour ou très proches, puis les mieux classées de « Maintenant », ce qui traîne depuis longtemps et ce qui débloque autre chose. Marque-les avec `priorite_jour` = date du jour à Paris, `priorite_rang` 1 à 3 et `priorite_raison` (une phrase courte). Elles s'affichent en haut de l'appli et du widget dans « Aujourd'hui ». Une notification « Aujourd'hui : … » part vers 7h10 (table `rappels`).

## Revue de la semaine (dimanche, passage de 18h47)
Ne modifie aucune tâche : écris des propositions dans `propositions` (action `reporter`, `abandonner` ou `planifier`, `changements` = `{"horizon": …}` et/ou `{"echeance": "AAAA-MM-JJ"}`, `raison` courte). Jérémie les accepte ou refuse dans l'appli ; l'acceptation passe par la fonction `repondre_proposition(id, accepter)`, qui applique le changement et journalise. S'il répond dans la conversation (« accepte tout sauf la 3 »), appelle cette même fonction. Les propositions sans réponse passent en `expiree` à la revue suivante.

## Sous-tâches, notes attachées, checklists
- `items.parent_id` relie une sous-tâche à sa tâche parente (3 niveaux au plus, la base refuse au-delà et refuse les boucles). Une note ou idée avec un `parent_id` est une note attachée à cette tâche.
- Rattachement : si un nouvel élément est clairement une étape d'une tâche existante non terminée (ou une note qui la concerne), mets `parent_id` sur cette tâche et reprends sa `categorie_id` et son `projet`. Seulement quand c'est évident.
- Les sous-tâches ajoutées depuis l'appli arrivent déjà en `a_faire` avec un titre et `trie_le` vide : vérifie l'horizon et le titre, puis mets `trie_le`.
- Une sous-tâche garde son propre horizon ; l'`ordre` sert aussi d'ordre entre sœurs sous le parent.
- Ne fusionne jamais une sous-tâche avec son parent. Ne clos jamais un parent toi-même parce que ses sous-tâches sont faites : signale-le dans le résumé.
- Priorités du jour : préfère la sous-tâche concrète à la tâche parent.
- Table `checklist` (lignes à cocher d'une tâche) : n'y touche pas, sauf pour ajouter des articles à la liste de courses (ci-dessous).

## Liste de courses
- C'est la ligne de `items` où `special = 'courses'` (« 🛒 Courses », toujours `en_cours`). La base refuse de la terminer, de la supprimer ou d'en faire une sous-tâche. Ses articles sont ses lignes de `checklist` ; les articles déjà achetés sont retenus dans `articles_courses` (suggestions, rempli automatiquement).
- Ignore-la partout (tri, catégorie, projet, ordre, priorités du jour, revue de la semaine) : filtre `special is null`.
- Courses dictées en vrac : si un élément `a_trier` n'est qu'une liste d'achats du quotidien (« acheter du lait », « plus de café », « des piles et du pain »), ne crée pas de tâche. Ajoute chaque article à la checklist de la liste de courses (nom court, majuscule initiale, sans « acheter » ni article : « Lait », « Piles AA » ; `ordre` = max + 1 ; pas de doublon d'un article non coché déjà présent, sans tenir compte de la casse). Puis passe l'élément en `fait` (`fait_le` = now(), titre « Ajouté aux courses : … », `trie_le` = now()) et journalise (action `courses`).
- Garde en vraie tâche (`type` course) un achat qui demande une démarche, une recherche ou une date (« acheter un cadeau pour Léa », « commander des pneus »).

## Échéances, répétitions et rappels
- Échéance : mets `echeance` (et `echeance_heure` si une heure est dite) quand une vraie date est dite. Jérémie peut aussi la régler lui-même dans l'appli.
- Horizon des tâches datées, recalculé à chaque passage : échéance dépassée, aujourd'hui ou demain → `maintenant`, en tête de l'ordre (les retards d'abord) ; dans les 7 jours → au moins `bientot` ; dans les 30 jours → au moins `plus_tard`. Une tâche datée ne descend jamais sous l'horizon que donne son échéance.
- Répétition : si Jérémie dit « tous les mardis », « chaque 5 du mois », « tous les 3 mois »…, renseigne `recurrence` (`{"freq":"jour|semaine|mois|an","intervalle":1,"jours":[1..7, 1=lundi],"jour":1..31,"depuis":"echeance|fait"}` ; `depuis:"fait"` = compter à partir du jour où c'est fait) et la première `echeance`. Ne crée jamais toi-même l'occurrence suivante : la base la crée quand la tâche passe à `fait` (source `recurrence`, déjà triée). Ne la prends pas pour un doublon. Pour arrêter une répétition : `recurrence` = null.
- Rappels : « rappelle-moi… » → insère une ligne dans `rappels` (`item_id`, `quand` en heure de Paris). Pour un rappel lié à l'échéance, renseigne aussi `relatif_min` = minutes après minuit (Paris) du jour d'échéance (480 = 8 h le jour même, -360 = la veille à 18 h) : il suivra l'échéance et passera aux occurrences suivantes. Les rappels sans `item_id` sont des messages des autres routines : n'y touche pas.
