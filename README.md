# Tâches

Gestionnaire personnel de tâches et de notes. La liste vit dans Supabase et c'est Claude qui la gère
(tri, ordre, mises à jour) à partir des conversations. Cette appli sert à **voir** la liste et à **ajouter vite**.

## L'appli

Web app installable (PWA), sans étape de compilation : HTML, CSS et JavaScript simples, hébergés par GitHub Pages.

- **Liste** : les éléments à trier, puis Maintenant, Bientôt, Plus tard, Un jour, dans l'ordre fixé par Claude.
- **Notes** : notes et idées, avec recherche.
- **Perso / Famille** : filtre en haut à droite.
- **Ajout** : champ en bas, ou dictée avec le micro. Tout arrive « à trier », Claude le range ensuite.
- **Cocher** une tâche la passe en « fait » (annulable quelques secondes). Toucher une tâche affiche le détail.
- **Raccourcis Android** (appui long sur l'icône) : « Ajouter » et « Dicter ».

Chaque action de l'appli est inscrite dans la table `journal` avec `par = 'appli'`.

## Installer

- **Android (Chrome)** : ouvrir l'adresse de l'appli, menu ⋮, « Ajouter à l'écran d'accueil » / « Installer l'application ».
- **Windows (Chrome ou Edge)** : ouvrir l'adresse, icône d'installation dans la barre d'adresse.

## Connexion et sécurité

- Compte e-mail + mot de passe (Supabase Auth). Première fois : « Créer mon compte », puis cliquer le lien reçu par e-mail.
- Seules les adresses présentes dans la table `autorises` voient les données (règles RLS, voir `supabase/02_acces_reserve.sql`).
  Un compte créé par quelqu'un d'autre ne voit rien.
- La clé dans `config.js` est la clé **publique** de Supabase, faite pour être dans le code d'une appli.

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `index.html`, `style.css`, `app.js` | l'appli |
| `config.js` | adresse du projet Supabase et clé publique |
| `manifest.webmanifest`, `sw.js`, `icons/` | installation comme appli (PWA) |
| `vendor/supabase-js-2.45.4.js` | bibliothèque Supabase, embarquée pour ne dépendre d'aucun CDN |
| `supabase/` | schéma de la base et règles de tri suivies par Claude |

## Essayer en local

```
python3 -m http.server 8000
```

puis ouvrir http://localhost:8000.
