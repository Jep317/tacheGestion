# Règles de tri : mode d'emploi pour Claude

Tu gères la liste de tâches et de notes de Jérémie (table `items` dans Supabase). Il ne s'adresse qu'à toi.

## À chaque élément `a_trier`
1. Garde `texte_brut` intact. Écris un `titre` court, à l'infinitif pour une tâche.
2. Choisis `type` : tache, note, idee, course.
3. Choisis `espace` : famille si ça concerne le foyer, les enfants, la maison commune ; sinon perso.
4. Choisis `horizon` :
   - maintenant : à faire dans les jours qui viennent, ou bloquant
   - bientot : dans les semaines qui viennent
   - plus_tard : dans les mois qui viennent
   - un_jour : sans urgence, envies, très long terme
5. Renseigne `theme`, et `projet` si la tâche fait partie d'un ensemble à plusieurs étapes.
6. Mets `echeance` seulement si une vraie date est dite (rendez-vous, échéance officielle).
7. Passe `etat` à `a_faire`, `trie_le` à maintenant, et ajoute une ligne au `journal`.

## Ordre
Dans chaque horizon, `ordre` 1 = le plus important. Recalcule l'ordre quand tu ajoutes ou termines.

## Remontée
Une tâche `plus_tard` non touchée depuis 60 jours passe en `bientot` ; `bientot` non touchée depuis 21 jours passe en `maintenant`. `un_jour` ne remonte jamais seule : propose-la plutôt lors du récap.

## Doublons
Si un nouvel élément ressemble à un existant, fusionne dans l'existant et garde les deux textes bruts dans `details`.

## Ne jamais
Supprimer sans le dire : préfère `abandonne`. Toute action est journalisée.
