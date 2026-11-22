# Tâches

Gestionnaire personnel de tâches et de notes. La liste vit dans Supabase et c'est Claude qui la gère
(tri, ordre, mises à jour) à partir des conversations. Cette appli sert à **voir** la liste et à **ajouter vite**.

## L'appli

Web app installable (PWA), sans étape de compilation : HTML, CSS et JavaScript simples, hébergés par GitHub Pages.

- **Liste** : les éléments à trier, puis Maintenant, Bientôt, Plus tard, Un jour, dans l'ordre fixé par Claude.
- **Notes** : notes et idées, avec recherche.
- **Catégories** : filtres en haut ; ⚙ pour en ajouter, renommer, réordonner ou supprimer (aussi depuis l'appli Android, « Gérer mes catégories »). Claude range chaque élément dans l'une d'elles.
- **Ajout** : champ en bas, ou dictée avec le micro. Tout arrive « à trier », Claude le range ensuite.
- **Cocher** une tâche la passe en « fait » (annulable quelques secondes). Toucher une tâche affiche le détail.
- **Raccourcis Android** (appui long sur l'icône) : « Ajouter » et « Dicter ».

Chaque action de l'appli est inscrite dans la table `journal` avec `par = 'appli'`.

## Installer

- **Android, widget sur l'écran d'accueil** : sur le téléphone, télécharger
  [Taches-Android.apk](https://github.com/Jep317/tacheGestion/releases/download/android/Taches-Android.apk) et l'ouvrir.
  Android demande d'autoriser l'installation depuis Chrome (« Paramètres », puis activer « Autoriser cette source »),
  puis « Installer ». Play Protect peut prévenir que l'appli est inconnue : « Installer quand même ». Voir plus bas.
- **Android (Chrome)**, l'appli complète : ouvrir l'adresse de l'appli, menu ⋮, « Ajouter à l'écran d'accueil » / « Installer l'application ».
- **Windows, panneau sur le bureau** (conseillé) : télécharger et lancer
  [Taches-Installation.exe](https://github.com/Jep317/tacheGestion/releases/latest/download/Taches-Installation.exe).
  Windows peut afficher « Windows a protégé votre ordinateur » (l'appli n'est pas signée) :
  « Informations complémentaires », puis « Exécuter quand même ». Voir plus bas.
- **Windows (Chrome ou Edge)**, sinon : ouvrir l'adresse, icône d'installation dans la barre d'adresse.

## Panneau Windows (`bureau/`)

Petite appli Windows (Electron) qui affiche cette même appli web dans un panneau à droite de l'écran.
Rien à recompiler quand l'appli web change : le panneau charge toujours la version en ligne.

- **Ctrl+Alt+T** : afficher / masquer le panneau. **Ctrl+Alt+N** : ouvrir directement le champ d'ajout. **Échap** : masquer.
- Se lance avec Windows (désactivable). Icône près de l'horloge : clic pour afficher, clic droit pour les options
  (toujours au premier plan, démarrage avec Windows, remettre à droite, quitter).
- On déplace le panneau par son en-tête et on le redimensionne par ses bords ; position et taille sont retenues.
- Dictée : le micro de l'appli web ne marche pas dans le panneau ; **Windows+H** dicte dans le champ d'ajout.
- Mises à jour du panneau automatiques. Pour en publier une : augmenter `version` dans `bureau/package.json` ;
  l'action GitHub « Appli Windows » construit l'installateur et le met dans les Releases.

## Appli Android et widget (`android/`)

Petite appli Android native (Kotlin, sans bibliothèque) qui pose un **widget** sur l'écran d'accueil :

- La liste : À trier, Maintenant, Bientôt, puis le nombre d'éléments Plus tard / Un jour.
- Onglets **Tâches / Notes** en haut du widget : l’onglet Notes montre les notes et idées rangées par projet.
- **Priorités** : toucher une tâche, puis « En tête », « Monter », « Descendre » ou un autre horizon. Inscrit au journal (`deplace`, par `jeremie`) comme le glisser-déposer de l’appli web, pour que Claude le respecte.
- **Filtre** (ligne sous les onglets) : une catégorie et/ou un projet, retenus pour chaque widget posé.
- **+** : ajout rapide au clavier. **Micro** : dictée Google en français. Tout arrive « à trier » (`source` = `widget` ou `vocal`).
- Toucher une tâche : son détail, avec « ✓ Fait » et « En cours ». « Tâches » en haut ouvre l'appli web complète.
- Mise à jour toutes les 30 minutes, après chaque ajout ou changement, et avec ↻. Garde la dernière liste hors ligne.
- Connexion une seule fois dans l'appli (même compte que l'appli web) ; le jeton est renouvelé tout seul.

Construite par l'action GitHub « Appli Android » à chaque changement de `android/` sur main ; l'APK remplace celui de la
version `android` (marquée « préversion » pour ne pas gêner les mises à jour du panneau Windows), adresse fixe ci-dessus.
Installer le nouvel APK par-dessus l'ancien suffit : la clé de signature (`android/signature/`) est toujours la même.
Elle est dans le dépôt public, ce qui est acceptable pour une appli personnelle installée à la main, pas pour le Play Store.

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
| `bureau/` | panneau Windows (Electron), construit par `.github/workflows/appli-windows.yml` |
| `android/` | appli Android et widget, construits par `.github/workflows/appli-android.yml` |

## Essayer en local

```
python3 -m http.server 8000
```

puis ouvrir http://localhost:8000.
