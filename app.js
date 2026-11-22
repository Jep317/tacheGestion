// Appli Tâches : affichage et capture rapide. C'est Claude qui trie, ordonne et met à jour la liste ;
// l'appli ne fait qu'ajouter des éléments « à trier » et cocher ce qui est fait.
import { createClient } from './vendor/supabase-js-2.45.4.js';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = (s) => document.querySelector(s);

const HORIZONS = [
  { cle: 'maintenant', nom: 'Maintenant', ouvert: true },
  { cle: 'bientot', nom: 'Bientôt', ouvert: true },
  { cle: 'plus_tard', nom: 'Plus tard', ouvert: false },
  { cle: 'un_jour', nom: 'Un jour', ouvert: false },
];
const TYPES_LISTE = ['tache', 'course'];
const TYPES_NOTES = ['note', 'idee'];

// Mode « bureau » (?bureau=1) : la liste seule, en colonne à droite, pour servir de fond d'écran
// (par ex. avec Lively Wallpaper). Pas d'ajout ni d'onglets ; les horizons lointains sont repliés.
const BUREAU = new URLSearchParams(location.search).has('bureau');
if (BUREAU) document.body.classList.add('bureau');

const etat = {
  items: [],
  rappels: [],               // rappels à venir (table rappels), liés à un élément ou libres
  vue: 'liste',
  categories: [],            // catégories choisies par Jérémie (table categories)
  filtre: lire('filtre') || 'tout', // 'tout', 'aucune' ou l'id d'une catégorie
  projet: lire('projet') || '',      // '' = tous les projets, '-' = sans projet, sinon le nom du projet (rangé par Claude)
  recherche: '',
  propositions: [],
  questions: [],             // questions simples de Claude (« c'est dans quelle tâche ? »)          // revue de la semaine : propositions de Claude en attente de réponse
  ouverts: new Set(),        // éléments dont on affiche le détail
  reglages: new Set(),       // fiches dont le panneau « Réglages » est déplié
  ajouts: new Map(),         // fiche -> champ d'ajout affiché ('sous', 'check' ou 'note')
  sections: BUREAU ? {} : JSON.parse(lire('sections') || '{}'),
  liens: [],                 // tous les enfants (faits compris) : { id, parent_id, etat, type }, pour la progression « 2/5 »
  horsListe: new Map(),      // parents déjà faits, pour afficher « ↳ Garage » sous un enfant encore ouvert
  checklist: new Map(),      // item_id -> lignes de checklist triées
  replies: new Set(JSON.parse(lire('replies') || '[]')), // tâches dont on a replié les sous-tâches
  courses: null,             // la tâche spéciale « 🛒 Courses » (items.special = 'courses'), hors des listes
  articles: [],              // articles déjà achetés (table articles_courses), pour les suggestions
};

// ---------- utilitaires ----------
function lire(cle) { try { return localStorage.getItem('taches.' + cle); } catch { return null; } }
function ecrire(cle, v) { try { localStorage.setItem('taches.' + cle, v); } catch { /* navigation privée */ } }
function echap(t) {
  return String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Date du jour à Paris (AAAA-MM-JJ), celle qu'utilise Claude pour les priorités du jour.
function aujourdhui() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date()); }
function dateCourte(d) {
  return new Date(d + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}
let minuteurToast;
function toast(texte, action) {
  const el = $('#toast');
  el.innerHTML = `<span>${echap(texte)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.textContent = action.nom;
    b.onclick = () => { el.hidden = true; action.faire(); };
    el.append(b);
  }
  el.hidden = false;
  clearTimeout(minuteurToast);
  minuteurToast = setTimeout(() => (el.hidden = true), action ? 6000 : 3000);
}

// ---------- connexion ----------
async function demarrer() {
  const { data } = await sb.auth.getSession();
  afficherSelonSession(data.session);
  sb.auth.onAuthStateChange((_e, session) => afficherSelonSession(session));
}

let abonnement = null;
function afficherSelonSession(session) {
  const connecte = !!session;
  $('#ecran-connexion').hidden = connecte;
  $('#ecran-appli').hidden = !connecte;
  if (connecte && !abonnement) {
    charger();
    abonnement = sb.channel('items')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'items' }, chargerBientot)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'categories' }, chargerBientot)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rappels' }, chargerBientot)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'checklist' }, chargerBientot)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'propositions' }, chargerBientot)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'questions' }, chargerBientot)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'articles_courses' }, chargerBientot)
      .subscribe();
    actionsDeLancement();
  } else if (!connecte && abonnement) {
    sb.removeChannel(abonnement);
    abonnement = null;
  }
}

$('#form-connexion').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('#msg-connexion');
  msg.textContent = 'Connexion…';
  const { error } = await sb.auth.signInWithPassword({ email: $('#email').value.trim(), password: $('#mdp').value });
  msg.textContent = error ? traduireErreur(error) : '';
});

$('#btn-inscription').addEventListener('click', async () => {
  const msg = $('#msg-connexion');
  const email = $('#email').value.trim();
  const password = $('#mdp').value;
  if (!email || password.length < 8) { msg.textContent = 'Saisis ton e-mail et un mot de passe d\'au moins 8 caractères.'; return; }
  msg.textContent = 'Création du compte…';
  const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
  if (error) msg.textContent = traduireErreur(error);
  else if (!data.session) msg.textContent = 'Compte créé. Clique sur le lien reçu par e-mail, puis reviens te connecter ici.';
});

$('#btn-deconnexion').addEventListener('click', () => sb.auth.signOut());

function traduireErreur(err) {
  const m = err.message || '';
  if (/invalid login/i.test(m)) return 'E-mail ou mot de passe incorrect.';
  if (/not confirmed/i.test(m)) return 'Confirme d\'abord ton adresse avec le lien reçu par e-mail.';
  if (/already registered/i.test(m)) return 'Ce compte existe déjà : connecte-toi.';
  return 'Erreur : ' + m;
}

// ---------- données ----------
// Plusieurs changements d'affilée (réordonner, renommer un projet) : un seul rechargement.
let minuteurCharger;
function chargerBientot() { clearTimeout(minuteurCharger); minuteurCharger = setTimeout(charger, 350); }

async function charger() {
  // Pendant un glisser-déposer, on ne redessine pas la liste sous le doigt : on recharge au lâcher.
  if (glisse) { glisse.recharger = true; return; }
  const [items, cats, liens, lignes, props, articles, rappels, questions] = await Promise.all([
    sb.from('items')
      .select('id, texte_brut, titre, details, type, categorie_id, horizon, etat, theme, projet, ordre, echeance, echeance_heure, recurrence, cree_le, parent_id, priorite_jour, priorite_rang, priorite_raison, special')
      .in('etat', ['a_trier', 'a_faire', 'en_cours'])
      .order('ordre', { ascending: true, nullsFirst: false })
      .order('cree_le', { ascending: true }),
    sb.from('categories').select('id, nom, ordre').order('ordre').order('nom'),
    sb.from('items').select('id, parent_id, etat, type').not('parent_id', 'is', null),
    sb.from('checklist').select('id, item_id, texte, coche, ordre, cree_le').order('ordre').order('cree_le'),
    sb.from('propositions').select('id, item_id, action, changements, raison, revue')
      .eq('statut', 'en_attente').order('cree_le'),
    sb.from('articles_courses').select('nom, fois, dernier').order('fois', { ascending: false }).order('dernier', { ascending: false }).limit(300),
    sb.from('rappels').select('id, item_id, titre, texte, quand, relatif_min')
      .gte('quand', new Date(Date.now() - 3600e3).toISOString()).order('quand'),
    sb.from('questions').select('id, item_id, question, choix').eq('statut', 'en_attente').order('cree_le'),
  ]);
  const error = items.error || cats.error || liens.error || lignes.error || rappels.error;
  if (error) { toast('Impossible de charger la liste : ' + error.message); return; }
  // La liste de courses est une tâche à part : elle n'apparaît que dans l'onglet « Courses ».
  etat.courses = items.data.find((i) => i.special === 'courses') || null;
  etat.items = items.data.filter((i) => !i.special);
  etat.articles = articles.data || [];
  etat.categories = cats.data;
  etat.rappels = rappels.data;
  planifierNotifications();
  etat.liens = liens.data;
  etat.checklist = new Map();
  for (const l of lignes.data) {
    if (!etat.checklist.has(l.item_id)) etat.checklist.set(l.item_id, []);
    etat.checklist.get(l.item_id).push(l);
  }
  // Parents déjà faits (ou abandonnés) d'éléments encore ouverts : juste leur titre.
  const actifs = new Set(etat.items.map((i) => i.id));
  const manquants = [...new Set(etat.items.map((i) => i.parent_id).filter((p) => p && !actifs.has(p)))];
  etat.horsListe = new Map();
  if (manquants.length) {
    const { data } = await sb.from('items').select('id, titre, texte_brut, parent_id, etat, type').in('id', manquants);
    for (const p of data || []) etat.horsListe.set(p.id, p);
  }
  // Les propositions ne sont pas bloquantes : si la table manque, on affiche quand même la liste.
  etat.propositions = (props.data || []).filter((p) => etat.items.some((i) => i.id === p.item_id));
  etat.questions = questions.data || []; // non bloquant non plus
  if (etat.filtre !== 'tout' && etat.filtre !== 'aucune' && !categorie(etat.filtre)) etat.filtre = 'tout';
  afficherFiltres();
  afficher();
  if (!$('#dlg-categories').hidden) afficherGestion();
  if (!$('#dlg-projets').hidden) afficherGestionProjets();
  if (!$('#dlg-revue').hidden) afficherRevue();
  if (revueDemandee) { revueDemandee = false; if (etat.propositions.length) ouvrirRevue(); }
  if (itemDemande) montrerItem(itemDemande);
}

async function ajouter(texte, source) {
  texte = texte.trim();
  if (!texte) return false;
  const { data, error } = await sb.from('items').insert({ texte_brut: texte, source }).select('id').single();
  if (error) { toast('Ajout impossible : ' + error.message); return false; }
  await sb.from('journal').insert({ item_id: data.id, action: 'cree', apres: { texte_brut: texte, source }, par: 'appli' });
  toast('Ajouté. Claude le rangera.');
  charger();
  return true;
}

async function changerEtat(item, nouvelEtat, { recharger = true } = {}) {
  const avant = { etat: item.etat };
  const maj = { etat: nouvelEtat, fait_le: nouvelEtat === 'fait' ? new Date().toISOString() : null };
  const { error } = await sb.from('items').update(maj).eq('id', item.id);
  if (error) { toast('Modification impossible : ' + error.message); return; }
  await sb.from('journal').insert({
    item_id: item.id, action: nouvelEtat === 'fait' ? 'termine' : 'modifie', avant, apres: maj, par: 'appli',
  });
  if (recharger) charger();
}

async function changerCategorie(item, categorieId) {
  const avant = { categorie_id: item.categorie_id };
  const apres = { categorie_id: categorieId || null };
  const { error } = await sb.from('items').update(apres).eq('id', item.id);
  if (error) { toast('Modification impossible : ' + error.message); return; }
  await sb.from('journal').insert({ item_id: item.id, action: 'modifie', avant, apres, par: 'appli' });
  charger();
}

// ---------- sous-tâches, notes attachées ----------
const TYPES_TACHE = ['tache', 'course'];
const NIVEAUX_MAX = 3; // une tâche, ses sous-tâches, et leurs sous-tâches
function trouver(id) { return etat.items.find((i) => i.id === id) || etat.horsListe.get(id); }
function libelle(i) { return i ? (i.titre || i.texte_brut) : ''; }
function estTache(i) { return TYPES_TACHE.includes(i.type); }
/** Sous-tâches encore ouvertes, dans l'ordre fixé par Claude. */
function sousTaches(id) { return etat.items.filter((i) => i.parent_id === id && estTache(i)); }
/** Notes et idées attachées à une tâche. */
function notesDe(id) { return etat.items.filter((i) => i.parent_id === id && TYPES_NOTES.includes(i.type)); }
/** Progression d'une tâche parent : sous-tâches faites / total (les abandonnées ne comptent pas). */
function progression(id) {
  const enfants = etat.liens.filter((l) => l.parent_id === id && TYPES_TACHE.includes(l.type) && l.etat !== 'abandonne');
  return { faits: enfants.filter((l) => l.etat === 'fait').length, total: enfants.length };
}
/** Nombre d'ancêtres (0 pour une tâche principale). */
function profondeur(i) {
  let n = 0;
  for (let p = i && trouver(i.parent_id); p && n < 5; p = trouver(p.parent_id)) n++;
  return n;
}
/** Niveaux de sous-tâches sous une tâche (0 si elle n'en a pas). */
function hauteur(id, n = 0) {
  if (n > 5) return 0;
  return Math.max(0, ...sousTaches(id).map((c) => 1 + hauteur(c.id, n + 1)));
}
function descendants(id) {
  const res = [];
  for (const c of sousTaches(id)) res.push(c, ...descendants(c.id));
  return res;
}
const RANG = { maintenant: 0, bientot: 1, plus_tard: 2, un_jour: 3 };
/** Une sous-tâche s'affiche aussi seule dans son horizon quand elle est plus urgente que son parent,
 *  ou quand son parent n'est pas visible (fait, autre catégorie, autre projet). */
function visibleSeule(i, visibles) {
  if (!i.parent_id) return true;
  const p = etat.items.find((x) => x.id === i.parent_id);
  if (!p || !visibles.has(p.id) || p.etat === 'a_trier') return true;
  return i.horizon && p.horizon && RANG[i.horizon] < RANG[p.horizon];
}

async function journal(item_id, action, avant, apres) {
  await sb.from('journal').insert({ item_id, action, avant, apres, par: 'appli' });
}

/** Marque une tâche faite. Si elle a des sous-tâches ouvertes, propose de les clore aussi ;
 *  si c'était la dernière sous-tâche ouverte de son parent, propose de clore le parent. */
/** Petite fenêtre de confirmation (confirm() est bloqué ou laid selon les appareils). Résout true / false. */
function demander(titre, texte, oui = 'Oui', non = 'Annuler') {
  return new Promise((resoudre) => {
    const voile = document.createElement('div');
    voile.className = 'voile';
    voile.innerHTML = `<div class="fenetre confirmer" role="alertdialog" aria-modal="true" aria-labelledby="titre-confirmer">
      <h2 id="titre-confirmer">${echap(titre)}</h2>
      ${texte ? `<p class="texte-confirmer">${echap(texte)}</p>` : ''}
      <p class="fin"><button type="button" class="lien" data-non>${echap(non)}</button>
      <button type="button" class="principal" data-oui>${echap(oui)}</button></p></div>`;
    const finir = (r) => { voile.remove(); document.removeEventListener('keydown', clavier, true); resoudre(r); };
    const clavier = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); finir(false); }
      else if (e.key === 'Enter') { e.preventDefault(); finir(true); }
    };
    voile.addEventListener('click', (e) => {
      if (e.target === voile || e.target.closest('[data-non]')) finir(false);
      else if (e.target.closest('[data-oui]')) finir(true);
    });
    document.addEventListener('keydown', clavier, true);
    document.body.append(voile);
    voile.querySelector('[data-oui]').focus();
  });
}

async function terminer(item, { sansConfirmer = false } = {}) {
  const ouverts = descendants(item.id);
  if (!sansConfirmer || ouverts.length) {
    const ok = await demander('Terminer cette tâche ?', ouverts.length
      ? `« ${libelle(item)} » a encore ${ouverts.length} sous-tâche${ouverts.length > 1 ? 's' : ''} pas finie${ouverts.length > 1 ? 's' : ''} : tout sera marqué comme fait.`
      : libelle(item), 'Terminer');
    if (!ok) return;
  }
  const touches = [item, ...ouverts];
  const anciens = touches.map((t) => [t, t.etat]);
  await Promise.all(touches.map((t) => changerEtat(t, 'fait', { recharger: false })));
  await charger();
  const parent = etat.items.find((p) => p.id === item.parent_id);
  if (parent && !sousTaches(parent.id).length) {
    toast(`Toutes les sous-tâches de « ${libelle(parent)} » sont faites.`, { nom: 'Clore la tâche', faire: () => terminer(parent, { sansConfirmer: true }) });
  } else {
    toast('Fait : ' + libelle(item) + (ouverts.length ? ` (+ ${ouverts.length})` : ''), {
      nom: 'Annuler',
      faire: async () => { await Promise.all(anciens.map(([t, e]) => changerEtat({ ...t, etat: 'fait' }, e, { recharger: false }))); charger(); },
    });
  }
}

async function ajouterSousTache(parent, texte) {
  texte = texte.trim();
  if (!texte) return false;
  if (profondeur(parent) + 1 >= NIVEAUX_MAX) { toast('Trois niveaux de sous-tâches au maximum.'); return false; }
  const ligne = {
    texte_brut: texte, titre: texte, type: 'tache', etat: 'a_faire', source: 'app', parent_id: parent.id,
    horizon: parent.horizon || 'bientot', categorie_id: parent.categorie_id, projet: parent.projet,
  };
  const { data, error } = await sb.from('items').insert(ligne).select('id').single();
  if (error) { toast('Ajout impossible : ' + error.message); return false; }
  await journal(data.id, 'cree', null, ligne);
  etat.replies.delete(parent.id);
  ecrireReplies();
  await charger();
  return true;
}

async function attacherNote(parent, texte) {
  texte = texte.trim();
  if (!texte) return false;
  const premiere = texte.split('\n')[0].trim();
  const titre = premiere.length > 80 ? premiere.slice(0, 77) + '…' : premiere;
  const ligne = {
    texte_brut: texte, titre, details: texte === titre ? null : texte, type: 'note', etat: 'a_faire', source: 'app',
    parent_id: parent.id, categorie_id: parent.categorie_id, projet: parent.projet,
  };
  const { data, error } = await sb.from('items').insert(ligne).select('id').single();
  if (error) { toast('Ajout impossible : ' + error.message); return false; }
  await journal(data.id, 'cree', null, ligne);
  await charger();
  return true;
}

async function changerParent(item, parentId) {
  const avant = { parent_id: item.parent_id };
  const apres = { parent_id: parentId || null };
  const { error } = await sb.from('items').update(apres).eq('id', item.id);
  if (error) { toast('Impossible : ' + error.message); charger(); return; }
  await journal(item.id, 'modifie', avant, apres);
  if (parentId) { etat.replies.delete(parentId); ecrireReplies(); }
  charger();
}

/** Tâches auxquelles on peut rattacher cet élément sans dépasser 3 niveaux ni créer de boucle. */
function parentsPossibles(item) {
  const exclus = new Set([item.id, ...descendants(item.id).map((d) => d.id)]);
  const h = estTache(item) ? hauteur(item.id) : -1;
  return etat.items
    .filter((p) => estTache(p) && p.etat !== 'a_trier' && !exclus.has(p.id) && profondeur(p) + 1 + h < NIVEAUX_MAX)
    .sort((a, b) => libelle(a).localeCompare(libelle(b), 'fr'));
}

function ecrireReplies() { ecrire('replies', JSON.stringify([...etat.replies])); }

/** Va à une tâche (depuis une note attachée) : onglet Liste, branches dépliées, fiche ouverte. */
function allerA(id) {
  const cible = etat.items.find((i) => i.id === id);
  if (!cible) { toast('Cette tâche est déjà faite.'); return; }
  for (let p = trouver(cible.parent_id); p; p = trouver(p.parent_id)) etat.replies.delete(p.id);
  ecrireReplies();
  etat.ouverts.add(id);
  if (etat.projet && cleProjet(cible.projet) !== etat.projet) { etat.projet = ''; ecrire('projet', ''); }
  if (!filtreCategorie(cible)) { etat.filtre = 'tout'; ecrire('filtre', 'tout'); afficherFiltres(); }
  document.querySelector('[data-vue="liste"]').click();
  const el = document.querySelector(`#vue-liste [data-id="${id}"]`);
  if (el) {
    el.closest('details')?.setAttribute('open', '');
    el.scrollIntoView({ block: 'center' });
    el.classList.add('eclaire');
    setTimeout(() => el.classList.remove('eclaire'), 1500);
  }
}

// ---------- checklist (réutilisable : table checklist, une ligne = { id, item_id, texte, coche, ordre }) ----------
function lignesChecklist(itemId) { return etat.checklist.get(itemId) || []; }

/** Découpe un texte collé ou dicté en lignes : une par retour à la ligne, point-virgule ou virgule. */
function decouperLignes(texte) {
  return texte.split(/[\n;,]+/).map((t) => t.trim()).filter(Boolean).map((t) => t.slice(0, 200));
}

async function ajouterLignesChecklist(itemId, texte) {
  const textes = decouperLignes(texte);
  if (!textes.length) return false;
  const depart = Math.max(0, ...lignesChecklist(itemId).map((l) => l.ordre)) + 1;
  const { error } = await sb.from('checklist').insert(textes.map((t, n) => ({ item_id: itemId, texte: t, ordre: depart + n })));
  if (error) { toast('Ajout impossible : ' + error.message); return false; }
  await charger();
  return true;
}

async function cocherLigne(ligneId, coche) {
  for (const lignes of etat.checklist.values()) {
    const l = lignes.find((x) => x.id === ligneId);
    if (l) l.coche = coche;
  }
  afficher(); // tout de suite, sans attendre le serveur
  const { error } = await sb.from('checklist').update({ coche }).eq('id', ligneId);
  if (error) { toast('Modification impossible : ' + error.message); charger(); }
}

// ---------- liste de courses (tâche spéciale, ses articles = lignes de sa checklist) ----------
const DELAI_ACHETE = 4000; // un article coché disparaît au bout de 4 secondes (le temps de se rattraper)
const effacements = new Map(); // ligne id -> minuteur
function articlesCourses() { return etat.courses ? lignesChecklist(etat.courses.id) : []; }

/** Programme la disparition des articles cochés (y compris ceux cochés sur un autre appareil). */
function programmerEffacements() {
  for (const l of articlesCourses()) {
    if (l.coche && !effacements.has(l.id)) {
      effacements.set(l.id, setTimeout(async () => {
        effacements.delete(l.id);
        const encore = articlesCourses().find((x) => x.id === l.id);
        if (!encore || !encore.coche) return;
        await sb.from('checklist').delete().eq('id', l.id).eq('coche', true);
        charger();
      }, DELAI_ACHETE));
    } else if (!l.coche && effacements.has(l.id)) {
      clearTimeout(effacements.get(l.id));
      effacements.delete(l.id);
    }
  }
}

async function ajouterArticles(texte, vocal = false) {
  if (!etat.courses) { toast('Liste de courses introuvable.'); return false; }
  // En dictée, « du lait et du pain » donne deux articles.
  if (vocal) texte = texte.replace(/\s+(et|puis)\s+/gi, ',');
  const deja = new Set(articlesCourses().filter((l) => !l.coche).map((l) => l.texte.toLowerCase()));
  const nouveaux = decouperLignes(texte).filter((t) => !deja.has(t.toLowerCase()));
  if (!nouveaux.length) { toast('Déjà dans la liste.'); return true; }
  return ajouterLignesChecklist(etat.courses.id, nouveaux.join('\n'));
}

function afficherCourses() {
  const lignes = articlesCourses();
  const restants = lignes.filter((l) => !l.coche).length;
  $('#liste-courses').innerHTML = lignes.length
    ? lignes.map((l) => `<li class="${l.coche ? 'coche' : ''}"><label>
        <input type="checkbox" data-check-coche="${l.id}" ${l.coche ? 'checked' : ''}>
        <span>${echap(l.texte)}</span></label></li>`).join('')
    : '<li class="vide">La liste est vide. Ajoute un article en bas.</li>';
  const onglet = document.querySelector('[data-vue="courses"]');
  if (onglet) onglet.textContent = '🛒 Courses' + (restants ? ` ${restants}` : '');
  afficherSuggestions();
  programmerEffacements();
}

/** Articles déjà achetés qui ne sont pas dans la liste, filtrés par ce qu'on tape. */
function afficherSuggestions() {
  const zone = $('#suggestions');
  if (etat.vue !== 'courses') { zone.innerHTML = ''; return; }
  const q = saisie.value.trim().toLowerCase();
  const dedans = new Set(articlesCourses().filter((l) => !l.coche).map((l) => l.texte.toLowerCase()));
  const proposes = etat.articles
    .filter((a) => !dedans.has(a.nom.toLowerCase()) && (!q || a.nom.toLowerCase().includes(q)))
    .sort((a, b) => q ? (b.nom.toLowerCase().startsWith(q) - a.nom.toLowerCase().startsWith(q)) || b.fois - a.fois : 0)
    .slice(0, q ? 6 : 10);
  zone.innerHTML = proposes.length
    ? `<span class="discret petit">${q ? 'Déjà achetés :' : 'Souvent achetés :'}</span>` +
      proposes.map((a) => `<button type="button" data-article="${echap(a.nom)}">＋ ${echap(a.nom)}</button>`).join('')
    : '';
}

async function supprimerLigne(ligneId) {
  const { error } = await sb.from('checklist').delete().eq('id', ligneId);
  if (error) toast('Suppression impossible : ' + error.message);
  charger();
}

async function supprimerLignesCochees(itemId) {
  const { error } = await sb.from('checklist').delete().eq('item_id', itemId).eq('coche', true);
  if (error) toast('Suppression impossible : ' + error.message);
  charger();
}

/** Transforme une ligne de checklist en vraie sous-tâche. */
async function promouvoirLigne(ligneId) {
  let ligne;
  for (const lignes of etat.checklist.values()) ligne = ligne || lignes.find((x) => x.id === ligneId);
  const parent = ligne && etat.items.find((i) => i.id === ligne.item_id);
  if (!parent) return;
  if (profondeur(parent) + 1 >= NIVEAUX_MAX) { toast('Trois niveaux de sous-tâches au maximum.'); return; }
  if (await ajouterSousTache(parent, ligne.texte)) {
    await sb.from('checklist').delete().eq('id', ligneId);
    toast('« ' + ligne.texte + ' » est devenue une sous-tâche.');
    charger();
  }
}

/** HTML de la checklist d'un élément, avec ajout rapide (plusieurs lignes d'un coup). */
function afficherChecklist(itemId, { formulaire = true, annuler = '' } = {}) {
  const lignes = lignesChecklist(itemId);
  const promouvable = (() => { const i = etat.items.find((x) => x.id === itemId); return i && estTache(i) && profondeur(i) + 1 < NIVEAUX_MAX; })();
  return `<div class="bloc checklist">
    <div class="bloc-titre">Checklist${lignes.length ? ` <span class="compte">${lignes.filter((l) => l.coche).length}/${lignes.length}</span>` : ''}</div>
    ${lignes.length ? `<ul class="lignes">${lignes.map((l) => `<li class="${l.coche ? 'coche' : ''}">
      <label><input type="checkbox" data-check-coche="${l.id}" ${l.coche ? 'checked' : ''}><span class="check-texte" data-check-texte="${l.id}">${echap(l.texte)}</span></label>
      ${promouvable ? `<button type="button" class="mini" data-check-promouvoir="${l.id}" title="En faire une sous-tâche (ou appui long sur la ligne)" aria-label="En faire une sous-tâche">⤴</button>` : ''}
      <button type="button" class="mini" data-check-suppr="${l.id}" title="Supprimer" aria-label="Supprimer">✕</button>
    </li>`).join('')}</ul>` : ''}
    ${formulaire ? `<form class="mini-ajout" data-ajout-check="${itemId}">
      <input data-garder="check-${itemId}" placeholder="Nouvelle ligne (virgule pour plusieurs)" autocomplete="off" enterkeyhint="done">
      <button type="submit" class="mini" aria-label="Ajouter">＋</button>${annuler}
    </form>` : ''}
    ${lignes.some((l) => l.coche) ? `<button type="button" class="lien petit" data-check-vider="${itemId}">Retirer les lignes cochées</button>` : ''}
  </div>`;
}


// ---------- fiche d'un élément ouvert ----------
// D'abord ce qu'on lit (description, infos, contenu), en grand et aéré ; les réglages sont repliés
// derrière le bouton « ⚙ Réglages », et les champs d'ajout n'apparaissent qu'à la demande.
function dateLongue(iso) {
  const auj = aujourdhui();
  const rel = iso === auj ? 'aujourd\'hui' : iso === ajouterJours(auj, 1) ? 'demain' : iso === ajouterJours(auj, -1) ? 'hier' : '';
  const d = dateDe(iso).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  return rel ? `${rel[0].toUpperCase() + rel.slice(1)}, ${d}` : d[0].toUpperCase() + d.slice(1);
}

function infosDe(i, parent) {
  const lignes = [];
  const ligne = (icone, texte, classe = '') => lignes.push(`<li class="${classe}"><span class="icone" aria-hidden="true">${icone}</span><span>${texte}</span></li>`);
  if (i.etat === 'en_cours') ligne('▶', 'En cours', 'fort');
  if (i.echeance) {
    const retard = i.echeance < aujourdhui();
    ligne('📅', echap(dateLongue(i.echeance)) + (i.echeance_heure ? ' à ' + echap(heureCourte(i.echeance_heure)) : '') + (retard ? ' · <strong>en retard</strong>' : ''), retard ? 'alerte' : 'fort');
  }
  if (i.recurrence) ligne('🔁', echap(texteRecurrence(i.recurrence)[0].toUpperCase() + texteRecurrence(i.recurrence).slice(1)));
  for (const r of rappelsDe(i.id)) ligne('🔔', 'Rappel ' + echap(dateHeure(r.quand)));
  if (parent) ligne(estTache(i) ? '↳' : '📎', (estTache(i) ? 'Étape de ' : 'Attachée à ') + `<button type="button" class="lien-info" data-action="aller" data-id="${i.id}">${echap(libelle(parent))}</button>`);
  const cat = categorie(i.categorie_id);
  const morceaux = [];
  if (cat) morceaux.push(`<span class="c${couleur(cat.id)}">● ${echap(cat.nom)}</span>`);
  if (i.projet) morceaux.push(`${echap(i.projet)}`);
  if (i.type === 'idee') morceaux.push('Idée');
  if (i.type === 'course') morceaux.push('Course');
  if (morceaux.length) ligne('🏷', morceaux.join(' · '), 'discret');
  return lignes.length ? `<ul class="infos">${lignes.join('')}</ul>` : '';
}

function fiche(i, { niveau, cocher, cleOuvert, parent, notes, brut }) {
  const parties = [];
  if (i.details) parties.push(`<div class="description">${echap(i.details)}</div>`);
  parties.push(infosDe(i, parent));
  if (!brut && i.texte_brut && i.texte_brut !== i.titre && i.texte_brut !== i.details) {
    parties.push(`<p class="dicte" title="Ce que tu as dicté ou écrit">« ${echap(i.texte_brut)} »</p>`);
  }

  // Contenu : checklist et notes attachées, seulement s'il y en a. Un ajout demandé par « ＋ » ouvre
  // son champ à la fin de sa section (créée au besoin), sans rien déplacer d'autre.
  const tache = estTache(i) && i.etat !== 'a_trier';
  const ajout = etat.ajouts.get(cleOuvert);
  const annuler = `<button type="button" class="mini" data-ajout-fermer="${echap(cleOuvert)}" aria-label="Annuler" title="Annuler (Échap)">✕</button>`;
  if (tache && (lignesChecklist(i.id).length || ajout === 'check')) parties.push(afficherChecklist(i.id, { formulaire: ajout === 'check', annuler }));
  if (tache && (notes.length || ajout === 'note')) {
    parties.push(`<div class="bloc">
      <div class="bloc-titre">Notes attachées${notes.length ? ` <span class="compte">${notes.length}</span>` : ''}</div>
      ${notes.map((n) => `<div class="note-liee"><strong>${echap(libelle(n))}</strong>${n.details && n.details !== n.titre ? `<div>${echap(n.details)}</div>` : ''}</div>`).join('')}
      ${ajout === 'note' ? `<form class="mini-ajout" data-ajout-note="${i.id}">
        <textarea rows="1" data-garder="note-${i.id}" placeholder="Écris la note puis Entrée"></textarea>
        <button type="submit" class="mini" aria-label="Attacher la note">＋</button>${annuler}</form>` : ''}
    </div>`);
  }
  if (tache && ajout === 'sous') {
    parties.push(`<div class="bloc">
      <div class="bloc-titre">Nouvelle sous-tâche</div>
      <form class="mini-ajout" data-ajout-sous="${i.id}">
        <input data-garder="sous-${i.id}" placeholder="Écris la sous-tâche puis Entrée" autocomplete="off" enterkeyhint="done">
        <button type="submit" class="mini" aria-label="Ajouter la sous-tâche">＋</button>${annuler}</form>
    </div>`);
  }

  // Pied de fiche : « ＋ » à gauche (petit menu), « ⚙ Réglages » à droite. Rien d'autre.
  const choix = [];
  if (tache) {
    if (profondeur(i) + 1 < NIVEAUX_MAX) choix.push(['sous', '↳', 'Sous-tâche']);
    choix.push(['check', '☑', 'Ligne de checklist'], ['note', '📎', 'Note attachée']);
  }
  const reglagesOuverts = etat.reglages.has(cleOuvert);
  parties.push(`<div class="barre-fiche">
    ${choix.length ? `<div class="menu-ajout">
      <button type="button" class="puce-action btn-plus" data-menu-ajout aria-haspopup="menu" aria-expanded="false" aria-label="Ajouter" title="Ajouter une sous-tâche, une ligne de checklist ou une note">＋</button>
      <div class="pop-ajout" role="menu" hidden>
        ${choix.map(([k, ic, t]) => `<button type="button" role="menuitem" data-ajout-ouvrir="${k}" data-cle="${echap(cleOuvert)}"><span class="icone" aria-hidden="true">${ic}</span>${t}</button>`).join('')}
      </div>
    </div>` : ''}
    <button type="button" class="puce-action btn-reglages" data-reglages="${echap(cleOuvert)}" aria-expanded="${reglagesOuverts}">⚙ Réglages</button>
  </div>`);

  if (reglagesOuverts) {
    const r = [];
    if (i.etat !== 'a_trier') {
      const possibles = parentsPossibles(i);
      if (possibles.length || i.parent_id) {
        const options = [`<option value="">${estTache(i) ? 'Aucune (tâche principale)' : 'Aucune'}</option>`]
          .concat(possibles.map((p) => `<option value="${p.id}" ${p.id === i.parent_id ? 'selected' : ''}>${'  '.repeat(profondeur(p))}${echap(libelle(p))}</option>`));
        if (i.parent_id && !possibles.some((p) => p.id === i.parent_id)) options.push(`<option value="${i.parent_id}" selected>${echap(libelle(parent))}</option>`);
        r.push(`<label class="choix-cat"><span>${estTache(i) ? 'Sous-tâche de' : 'Attachée à'}</span> <select data-parent-de="${i.id}">${options.join('')}</select></label>`);
      }
    }
    if (etat.categories.length && niveau === 0) {
      const options = [`<option value="">${i.etat === 'a_trier' ? 'Laisser Claude choisir' : 'Sans catégorie'}</option>`]
        .concat(etat.categories.map((c) => `<option value="${c.id}" ${c.id === i.categorie_id ? 'selected' : ''}>${echap(c.nom)}</option>`));
      r.push(`<label class="choix-cat"><span>Catégorie</span> <select data-categorie-de="${i.id}">${options.join('')}</select></label>`);
    }
    if (niveau === 0 && i.etat !== 'a_trier') {
      r.push(`<label class="choix-cat"><span>Projet</span> <input class="champ-projet" list="projets-connus" data-projet-de="${i.id}"
        value="${echap(i.projet || '')}" maxlength="60" placeholder="${TYPES_NOTES.includes(i.type) ? 'Laisser Claude choisir' : 'Aucun'}" autocomplete="off" enterkeyhint="done"></label>`);
    }
    if (cocher) r.push(blocPlanif(i));
    if (cocher && i.etat === 'a_faire') r.push(`<label class="coche-reglage"><input type="checkbox" data-en-cours-de="${i.id}"> En cours (je l'ai commencée)</label>`);
    if (cocher && i.etat === 'en_cours') r.push(`<label class="coche-reglage"><input type="checkbox" data-en-cours-de="${i.id}" checked> En cours (je l'ai commencée)</label>`);
    const quoi = TYPES_NOTES.includes(i.type) ? 'cette note' : 'cette tâche';
    r.push(`<div class="zone-suppr"><button type="button" class="lien-suppr" data-supprimer-item="${i.id}">🗑 Supprimer ${quoi}</button></div>`);
    parties.push(`<div class="reglages">${r.join('')}</div>`);
  }
  return `<div class="details">${parties.join('')}</div>`;
}

document.addEventListener('click', (e) => {
  const reg = e.target.closest('[data-reglages]');
  if (reg) {
    const cle = reg.dataset.reglages;
    etat.reglages.has(cle) ? etat.reglages.delete(cle) : etat.reglages.add(cle);
    afficher();
    if (etat.reglages.has(cle)) document.querySelector(`[data-reglages="${CSS.escape(cle)}"]`)?.closest('.details')?.querySelector('.reglages')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return;
  }
  const plus = e.target.closest('[data-menu-ajout]');
  const ouvert = document.querySelector('.pop-ajout:not([hidden])');
  if (ouvert && (!e.target.closest('.pop-ajout') || e.target.closest('[data-ajout-ouvrir]'))) fermerMenuAjout(ouvert);
  if (plus) {
    const pop = plus.nextElementSibling;
    if (pop !== ouvert) ouvrirMenuAjout(plus, pop);
    return;
  }
  const aj = e.target.closest('[data-ajout-ouvrir]');
  if (aj) {
    const { cle, ajoutOuvrir: k } = aj.dataset;
    etat.ajouts.set(cle, k);
    const details = aj.closest('.details');
    const haut = details?.getBoundingClientRect().top;
    afficher();
    // On garde la fiche à la même place à l'écran, et le curseur dans le nouveau champ.
    const nouvelle = document.querySelector(`[data-ajout-ouvrir][data-cle="${CSS.escape(cle)}"]`)?.closest('.details');
    if (nouvelle && haut != null) scrollBy(0, nouvelle.getBoundingClientRect().top - haut);
    const champ = nouvelle?.querySelector('.mini-ajout input, .mini-ajout textarea');
    champ?.focus({ preventScroll: true });
    champ?.scrollIntoView({ block: 'nearest' });
    return;
  }
  const ferme = e.target.closest('[data-ajout-fermer]');
  if (ferme) { etat.ajouts.delete(ferme.dataset.ajoutFermer); afficher(); return; }
});
// Suppression (rare) : l'élément passe en « abandonné », il ne disparaît pas de la base et peut être rétabli.
async function supprimerItem(item) {
  const note = TYPES_NOTES.includes(item.type);
  const sous = note ? [] : descendants(item.id);
  const ok = await demander(note ? 'Supprimer cette note ?' : 'Supprimer cette tâche ?',
    libelle(item) + (sous.length ? ` (et ${sous.length > 1 ? `ses ${sous.length} sous-tâches` : 'sa sous-tâche'})` : ''), 'Supprimer');
  if (!ok) return;
  const touches = [item, ...sous];
  const anciens = touches.map((t) => [t.id, t.etat]);
  const res = await Promise.all(touches.map((t) => sb.from('items').update({ etat: 'abandonne' }).eq('id', t.id)));
  const err = res.find((x) => x.error);
  if (err) { toast('Suppression impossible : ' + err.error.message); charger(); return; }
  await sb.from('journal').insert(touches.map((t) => ({ item_id: t.id, action: 'supprime', avant: { etat: t.etat }, apres: { etat: 'abandonne' }, par: 'jeremie' })));
  etat.ouverts.forEach((k) => { if (k.endsWith(item.id)) etat.ouverts.delete(k); });
  toast(note ? 'Note supprimée.' : 'Tâche supprimée.', {
    nom: 'Annuler',
    faire: async () => {
      await Promise.all(anciens.map(([id, e]) => sb.from('items').update({ etat: e }).eq('id', id)));
      await sb.from('journal').insert(anciens.map(([id, e]) => ({ item_id: id, action: 'supprime', avant: { etat: 'abandonne' }, apres: { etat: e, annule: true }, par: 'jeremie' })));
      charger();
    },
  });
  charger();
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-supprimer-item]');
  if (!b) return;
  const item = etat.items.find((i) => i.id === b.dataset.supprimerItem);
  if (item) supprimerItem(item);
});

function ouvrirMenuAjout(plus, pop) {
  pop.hidden = false;
  plus.setAttribute('aria-expanded', 'true');
  // Vers le bas s'il y a la place au-dessus de la barre d'ajout, sinon vers le haut.
  const bas = ($('#form-ajout')?.getBoundingClientRect().top || innerHeight) - plus.getBoundingClientRect().bottom;
  pop.classList.toggle('vers-haut', bas < pop.offsetHeight + 12);
  pop.querySelector('button')?.focus({ preventScroll: true });
}
function fermerMenuAjout(pop) {
  pop.hidden = true;
  pop.previousElementSibling?.setAttribute('aria-expanded', 'false');
}
document.addEventListener('change', (e) => {
  const c = e.target.closest('[data-en-cours-de]');
  if (!c) return;
  const item = etat.items.find((i) => i.id === c.dataset.enCoursDe);
  if (item) changerEtat(item, c.checked ? 'en_cours' : 'a_faire');
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const pop = document.querySelector('.pop-ajout:not([hidden])');
  if (pop) { fermerMenuAjout(pop); pop.previousElementSibling?.focus(); return; }
  const f = e.target.closest?.('.mini-ajout');
  if (!f) return;
  const cle = f.querySelector('[data-ajout-fermer]')?.dataset.ajoutFermer;
  if (cle) { e.target.value = ''; etat.ajouts.delete(cle); afficher(); }
});

// ---------- catégories ----------
const COULEURS = 8; // teintes définies dans style.css (--c0 … --c7)
function categorie(id) { return etat.categories.find((c) => c.id === id); }
function couleur(id) { return Math.max(0, etat.categories.findIndex((c) => c.id === id)) % COULEURS; }

function afficherFiltres() {
  const boutons = [['tout', 'Tout'], ...etat.categories.map((c) => [c.id, c.nom])];
  if (etat.items.some((i) => i.etat !== 'a_trier' && !i.categorie_id)) boutons.push(['aucune', 'Sans catégorie']);
  $('#filtres').innerHTML = boutons
    .map(([id, nom]) => `<button data-filtre="${id}" aria-pressed="${etat.filtre === id}">${echap(nom)}</button>`)
    .join('') + '<button class="regler" data-gerer aria-label="Gérer les catégories" title="Gérer les catégories">⚙</button>';
  montrerChoix($('#filtres'));
}

function choisirFiltre(f) {
  etat.filtre = f;
  ecrire('filtre', f);
  afficherFiltres();
  afficher();
}

function afficherGestion() {
  const cats = etat.categories;
  const compte = (id) => etat.items.filter((i) => i.categorie_id === id).length;
  $('#liste-categories').innerHTML = cats.length ? cats.map((c, n) => `
    <li data-cat="${c.id}">
      <span class="pastille c${couleur(c.id)}"></span>
      <input value="${echap(c.nom)}" maxlength="40" aria-label="Nom de la catégorie" data-renommer="${c.id}">
      <span class="discret petit" title="Éléments en cours">${compte(c.id) || ''}</span>
      <button class="rond petit" data-monter="${c.id}" ${n === 0 ? 'disabled' : ''} aria-label="Monter" title="Monter">↑</button>
      <button class="rond petit" data-supprimer="${c.id}" aria-label="Supprimer" title="Supprimer">✕</button>
    </li>`).join('') : '<li class="discret">Aucune catégorie pour l\'instant.</li>';
}

function ouvrirGestion() {
  afficherGestion();
  $('#dlg-categories').hidden = false;
}
function fermerGestion() { $('#dlg-categories').hidden = true; }

async function ajouterCategorie(nom) {
  nom = nom.trim();
  if (!nom) return false;
  if (etat.categories.some((c) => c.nom.toLowerCase() === nom.toLowerCase())) { toast('Cette catégorie existe déjà.'); return false; }
  const ordre = Math.max(0, ...etat.categories.map((c) => c.ordre)) + 1;
  const { error } = await sb.from('categories').insert({ nom, ordre });
  if (error) { toast('Ajout impossible : ' + error.message); return false; }
  await sb.from('journal').insert({ action: 'categorie_creee', apres: { nom }, par: 'appli' });
  await charger();
  return true;
}

async function renommerCategorie(id, nom) {
  const c = categorie(id);
  nom = nom.trim();
  if (!c || !nom || nom === c.nom) { afficherGestion(); return; }
  const { error } = await sb.from('categories').update({ nom }).eq('id', id);
  if (error) { toast(/duplicate|unique/i.test(error.message) ? 'Ce nom est déjà pris.' : 'Renommage impossible : ' + error.message); afficherGestion(); return; }
  await sb.from('journal').insert({ action: 'categorie_renommee', avant: { nom: c.nom }, apres: { nom }, par: 'appli' });
  toast('Renommée en « ' + nom + ' ».');
  charger();
}

async function monterCategorie(id) {
  const cats = [...etat.categories];
  const n = cats.findIndex((c) => c.id === id);
  if (n <= 0) return;
  [cats[n - 1], cats[n]] = [cats[n], cats[n - 1]];
  const res = await Promise.all(cats.map((c, k) => (c.ordre === k + 1 ? null : sb.from('categories').update({ ordre: k + 1 }).eq('id', c.id))));
  const err = res.find((r) => r && r.error);
  if (err) toast('Modification impossible : ' + err.error.message);
  charger();
}

async function supprimerCategorie(id) {
  const c = categorie(id);
  if (!c) return;
  const n = etat.items.filter((i) => i.categorie_id === id).length;
  const msg = n
    ? `Supprimer « ${c.nom} » ? Ses ${n} élément(s) restent dans ta liste, sans catégorie : Claude les reclassera.`
    : `Supprimer « ${c.nom} » ?`;
  if (!confirm(msg)) return;
  const { error } = await sb.from('categories').delete().eq('id', id);
  if (error) { toast('Suppression impossible : ' + error.message); return; }
  await sb.from('journal').insert({ action: 'categorie_supprimee', avant: { nom: c.nom, elements: n }, par: 'appli' });
  toast('« ' + c.nom + ' » supprimée.');
  charger();
}

// ---------- affichage ----------
function filtreCategorie(i) {
  if (etat.filtre === 'tout') return true;
  if (etat.filtre === 'aucune') return i.etat !== 'a_trier' && !i.categorie_id;
  return i.categorie_id === etat.filtre;
}

// ---------- projets (rangés par Claude dans items.projet) ----------
const SANS_PROJET = '-';
function typesVue() { return etat.vue === 'notes' ? TYPES_NOTES : TYPES_LISTE; }
function cleProjet(nom) { return (nom || '').trim().toLowerCase(); }
function filtreProjet(i) {
  if (!etat.projet) return true;
  if (etat.projet === SANS_PROJET) return !cleProjet(i.projet);
  return cleProjet(i.projet) === etat.projet;
}

// Les projets proposés sont ceux des éléments de l'onglet affiché (catégorie comprise).
function projetsVisibles() {
  const types = typesVue();
  const vus = new Map();
  let sans = false;
  for (const i of etat.items) {
    if (i.etat === 'a_trier' || !types.includes(i.type) || !filtreCategorie(i)) continue;
    const cle = cleProjet(i.projet);
    if (!cle) { sans = true; continue; }
    const p = vus.get(cle) || { cle, nom: i.projet.trim(), n: 0 };
    p.n++;
    vus.set(cle, p);
  }
  const liste = [...vus.values()].sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
  return { liste, sans };
}

function afficherProjets() {
  const { liste, sans } = projetsVisibles();
  if (etat.projet && etat.projet !== SANS_PROJET && !liste.some((p) => p.cle === etat.projet)) etat.projet = '';
  if (etat.projet === SANS_PROJET && !sans) etat.projet = '';
  const zone = $('#projets');
  zone.hidden = BUREAU || !liste.length;
  if (zone.hidden) { zone.innerHTML = ''; return; }
  const boutons = [['', 'Tous les projets'], ...liste.map((p) => [p.cle, p.nom])];
  if (sans) boutons.push([SANS_PROJET, 'Sans projet']);
  zone.innerHTML = boutons
    .map(([cle, nom]) => `<button data-projet="${echap(cle)}" aria-pressed="${etat.projet === cle}">${echap(nom)}</button>`)
    .join('') + '<button class="regler" data-gerer-projets aria-label="Gérer les projets" title="Gérer les projets">⚙</button>';
  montrerChoix(zone);
}

function choisirProjet(p) {
  etat.projet = etat.projet === p ? '' : p;
  ecrire('projet', etat.projet);
  afficher();
}

function carte(i, { cocher = true, niveau = 0, contexte = false, raison = '', arbre = true } = {}) {
  const brut = !i.titre;
  // Une sous-tâche peut apparaître deux fois (seule dans « Maintenant » et dans l'arbre) : chaque copie s'ouvre à part.
  const cleOuvert = raison ? 'prio:' + i.id : contexte && i.parent_id ? 'seule:' + i.id : i.id;
  const ouvert = etat.ouverts.has(cleOuvert);
  const tags = [];
  const cat = categorie(i.categorie_id);
  const parent = trouver(i.parent_id);
  if (contexte && parent && estTache(i)) tags.push(`<span class="contexte">↳ ${echap(libelle(parent))}</span>`);
  if (parent && !estTache(i)) tags.push(`<button type="button" class="tag lie" data-action="aller" data-id="${i.id}" title="Ouvrir la tâche">📎 ${echap(libelle(parent))}</button>`);
  const prog = estTache(i) ? progression(i.id) : { total: 0 };
  if (prog.total) {
    const replie = etat.replies.has(i.id);
    tags.push(`<button type="button" class="tag arbre" data-action="arbre" data-id="${i.id}" aria-expanded="${!replie}" title="${replie ? 'Déplier' : 'Replier'} les sous-tâches">
      ${replie ? '▸' : '▾'} ${prog.faits}/${prog.total}<span class="barre"><i style="width:${Math.round((100 * prog.faits) / prog.total)}%"></i></span></button>`);
  }
  const lignes = lignesChecklist(i.id);
  if (lignes.length) tags.push(`<span class="tag">☑ ${lignes.filter((l) => l.coche).length}/${lignes.length}</span>`);
  const notes = notesDe(i.id);
  if (notes.length) tags.push(`<span class="tag" title="Notes attachées">📎 ${notes.length}</span>`);
  if (niveau === 0 && etat.filtre === 'tout' && cat) tags.push(`<span class="tag cat c${couleur(cat.id)}">${echap(cat.nom)}</span>`);
  if (i.type === 'course') tags.push('<span class="tag">Course</span>');
  if (i.type === 'idee') tags.push('<span class="tag">Idée</span>');
  if (i.etat === 'en_cours') tags.push('<span class="tag">En cours</span>');
  if (i.echeance) tags.push(tagEcheance(i));
  if (i.recurrence) tags.push(`<span class="tag" title="${echap(texteRecurrence(i.recurrence))}">🔁 ${echap(texteRecurrence(i.recurrence, true))}</span>`);
  if (rappelsDe(i.id).length) tags.push(`<span class="tag" title="Rappel ${echap(dateHeure(rappelsDe(i.id)[0].quand))}">🔔</span>`);
  if (niveau === 0 && i.theme) tags.push(`<span>${echap(i.theme)}</span>`);
  if (niveau === 0 && i.projet && !etat.projet && etat.vue !== 'notes') tags.push(`<span>· ${echap(i.projet)}</span>`);

  let detail = '';
  if (ouvert) detail = fiche(i, { niveau, cocher, cleOuvert, parent, notes, brut });
  let html = `<li class="item${brut ? ' brut' : ''}${niveau ? ' sous-tache' : ''}" data-id="${i.id}">
    ${cocher ? `<button class="case" data-action="fait" data-id="${i.id}" aria-label="Marquer comme fait" title="Fait"></button>` : '<span></span>'}
    <div class="corps" data-action="ouvrir" data-id="${i.id}" data-ouvrir="${cleOuvert}">
      <div class="titre">${echap(libelle(i))}</div>
      ${raison ? `<div class="raison">${echap(raison)}</div>` : ''}
      ${ouvert ? (prog.total ? `<div class="meta">${tags[tags.findIndex((t) => t.includes('data-action="arbre"'))] || ''}</div>` : '')
        : tags.length ? `<div class="meta">${tags.join('')}</div>` : ''}
    </div>
    ${detail}
  </li>`;
  // L'arbre : les sous-tâches sous leur parent, reliées par un trait.
  if (arbre && estTache(i) && !etat.replies.has(i.id) && niveau < NIVEAUX_MAX - 1) {
    const enfants = sousTaches(i.id);
    if (enfants.length) html += `<li class="branche"><ul class="items">${enfants.map((c) => carte(c, { cocher, niveau: niveau + 1 })).join('')}</ul></li>`;
  }
  return html;
}

function section(cle, nom, items, ouvertParDefaut, classe = '') {
  const ouvert = etat.sections[cle] ?? ouvertParDefaut;
  return `<details class="horizon ${classe}" data-section="${cle}" ${ouvert ? 'open' : ''}>
    <summary>${nom} <span class="compte">${items.length}</span></summary>
    ${items.length ? `<ul class="items">${items.map((i) => carte(i, { contexte: !!i.parent_id })).join('')}</ul>` : '<div class="vide">Rien ici.</div>'}
  </details>`;
}

// ---------- résumé du matin : les 3 priorités choisies par Claude ----------
function blocAujourdhui() {
  const jour = aujourdhui();
  const prio = etat.items
    .filter((i) => i.priorite_jour === jour && (i.etat === 'a_faire' || i.etat === 'en_cours'))
    .sort((a, b) => (a.priorite_rang ?? 9) - (b.priorite_rang ?? 9));
  if (!prio.length) return '';
  return `<section class="aujourdhui">
    <h2>Aujourd'hui</h2>
    <ul class="items">${prio.map((i) => carte(i, { raison: i.priorite_raison, contexte: true, arbre: false })).join('')}</ul>
  </section>`;
}

// ---------- questions simples de Claude ----------
// Quand Claude hésite (« ça va dans quelle tâche ? »), il range l'élément à part et pose la question ici.
function blocQuestions() {
  const qs = etat.questions;
  if (!qs.length) return '';
  return `<section class="questions">
    <h2>${qs.length > 1 ? qs.length + ' questions' : 'Une question'} de Claude</h2>
    ${qs.map((q) => `<div class="question" data-question="${q.id}">
      <div class="texte">${echap(q.question)}</div>
      <div class="choix">${(q.choix || []).map((c, n) =>
        `<button type="button" class="${c.cible_id ? 'principal' : 'lien'}" data-choix="${n}">${echap(c.libelle)}</button>`).join('')}</div>
    </div>`).join('')}
  </section>`;
}

async function repondreQuestion(id, choix) {
  const { data, error } = await sb.rpc('repondre_question', { p_id: id, p_choix: choix });
  if (error) toast('Réponse impossible : ' + error.message);
  else if (data === 'rattachee') toast('Précision ajoutée.');
  else if (data === 'garde') toast('Gardé à part.');
  else if (data === 'expiree') toast('Cette question n\'est plus d\'actualité.');
  await charger();
}

// ---------- revue de la semaine ----------
const NOMS_HORIZONS = Object.fromEntries(HORIZONS.map((h) => [h.cle, h.nom]));
function libelleProposition(p) {
  const c = p.changements || {};
  if (p.action === 'abandonner') return 'Abandonner';
  const morceaux = [];
  if (c.horizon) morceaux.push('→ ' + (NOMS_HORIZONS[c.horizon] || c.horizon));
  if (c.echeance) morceaux.push('pour le ' + dateCourte(c.echeance));
  return (p.action === 'planifier' ? 'Planifier ' : 'Reporter ') + morceaux.join(', ');
}

function bandeauRevue() {
  const n = etat.propositions.length;
  if (!n || BUREAU) return '';
  return `<button class="bandeau-revue" data-revue>
    <strong>Revue de la semaine</strong> · ${n} proposition${n > 1 ? 's' : ''} de Claude <span aria-hidden="true">›</span>
  </button>`;
}

function afficherRevue() {
  const ps = etat.propositions;
  $('#liste-revue').innerHTML = ps.length ? ps.map((p) => {
    const i = etat.items.find((x) => x.id === p.item_id);
    return `<li class="proposition">
      <div class="corps">
        <div class="titre">${echap(i ? i.titre || i.texte_brut : '')}</div>
        <div class="action-prop ${p.action}">${echap(libelleProposition(p))}</div>
        <div class="discret petit">${echap(p.raison)}</div>
      </div>
      <button class="rond petit oui" data-repondre="${p.id}" data-accepter="1" aria-label="Accepter" title="Accepter">✓</button>
      <button class="rond petit" data-repondre="${p.id}" data-accepter="0" aria-label="Refuser" title="Refuser">✕</button>
    </li>`;
  }).join('') : '<li class="discret">Tout est traité. Merci !</li>';
  $('#btn-tout-accepter').hidden = ps.length < 2;
}

function ouvrirRevue() { afficherRevue(); $('#dlg-revue').hidden = false; }
function fermerRevue() { $('#dlg-revue').hidden = true; }

async function repondre(ids, accepter) {
  const res = await Promise.all(ids.map((id) => sb.rpc('repondre_proposition', { p_id: id, p_accepter: accepter })));
  const err = res.find((r) => r.error);
  if (err) toast('Réponse impossible : ' + err.error.message);
  else if (ids.length > 1) toast(ids.length + ' propositions acceptées.');
  await charger();
  if (!etat.propositions.length) setTimeout(fermerRevue, 900);
}

function afficher() {
  afficherProjets();
  majListeProjets();
  // Liste par horizon (« À trier » n'a pas encore de projet : on le montre toujours)
  const liste = etat.items.filter((i) => filtreCategorie(i) && (i.etat === 'a_trier' || filtreProjet(i)));
  const aTrier = liste.filter((i) => i.etat === 'a_trier');
  let html = '';
  if (aTrier.length) html += section('a_trier', 'À trier', aTrier, true, 'a-trier');
  const visibles = new Set(liste.map((i) => i.id));
  for (const h of HORIZONS) {
    html += section(h.cle, h.nom, liste.filter((i) => i.etat !== 'a_trier' && i.horizon === h.cle && TYPES_LISTE.includes(i.type) && visibleSeule(i, visibles)), h.ouvert);
  }
  html = blocQuestions() + bandeauRevue() + blocAujourdhui() + html;
  if (BUREAU) {
    const maintenant = new Date();
    html = `<div class="date-bureau">${maintenant.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}</div>` + html;
  }
  const garde = garderSaisies();
  $('#vue-liste').innerHTML = html;

  // Notes et idées
  const q = etat.recherche.toLowerCase();
  const notes = liste
    .filter((i) => i.etat !== 'a_trier' && TYPES_NOTES.includes(i.type))
    .filter((i) => !q || [i.titre, i.texte_brut, i.details, i.theme, i.projet].some((t) => (t || '').toLowerCase().includes(q)));
  let htmlNotes;
  if (!notes.length) htmlNotes = `<div class="vide">${q ? 'Aucune note ne correspond.' : 'Pas encore de notes.'}</div>`;
  else if (etat.projet) htmlNotes = `<ul class="items">${notes.map((i) => carte(i, { cocher: false })).join('')}</ul>`;
  else {
    // Tous les projets : les notes sont regroupées par projet, celles sans projet à la fin.
    const groupes = new Map();
    for (const n of notes) {
      const cle = cleProjet(n.projet);
      if (!groupes.has(cle)) groupes.set(cle, { nom: cle ? n.projet.trim() : 'Sans projet', notes: [] });
      groupes.get(cle).notes.push(n);
    }
    const ordre = [...groupes.entries()].sort(([a, ga], [b, gb]) => (!a) - (!b) || ga.nom.localeCompare(gb.nom, 'fr'));
    htmlNotes = ordre.length === 1 && !ordre[0][0]
      ? `<ul class="items">${notes.map((i) => carte(i, { cocher: false })).join('')}</ul>`
      : ordre.map(([cle, g]) => `<h3 class="groupe-projet"><button class="lien" data-projet="${echap(cle || SANS_PROJET)}">${echap(g.nom)}</button> <span class="compte">${g.notes.length}</span></h3>
        <ul class="items">${g.notes.map((i) => carte(i, { cocher: false })).join('')}</ul>`).join('');
  }
  $('#liste-notes').innerHTML = htmlNotes;
  afficherCourses();
  restaurerSaisies(garde);
}

// Le temps réel redessine tout : on garde ce qui est en cours de saisie dans les fiches ouvertes.
function garderSaisies() {
  const valeurs = new Map();
  document.querySelectorAll('[data-garder]').forEach((c) => { if (c.value) valeurs.set(c.dataset.garder, c.value); });
  const actif = document.activeElement?.dataset?.garder;
  return { valeurs, actif };
}
function restaurerSaisies({ valeurs, actif }) {
  for (const [cle, v] of valeurs) { const c = document.querySelector(`[data-garder="${cle}"]`); if (c) c.value = v; }
  if (actif) document.querySelector(`[data-garder="${actif}"]`)?.focus();
}

// ---------- échéance, rappels et répétition ----------
const JOURS = ['L', 'M', 'M', 'J', 'V', 'S', 'D']; // 1 = lundi … 7 = dimanche (comme la base)
const NOMS_JOURS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const UNITES = { jour: ['jour', 'jours'], semaine: ['semaine', 'semaines'], mois: ['mois', 'mois'], an: ['an', 'ans'] };

function isoJour(d) { // date locale -> 'AAAA-MM-JJ'
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dateDe(iso) { return new Date(iso + 'T12:00:00'); }
function jourSemaine(iso) { return ((dateDe(iso).getDay() + 6) % 7) + 1; }
function ajouterJours(iso, n) { const d = dateDe(iso); d.setDate(d.getDate() + n); return isoJour(d); }
function heureCourte(h) { return h ? h.slice(0, 5).replace(':', ' h ').replace(/ h 00$/, ' h') : ''; }
function minutesDe(h) { const [a, b] = (h || '09:00').split(':').map(Number); return a * 60 + b; }
function dateHeure(ts) {
  return new Date(ts).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function tagEcheance(i) {
  const auj = aujourdhui();
  const classe = i.echeance < auj ? ' retard' : i.echeance === auj ? ' du-jour' : '';
  const jour = i.echeance === auj ? 'Aujourd\'hui' : i.echeance === ajouterJours(auj, 1) ? 'Demain' : dateCourte(i.echeance);
  const titre = i.echeance < auj ? 'En retard' : 'Échéance';
  return `<span class="tag echeance${classe}" title="${titre}">${jour}${i.echeance_heure ? ' ' + heureCourte(i.echeance_heure) : ''}</span>`;
}

function texteRecurrence(r, court = false) {
  if (!r?.freq) return '';
  const n = Math.max(1, r.intervalle || 1);
  let t;
  if (r.freq === 'semaine' && r.jours?.length) {
    const jours = [...r.jours].sort().map((j) => NOMS_JOURS[j - 1]);
    if (court) t = jours.length === 1 ? `le ${jours[0]}` : jours.map((j) => j.slice(0, 3)).join(', ');
    else t = (n === 1 ? 'chaque ' : `toutes les ${n} semaines, le `) + jours.join(', ');
    if (court && n > 1) t += ` /${n} sem.`;
  } else if (r.freq === 'mois' && r.jour) {
    t = (n === 1 ? 'tous les mois' : `tous les ${n} mois`) + `, le ${r.jour}`;
    if (court) t = `le ${r.jour}${n > 1 ? ` /${n} mois` : ' du mois'}`;
  } else {
    const plusieurs = UNITES[r.freq]?.[1] || '';
    if (court) t = n === 1 ? ({ jour: 'chaque jour', semaine: 'chaque semaine', mois: 'chaque mois', an: 'chaque année' }[r.freq]) : `${n} ${plusieurs}`;
    else t = n === 1 ? ({ jour: 'tous les jours', semaine: 'toutes les semaines', mois: 'tous les mois', an: 'tous les ans' }[r.freq]) : `tous les ${n} ${plusieurs}`;
  }
  if (r.depuis === 'fait' && !court) t += ', à compter du jour où c\'est fait';
  return t;
}

// Première date à partir d'aujourd'hui qui respecte la répétition (pour poser l'échéance de départ).
function premiereDate(r, depuis = aujourdhui()) {
  if (r.freq === 'semaine' && r.jours?.length) {
    let d = depuis;
    for (let k = 0; k < 7 && !r.jours.includes(jourSemaine(d)); k++) d = ajouterJours(d, 1);
    return d;
  }
  if (r.freq === 'mois' && r.jour) {
    const x = dateDe(depuis);
    for (let k = 0; k < 2; k++) {
      const fin = new Date(x.getFullYear(), x.getMonth() + 1 + k, 0).getDate();
      const d = isoJour(new Date(x.getFullYear(), x.getMonth() + k, Math.min(r.jour, fin)));
      if (d >= depuis) return d;
    }
  }
  return depuis;
}
function respecte(r, iso) {
  if (r.freq === 'semaine' && r.jours?.length) return r.jours.includes(jourSemaine(iso));
  if (r.freq === 'mois' && r.jour) return dateDe(iso).getDate() === r.jour || dateDe(iso).getDate() === new Date(dateDe(iso).getFullYear(), dateDe(iso).getMonth() + 1, 0).getDate();
  return true;
}

function rappelsDe(id) { return etat.rappels.filter((r) => r.item_id === id && new Date(r.quand) > Date.now() - 60e3); }

function blocPlanif(i) {
  const r = i.recurrence || {};
  const freq = r.freq || '';
  const n = r.intervalle || 1;
  const options = [['', 'Ne pas répéter'], ['jour', 'Tous les jours'], ['semaine', 'Toutes les semaines'], ['mois', 'Tous les mois'], ['an', 'Tous les ans']]
    .map(([v, t]) => `<option value="${v}" ${v === freq ? 'selected' : ''}>${t}</option>`).join('');
  let repet = '';
  if (freq) {
    repet += `<div class="ligne-planif indente"><label>Tous les <input type="number" class="nombre" min="1" max="99" value="${n}" data-intervalle-de="${i.id}"> ${UNITES[freq][n > 1 ? 1 : 0]}</label></div>`;
    if (freq === 'semaine') {
      repet += `<div class="ligne-planif jours">${JOURS.map((j, k) => `<button type="button" class="jour" aria-pressed="${(r.jours || []).includes(k + 1)}" data-jour-de="${i.id}" data-jour="${k + 1}" title="${NOMS_JOURS[k]}">${j}</button>`).join('')}</div>`;
    }
    if (freq === 'mois') {
      repet += `<div class="ligne-planif indente"><label>Le <input type="number" class="nombre" min="1" max="31" value="${r.jour || ''}" data-jour-mois-de="${i.id}"> du mois</label></div>`;
    }
    repet += `<div class="ligne-planif"><label class="coche"><input type="checkbox" data-depuis-fait-de="${i.id}" ${r.depuis === 'fait' ? 'checked' : ''}> Compter à partir du jour où je la fais</label></div>`;
  }

  const rappels = rappelsDe(i.id).map((x) => `<li>🔔 ${echap(dateHeure(x.quand))} <button type="button" class="lien" data-rappel-suppr="${x.id}" aria-label="Supprimer ce rappel">✕</button></li>`).join('');
  const choix = i.echeance
    ? [['heure', `À l'échéance (${i.echeance_heure ? heureCourte(i.echeance_heure) : '9 h'})`], ['1h', '1 h avant'], ['veille', 'La veille à 18 h'], ['matin', 'Le matin à 8 h']]
    : [['dans1h', 'Dans 1 h'], ['soir', 'Ce soir à 18 h'], ['demain', 'Demain à 8 h']];
  choix.push(['libre', 'Date et heure précises…']);

  return `<div class="planif">`
    + `<div class="ligne-planif"><span class="etiquette">Échéance</span><input type="date" value="${i.echeance || ''}" data-echeance-de="${i.id}" aria-label="Date d'échéance">`
    + `<input type="time" value="${(i.echeance_heure || '').slice(0, 5)}" data-heure-de="${i.id}" aria-label="Heure (facultative)" ${i.echeance ? '' : 'disabled'}>`
    + (i.echeance ? `<button type="button" class="lien" data-sans-echeance="${i.id}" aria-label="Retirer l'échéance">✕</button>` : '') + `</div>`
    + `<div class="ligne-planif"><span class="etiquette">Répéter</span><select data-repeter-de="${i.id}">${options}</select></div>${repet}`
    + `<div class="ligne-planif"><span class="etiquette">Rappel</span><select data-rappel-de="${i.id}"><option value="">Ajouter un rappel…</option>${choix.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></div>`
    + `<div class="ligne-planif" hidden data-libre-zone="${i.id}"><input type="datetime-local" data-rappel-libre-de="${i.id}" aria-label="Date et heure du rappel"></div>`
    + (rappels ? `<ul class="rappels">${rappels}</ul>` : '')
    + `</div>`;
}

async function majItem(item, champs, message) {
  const avant = Object.fromEntries(Object.keys(champs).map((k) => [k, item[k] ?? null]));
  const { error } = await sb.from('items').update(champs).eq('id', item.id);
  if (error) { toast('Modification impossible : ' + error.message); charger(); return false; }
  await sb.from('journal').insert({ item_id: item.id, action: 'modifie', avant, apres: champs, par: 'appli' });
  if (message) toast(message);
  charger();
  return true;
}

function changerRecurrence(item, r) {
  const champs = { recurrence: r };
  if (r && (!item.echeance || !respecte(r, item.echeance))) champs.echeance = premiereDate(r);
  return majItem(item, champs, r ? 'Répétition : ' + texteRecurrence(r) + '.' : 'Ne se répète plus.');
}

async function ajouterRappel(item, choix, libre) {
  const ligne = { item_id: item.id };
  const h = minutesDe(item.echeance_heure);
  const relatifs = { heure: h, '1h': h - 60, veille: -360, matin: 480 };
  if (choix in relatifs) {
    ligne.relatif_min = relatifs[choix];
    const d = dateDe(item.echeance);
    d.setHours(0, 0, 0, 0);
    ligne.quand = new Date(d.getTime() + ligne.relatif_min * 60e3).toISOString(); // la base recalcule à l'heure de Paris si l'échéance bouge
  } else {
    const d = new Date();
    if (choix === 'dans1h') d.setTime(d.getTime() + 3600e3);
    else if (choix === 'soir') d.setHours(18, 0, 0, 0);
    else if (choix === 'demain') { d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); }
    else if (choix === 'libre') { if (!libre) return; d.setTime(new Date(libre).getTime()); }
    ligne.quand = d.toISOString();
  }
  if (new Date(ligne.quand) < Date.now() - 60e3) { toast('Cette heure est déjà passée.'); return; }
  demanderPermissionNotif();
  const { error } = await sb.from('rappels').insert(ligne);
  if (error) { toast('Rappel impossible : ' + error.message); return; }
  await sb.from('journal').insert({ item_id: item.id, action: 'rappel', apres: ligne, par: 'appli' });
  toast('Rappel le ' + dateHeure(ligne.quand) + '.');
  charger();
}

async function supprimerRappel(id) {
  const r = etat.rappels.find((x) => x.id === id);
  const { error } = await sb.from('rappels').delete().eq('id', id);
  if (error) { toast('Suppression impossible : ' + error.message); return; }
  if (r) await sb.from('journal').insert({ item_id: r.item_id, action: 'rappel_supprime', avant: r, par: 'appli' });
  charger();
}

document.addEventListener('change', (e) => {
  const c = e.target;
  const id = c.dataset.echeanceDe || c.dataset.heureDe || c.dataset.repeterDe || c.dataset.intervalleDe
    || c.dataset.jourMoisDe || c.dataset.depuisFaitDe || c.dataset.rappelDe || c.dataset.rappelLibreDe;
  const item = id && etat.items.find((i) => i.id === id);
  if (!item) return;
  const r = item.recurrence;
  if (c.dataset.echeanceDe) {
    majItem(item, c.value ? { echeance: c.value } : { echeance: null, echeance_heure: null });
  } else if (c.dataset.heureDe) {
    // les rappels « à l'échéance » et « 1 h avant » suivent la nouvelle heure
    const ecart = minutesDe(c.value || '09:00') - minutesDe(item.echeance_heure);
    const ancienne = minutesDe(item.echeance_heure);
    for (const x of rappelsDe(item.id)) {
      if (ecart && (x.relatif_min === ancienne || x.relatif_min === ancienne - 60)) {
        const rel = x.relatif_min + ecart;
        sb.from('rappels').update({ relatif_min: rel, quand: new Date(new Date(x.quand).getTime() + ecart * 60e3).toISOString() }).eq('id', x.id).then(() => {});
      }
    }
    majItem(item, { echeance_heure: c.value || null });
  } else if (c.dataset.repeterDe) {
    if (!c.value) { changerRecurrence(item, null); return; }
    const base = item.echeance || aujourdhui();
    const nouveau = { freq: c.value, intervalle: 1 };
    if (c.value === 'semaine') nouveau.jours = [jourSemaine(base)];
    if (c.value === 'mois') nouveau.jour = dateDe(base).getDate();
    changerRecurrence(item, nouveau);
  } else if (c.dataset.intervalleDe && r) {
    changerRecurrence(item, { ...r, intervalle: Math.min(99, Math.max(1, parseInt(c.value, 10) || 1)) });
  } else if (c.dataset.jourMoisDe && r) {
    const j = Math.min(31, Math.max(1, parseInt(c.value, 10) || 1));
    majItem(item, { recurrence: { ...r, jour: j }, echeance: premiereDate({ ...r, jour: j }) });
  } else if (c.dataset.depuisFaitDe && r) {
    const nouveau = { ...r };
    if (c.checked) nouveau.depuis = 'fait'; else delete nouveau.depuis;
    changerRecurrence(item, nouveau);
  } else if (c.dataset.rappelDe) {
    const v = c.value;
    c.value = '';
    if (v === 'libre') {
      const zone = document.querySelector(`[data-libre-zone="${item.id}"]`);
      zone.hidden = false;
      const champ = zone.querySelector('input');
      const d = item.echeance ? dateDe(item.echeance) : new Date(Date.now() + 3600e3);
      if (item.echeance) d.setHours(9, 0, 0, 0);
      champ.value = `${isoJour(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      champ.focus();
      champ.showPicker?.();
    } else if (v) ajouterRappel(item, v);
  } else if (c.dataset.rappelLibreDe) {
    if (c.value) ajouterRappel(item, 'libre', c.value);
  }
});

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-jour-de], [data-rappel-suppr], [data-sans-echeance]');
  if (!b) return;
  if (b.dataset.rappelSuppr) { supprimerRappel(b.dataset.rappelSuppr); return; }
  const item = etat.items.find((i) => i.id === (b.dataset.jourDe || b.dataset.sansEcheance));
  if (!item) return;
  if (b.dataset.sansEcheance) { majItem(item, { echeance: null, echeance_heure: null }); return; }
  const r = item.recurrence;
  if (!r) return;
  const j = Number(b.dataset.jour);
  const jours = new Set(r.jours || []);
  jours.has(j) ? jours.delete(j) : jours.add(j);
  if (!jours.size) { toast('Garde au moins un jour.'); return; }
  changerRecurrence(item, { ...r, jours: [...jours].sort() });
});

// ---------- notifications sur l'ordinateur (panneau Windows ou navigateur ouvert) ----------
// Sur le téléphone, c'est l'appli Android qui notifie : la page web ne le fait pas, pour éviter les doublons.
const NOTIF_ICI = 'Notification' in window && !/Android|iPhone|iPad/i.test(navigator.userAgent);
let minuteursNotif = [];

function demanderPermissionNotif() {
  if (NOTIF_ICI && Notification.permission === 'default') Notification.requestPermission().then(planifierNotifications);
}

function dejaMontres() { try { return JSON.parse(lire('notifies') || '{}'); } catch { return {}; } }

function planifierNotifications() {
  minuteursNotif.forEach(clearTimeout);
  minuteursNotif = [];
  if (!NOTIF_ICI || Notification.permission !== 'granted') return;
  const vus = dejaMontres();
  const ouverts = new Map(etat.items.map((i) => [i.id, i]));
  for (const r of etat.rappels) {
    const cle = r.id + '|' + r.quand;
    if (vus[cle]) continue;
    const item = r.item_id ? ouverts.get(r.item_id) : null;
    if (r.item_id && !item) continue; // élément fait ou supprimé
    const delai = new Date(r.quand) - Date.now();
    if (delai < -3600e3 || delai > 24 * 3600e3) continue;
    minuteursNotif.push(setTimeout(() => montrerNotif(r, item, cle), Math.max(0, delai)));
  }
}

function montrerNotif(r, item, cle) {
  const vus = dejaMontres();
  if (vus[cle]) return;
  // on garde la trace une semaine, pour ne jamais montrer deux fois le même rappel sur cet appareil
  const limite = Date.now() - 7 * 86400e3;
  for (const k of Object.keys(vus)) if (vus[k] < limite) delete vus[k];
  vus[cle] = Date.now();
  ecrire('notifies', JSON.stringify(vus));
  const titre = r.titre || (item ? item.titre || item.texte_brut : 'Rappel');
  let corps = r.texte || '';
  if (!corps && item?.echeance) corps = 'Échéance : ' + tagEcheance(item).replace(/<[^>]+>/g, '');
  try {
    const n = new Notification(titre, { body: corps, tag: cle, icon: 'icons/icon-192.png', requireInteraction: true });
    n.onclick = () => {
      window.focus();
      if (item) allerA(item.id);
      else if (/^revue/i.test(titre) && etat.propositions?.length) ouvrirRevue();
      else if (/^question/i.test(titre)) { document.querySelector('[data-vue="liste"]')?.click(); window.scrollTo(0, 0); }
      n.close();
    };
  } catch { /* notifications refusées par le système */ }
}

// Le PC peut se mettre en veille : on reprogramme régulièrement, et au retour sur la page.
setInterval(() => { if (abonnement) charger(); }, 10 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && abonnement) charger(); });

// ---------- interactions ----------
document.addEventListener('click', (e) => {
  const cible = e.target.closest('[data-action]');
  if (!cible) return;
  const item = etat.items.find((i) => i.id === cible.dataset.id);
  if (!item) return;
  const action = cible.dataset.action;
  if (action === 'ouvrir') {
    const cle = cible.dataset.ouvrir || item.id;
    etat.ouverts.has(cle) ? etat.ouverts.delete(cle) : etat.ouverts.add(cle);
    afficher();
  } else if (action === 'fait') {
    terminer(item);
  } else if (action === 'arbre') {
    etat.replies.has(item.id) ? etat.replies.delete(item.id) : etat.replies.add(item.id);
    ecrireReplies();
    afficher();
  } else if (action === 'aller') {
    allerA(item.parent_id);
  } else if (action === 'en_cours') {
    changerEtat(item, 'en_cours');
  }
});

document.addEventListener('toggle', (e) => {
  const d = e.target;
  if (d.matches?.('details[data-section]')) {
    etat.sections[d.dataset.section] = d.open;
    if (!BUREAU) ecrire('sections', JSON.stringify(etat.sections));
  }
}, true);

document.querySelectorAll('[data-vue]').forEach((b) => b.addEventListener('click', () => {
  etat.vue = b.dataset.vue;
  document.querySelectorAll('[data-vue]').forEach((x) => x.setAttribute('aria-selected', x === b));
  $('#vue-liste').hidden = etat.vue !== 'liste';
  $('#vue-notes').hidden = etat.vue !== 'notes';
  $('#vue-courses').hidden = etat.vue !== 'courses';
  $('#filtres').hidden = etat.vue === 'courses';
  document.body.classList.toggle('vue-courses', etat.vue === 'courses');
  saisie.placeholder = etat.vue === 'courses' ? 'Ajouter à la liste de courses…' : 'Ajouter en vrac…';
  afficher();
  if (etat.vue === 'courses' && !BUREAU && matchMedia('(hover: hover)').matches) saisie.focus();
}));

// Filtre par projet : les puces de l'entête et les titres de groupe dans « Notes ».
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-gerer-projets]')) { ouvrirGestionProjets(); return; }
  const b = e.target.closest('[data-projet]');
  if (b) choisirProjet(b.dataset.projet);
});

$('#filtres').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.hasAttribute('data-gerer')) ouvrirGestion();
  else choisirFiltre(b.dataset.filtre);
});

// Fiche d'une tâche : sous-tâches, notes attachées, checklist.
document.addEventListener('submit', async (e) => {
  const f = e.target.closest('[data-ajout-sous], [data-ajout-note], [data-ajout-check]');
  if (!f) return;
  e.preventDefault();
  const champ = f.querySelector('input, textarea');
  const cle = champ.dataset.garder;
  const id = f.dataset.ajoutSous || f.dataset.ajoutNote || f.dataset.ajoutCheck;
  const item = etat.items.find((i) => i.id === id);
  if (!item || !champ.value.trim()) return;
  const texte = champ.value;
  champ.value = '';
  let ok;
  if (f.dataset.ajoutSous) ok = await ajouterSousTache(item, texte);
  else if (f.dataset.ajoutNote) ok = await attacherNote(item, texte);
  else ok = await ajouterLignesChecklist(id, texte);
  const c = document.querySelector(`[data-garder="${cle}"]`);
  if (c) { if (!ok) c.value = texte; c.focus(); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && e.target.matches('[data-ajout-note] textarea')) { e.preventDefault(); e.target.form.requestSubmit(); }
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-check-suppr], [data-check-promouvoir], [data-check-vider]');
  if (!b) return;
  if (b.dataset.checkSuppr) supprimerLigne(b.dataset.checkSuppr);
  else if (b.dataset.checkPromouvoir) promouvoirLigne(b.dataset.checkPromouvoir);
  else supprimerLignesCochees(b.dataset.checkVider);
});
// Appui long sur une ligne de checklist : en faire une sous-tâche.
let appuiLong = null;
document.addEventListener('pointerdown', (e) => {
  const t = e.target.closest('[data-check-texte]');
  if (!t) return;
  appuiLong = setTimeout(() => { appuiLong = 'fait'; promouvoirLigne(t.dataset.checkTexte); }, 650);
});
['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => document.addEventListener(ev, () => {
  if (appuiLong && appuiLong !== 'fait') clearTimeout(appuiLong);
}, true));
document.addEventListener('click', (e) => {
  // Après un appui long, le relâchement ne doit pas cocher la ligne.
  if (appuiLong === 'fait' && e.target.closest('.checklist label')) { e.preventDefault(); }
  if (appuiLong === 'fait') appuiLong = null;
}, true);
document.addEventListener('contextmenu', (e) => { if (e.target.closest('[data-check-texte]')) e.preventDefault(); });

document.addEventListener('change', (e) => {
  const coche = e.target.closest('[data-check-coche]');
  if (coche) { cocherLigne(coche.dataset.checkCoche, coche.checked); return; }
  const par = e.target.closest('[data-parent-de]');
  if (par) {
    const item = etat.items.find((i) => i.id === par.dataset.parentDe);
    if (item && (par.value || null) !== item.parent_id) changerParent(item, par.value);
    return;
  }
  const pj = e.target.closest('[data-projet-de]');
  if (pj) {
    const item = etat.items.find((i) => i.id === pj.dataset.projetDe);
    if (item) changerProjet(item, pj.value);
    return;
  }
  const s = e.target.closest('[data-categorie-de]');
  if (!s) return;
  const item = etat.items.find((i) => i.id === s.dataset.categorieDe);
  if (item) changerCategorie(item, s.value);
});

// Fenêtre « Catégories »
$('#form-categorie').addEventListener('submit', async (e) => {
  e.preventDefault();
  const champ = $('#nouvelle-categorie');
  if (await ajouterCategorie(champ.value)) { champ.value = ''; champ.focus(); }
});
$('#liste-categories').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.monter) monterCategorie(b.dataset.monter);
  if (b.dataset.supprimer) supprimerCategorie(b.dataset.supprimer);
});
$('#liste-categories').addEventListener('change', (e) => {
  const c = e.target.closest('[data-renommer]');
  if (c) renommerCategorie(c.dataset.renommer, c.value);
});
$('#liste-categories').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('[data-renommer]')) e.target.blur();
});
$('#btn-fermer-categories').addEventListener('click', fermerGestion);
$('#dlg-categories').addEventListener('click', (e) => { if (e.target.id === 'dlg-categories') fermerGestion(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#dlg-categories').hidden) fermerGestion(); });

// Questions de Claude : un tap sur un choix suffit.
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-choix]');
  const q = b?.closest('[data-question]');
  if (!q) return;
  q.classList.add('traitee');
  repondreQuestion(q.dataset.question, Number(b.dataset.choix));
});

// Fenêtre « Revue de la semaine »
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-revue]')) ouvrirRevue();
});
$('#liste-revue').addEventListener('click', (e) => {
  const b = e.target.closest('[data-repondre]');
  if (!b) return;
  b.closest('li').classList.add('traitee');
  repondre([b.dataset.repondre], b.dataset.accepter === '1');
});
$('#btn-tout-accepter').addEventListener('click', () => repondre(etat.propositions.map((p) => p.id), true));
$('#btn-fermer-revue').addEventListener('click', fermerRevue);
$('#dlg-revue').addEventListener('click', (e) => { if (e.target.id === 'dlg-revue') fermerRevue(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#dlg-revue').hidden) fermerRevue(); });

$('#recherche').addEventListener('input', (e) => { etat.recherche = e.target.value; afficher(); });

// ---------- ajout et dictée ----------
const saisie = $('#saisie');
let sourceSaisie = 'app';
function ajusterHauteur() { saisie.style.height = 'auto'; saisie.style.height = saisie.scrollHeight + 'px'; }
saisie.addEventListener('input', () => { ajusterHauteur(); afficherSuggestions(); });
saisie.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#form-ajout').requestSubmit(); }
});
$('#form-ajout').addEventListener('submit', async (e) => {
  e.preventDefault();
  arreterDictee();
  const ok = etat.vue === 'courses'
    ? await ajouterArticles(saisie.value, sourceSaisie === 'vocal')
    : await ajouter(saisie.value, sourceSaisie);
  if (ok) {
    saisie.value = '';
    sourceSaisie = 'app';
    ajusterHauteur();
    afficherSuggestions();
    if (etat.vue === 'courses') saisie.focus();
  }
});
// Suggestion touchée : ajoutée tout de suite.
$('#suggestions').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-article]');
  if (!b) return;
  b.disabled = true;
  if (await ajouterArticles(b.dataset.article)) { saisie.value = ''; ajusterHauteur(); afficherSuggestions(); }
});

const Reconnaissance = window.SpeechRecognition || window.webkitSpeechRecognition;
let reco = null;
const micro = $('#btn-micro');
if (!Reconnaissance) micro.hidden = true;

// Dictée longue : le navigateur coupe la reconnaissance à chaque pause ; on la relance tant que
// Jérémie n'a pas retouché le micro (ou envoyé), et on met les morceaux bout à bout.
let dicteeVoulue = false;
let dicteeAcquis = '';
let dicteeDerniereParole = 0;
const DICTEE_SILENCE_MAX = 3 * 60 * 1000; // arrêt tout seul après 3 minutes sans un mot

function joindre(a, b) {
  a = a.trimEnd(); b = b.trim();
  if (!b) return a;
  if (!a) return b.charAt(0).toUpperCase() + b.slice(1);
  return a + (/[.!?…]$/.test(a) ? ' ' : '. ') + b.charAt(0).toUpperCase() + b.slice(1);
}

function demarrerDictee() {
  if (!Reconnaissance || reco) return;
  dicteeVoulue = true;
  dicteeAcquis = saisie.value;
  dicteeDerniereParole = Date.now();
  micro.classList.add('ecoute');
  micro.title = 'Terminer la dictée';
  toast('J’écoute… parle aussi longtemps que tu veux, retouche 🎤 pour finir.');
  ecouterMorceau();
}

function ecouterMorceau() {
  reco = new Reconnaissance();
  reco.lang = 'fr-FR';
  reco.interimResults = true;
  reco.continuous = false; // plus fiable sur Android (pas de phrases en double) ; la relance fait le reste
  let morceau = '';
  reco.onresult = (ev) => {
    let fini = '', provisoire = '';
    for (const r of ev.results) (r.isFinal ? (fini += r[0].transcript + ' ') : (provisoire += r[0].transcript));
    morceau = (fini + provisoire).trim();
    dicteeDerniereParole = Date.now();
    saisie.value = joindre(dicteeAcquis, morceau);
    sourceSaisie = 'vocal';
    ajusterHauteur();
  };
  reco.onerror = (ev) => {
    if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed' || ev.error === 'audio-capture') {
      dicteeVoulue = false;
      toast('Dictée impossible : ' + ev.error);
    } else if (ev.error !== 'no-speech' && ev.error !== 'aborted' && ev.error !== 'network') {
      toast('Dictée : ' + ev.error);
    }
  };
  reco.onend = () => {
    dicteeAcquis = joindre(dicteeAcquis, morceau);
    reco = null;
    if (dicteeVoulue && Date.now() - dicteeDerniereParole < DICTEE_SILENCE_MAX && !document.hidden) {
      setTimeout(() => { if (dicteeVoulue && !reco) ecouterMorceau(); }, 150);
      return;
    }
    dicteeVoulue = false;
    micro.classList.remove('ecoute');
    micro.title = 'Dicter';
    saisie.value = dicteeAcquis;
    ajusterHauteur();
    saisie.focus();
  };
  try { reco.start(); } catch { reco = null; dicteeVoulue = false; micro.classList.remove('ecoute'); }
}
function arreterDictee() { dicteeVoulue = false; if (reco) reco.stop(); }
micro.addEventListener('click', () => (reco ? arreterDictee() : demarrerDictee()));

// ?item=<id> (bouton « Échéance, répéter… » de l'appli Android) : ouvre directement le détail de la tâche.
let itemDemande = new URLSearchParams(location.search).get('item');
function montrerItem(id) {
  const item = etat.items.find((i) => i.id === id);
  if (!item) return;
  itemDemande = null;
  etat.sections[item.etat === 'a_trier' ? 'a_trier' : item.horizon] = true;
  allerA(id);
}

let revueDemandee = false;
// Raccourcis Android « Ajouter » et « Dicter » (?ajout=1, ?vocal=1)
function actionsDeLancement() {
  const p = new URLSearchParams(location.search);
  if (p.has('courses')) document.querySelector('[data-vue="courses"]').click();
  if (p.has('notes')) document.querySelector('[data-vue="notes"]').click();
  if (p.has('ajout')) saisie.focus();
  if (p.has('vocal')) demarrerDictee();
  if (p.has('categories')) ouvrirGestion();
  if (p.has('revue')) revueDemandee = true; // ouverte dès que les propositions sont chargées
  if (p.has('courses') || p.has('notes') || p.has('ajout') || p.has('vocal') || p.has('categories') || p.has('revue') || p.has('item')) history.replaceState(null, '', location.pathname + (BUREAU ? '?bureau=1' : ''));
}

if ('serviceWorker' in navigator) {
  // Une nouvelle version du site vient de s'installer : on recharge une fois pour l'afficher tout de suite.
  const avaitUnControleur = !!navigator.serviceWorker.controller;
  let recharge = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!avaitUnControleur || recharge) return;
    recharge = true;
    location.reload();
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => {
    // Le panneau Windows reste ouvert des jours : on vérifie s'il y a une nouvelle version au retour sur la page.
    document.addEventListener('visibilitychange', () => { if (!document.hidden) r.update().catch(() => {}); });
    setInterval(() => r.update().catch(() => {}), 30 * 60 * 1000);
  }).catch(() => {});
}

// En fond d'écran, la page reste ouverte des jours : on rafraîchit la date et la liste de temps en temps.
if (BUREAU) setInterval(() => { charger(); }, 15 * 60 * 1000);
// Le panneau Windows reste ouvert plusieurs jours : quand la date change, on recharge (nouvelles priorités).
let jourAffiche = aujourdhui();
setInterval(() => { if (aujourdhui() !== jourAffiche) { jourAffiche = aujourdhui(); if (abonnement) charger(); } }, 5 * 60 * 1000);

// Panneau Windows (appli « MesTaches », version 1.1.2 et suivantes) : un bouton pour masquer le panneau.
// Le panneau intercepte l'ouverture de « taches://masquer » ; Ctrl+Alt+T le rappelle.
if (/TachesPanneau\//.test(navigator.userAgent)) {
  const masquer = document.createElement('button');
  masquer.className = 'btn-masquer';
  masquer.type = 'button';
  masquer.title = 'Masquer (Ctrl+Alt+T pour revenir)';
  masquer.setAttribute('aria-label', 'Masquer le panneau');
  masquer.textContent = '—';
  masquer.addEventListener('click', () => window.open('taches://masquer'));
  document.body.append(masquer);
  // Cadenas (panneau 2 et suivants) : verrouille ou libère la position du panneau.
  if (/TachesPanneau\/([2-9]|\d\d)/.test(navigator.userAgent)) {
    const verrou = document.createElement('button');
    verrou.className = 'btn-verrou';
    verrou.type = 'button';
    verrou.title = 'Verrouiller / déverrouiller la position';
    verrou.setAttribute('aria-label', 'Verrouiller la position du panneau');
    verrou.addEventListener('click', () => window.open('taches://verrou'));
    document.body.append(verrou);
  }
  // Panneau 3 et suivants : deux boutons, « masquer complètement » (✕) et « réduire » en petite barre (—).
  // En petite barre, le panneau ajoute .reduit au body : on ne montre plus que la barre, sans aucune tâche.
  if (/TachesPanneau\/([3-9]|\d\d)/.test(navigator.userAgent)) {
    masquer.textContent = '✕';
    masquer.title = 'Masquer complètement (Ctrl+Alt+T pour revenir)';
    const reduire = document.createElement('button');
    reduire.className = 'btn-reduire';
    reduire.type = 'button';
    reduire.title = 'Réduire en petite barre';
    reduire.setAttribute('aria-label', 'Réduire le panneau en petite barre');
    reduire.textContent = '—';
    reduire.addEventListener('click', () => window.open('taches://reduire'));
    document.body.append(reduire);
    const barre = document.createElement('div');
    barre.className = 'barre-reduite';
    barre.innerHTML = '<span class="poignee">Tâches</span>' +
      '<button type="button" class="agrandir" title="Agrandir" aria-label="Agrandir le panneau">▢</button>' +
      '<button type="button" class="fermer" title="Masquer complètement" aria-label="Masquer le panneau">✕</button>';
    barre.querySelector('.agrandir').addEventListener('click', () => window.open('taches://agrandir'));
    barre.querySelector('.fermer').addEventListener('click', () => window.open('taches://masquer'));
    // Position verrouillée : la barre ne se déplace plus, un clic sur « Tâches » rouvre le panneau.
    barre.querySelector('.poignee').addEventListener('click', () => {
      if (document.body.classList.contains('verrouille')) window.open('taches://agrandir');
    });
    document.body.append(barre);
    document.body.classList.add('panneau3');
  }
  document.body.classList.add('panneau');
}

// ---------- rangées de pastilles (catégories, projets) : défilement à la molette et en faisant glisser ----------
// Quand il y a trop de pastilles, la rangée défile : molette (verticale ou horizontale), clic maintenu
// puis glisser sur le côté, ou le doigt sur téléphone (défilement natif).
function majBords(zone) {
  const max = zone.scrollWidth - zone.clientWidth;
  zone.classList.toggle('deborde-g', zone.scrollLeft > 2);
  zone.classList.toggle('deborde-d', zone.scrollLeft < max - 2);
}
/** Ramène la pastille choisie dans la partie visible de la rangée, seulement quand le choix change
 *  (un rechargement ne doit pas annuler le défilement fait à la main). */
function montrerChoix(zone) {
  const choisi = zone.querySelector('[aria-pressed="true"]');
  const cle = choisi ? choisi.dataset.filtre ?? choisi.dataset.projet : '';
  if (choisi && zone.dataset.vu !== cle) {
    zone.dataset.vu = cle;
    const g = choisi.offsetLeft - zone.offsetLeft;
    if (g < zone.scrollLeft) zone.scrollLeft = g - 24;
    else if (g + choisi.offsetWidth > zone.scrollLeft + zone.clientWidth) zone.scrollLeft = g + choisi.offsetWidth - zone.clientWidth + 24;
  }
  majBords(zone);
}
function rangeeDefilante(zone) {
  zone.addEventListener('scroll', () => majBords(zone), { passive: true });
  zone.addEventListener('wheel', (e) => {
    if (zone.scrollWidth <= zone.clientWidth) return;
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!d) return;
    e.preventDefault();
    zone.scrollLeft += e.deltaMode === 1 ? d * 30 : d;
  }, { passive: false });
  // Souris : clic maintenu et glisser. Un vrai glissement n'est pas un clic sur la pastille.
  let depart = null;
  let aGlisse = false;
  zone.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || zone.scrollWidth <= zone.clientWidth) return;
    depart = { x: e.clientX, gauche: zone.scrollLeft };
    aGlisse = false;
  });
  window.addEventListener('pointermove', (e) => {
    if (!depart) return;
    const dx = e.clientX - depart.x;
    if (!aGlisse && Math.abs(dx) < 5) return;
    aGlisse = true;
    zone.classList.add('defile');
    zone.scrollLeft = depart.gauche - dx;
  });
  window.addEventListener('pointerup', () => {
    if (!depart) return;
    depart = null;
    zone.classList.remove('defile');
  });
  zone.addEventListener('click', (e) => {
    if (aGlisse) { e.stopPropagation(); e.preventDefault(); aGlisse = false; }
  }, true);
  new ResizeObserver(() => majBords(zone)).observe(zone);
}
rangeeDefilante($('#filtres'));
rangeeDefilante($('#projets'));

// ---------- projets : renommer, fusionner, retirer (Claude les crée ; Jérémie peut corriger) ----------
/** Tous les projets des éléments en cours (tâches et notes), quel que soit l'onglet. */
function tousLesProjets() {
  const vus = new Map();
  for (const i of etat.items) {
    const cle = cleProjet(i.projet);
    if (!cle) continue;
    const p = vus.get(cle) || { cle, nom: i.projet.trim(), taches: 0, notes: 0 };
    if (TYPES_NOTES.includes(i.type)) p.notes++; else p.taches++;
    vus.set(cle, p);
  }
  return [...vus.values()].sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
}
function majListeProjets() {
  $('#projets-connus').innerHTML = tousLesProjets().map((p) => `<option value="${echap(p.nom)}"></option>`).join('');
}

/** Change le nom de projet d'un ensemble d'éléments, avec une ligne de journal pour chacun. */
async function poserProjet(items, nom, action) {
  if (!items.length) return true;
  const { error } = await sb.from('items').update({ projet: nom }).in('id', items.map((i) => i.id));
  if (error) { toast('Modification impossible : ' + error.message); charger(); return false; }
  await sb.from('journal').insert(items.map((i) => ({ item_id: i.id, action, avant: { projet: i.projet ?? null }, apres: { projet: nom }, par: 'jeremie' })));
  return true;
}

async function changerProjet(item, saisi) {
  let nom = saisi.trim().replace(/\s+/g, ' ') || null;
  // Même projet qu'un existant (casse près) : on reprend son nom exact pour ne pas créer un doublon.
  const existant = nom && tousLesProjets().find((p) => p.cle === cleProjet(nom));
  if (existant) nom = existant.nom;
  if ((nom || null) === ((item.projet || '').trim() || null)) return;
  if (await poserProjet([item], nom, 'projet_change')) {
    toast(nom ? 'Projet : « ' + nom + ' ».' : 'Retiré de son projet.');
    charger();
  }
}

function afficherGestionProjets() {
  const projets = tousLesProjets();
  const compte = (p) => [p.taches && `${p.taches} tâche${p.taches > 1 ? 's' : ''}`, p.notes && `${p.notes} note${p.notes > 1 ? 's' : ''}`].filter(Boolean).join(', ');
  $('#liste-projets').innerHTML = projets.length ? projets.map((p) => `
    <li>
      <input value="${echap(p.nom)}" maxlength="60" aria-label="Nom du projet" data-renommer-projet="${echap(p.cle)}">
      <span class="discret petit compte-projet">${compte(p)}</span>
      <button class="rond petit" data-retirer-projet="${echap(p.cle)}" aria-label="Supprimer le projet" title="Supprimer le projet">✕</button>
    </li>`).join('') : '<li class="discret">Aucun projet pour l\'instant.</li>';
}
function ouvrirGestionProjets() { afficherGestionProjets(); $('#dlg-projets').hidden = false; }
function fermerGestionProjets() { $('#dlg-projets').hidden = true; }

async function renommerProjet(cle, saisi) {
  const nom = saisi.trim().replace(/\s+/g, ' ');
  const p = tousLesProjets().find((x) => x.cle === cle);
  if (!p || !nom || nom === p.nom) { afficherGestionProjets(); return; }
  const cible = tousLesProjets().find((x) => x.cle === cleProjet(nom) && x.cle !== cle);
  if (cible && !confirm(`« ${cible.nom} » existe déjà. Fusionner « ${p.nom} » dedans ?`)) { afficherGestionProjets(); return; }
  const nomFinal = cible ? cible.nom : nom;
  const items = etat.items.filter((i) => cleProjet(i.projet) === cle);
  if (!(await poserProjet(items, nomFinal, cible ? 'projet_fusionne' : 'projet_renomme'))) return;
  if (etat.projet === cle) { etat.projet = cleProjet(nomFinal); ecrire('projet', etat.projet); }
  toast(cible ? `Fusionné dans « ${nomFinal} ».` : `Renommé en « ${nomFinal} ».`);
  charger();
}

async function retirerProjet(cle) {
  const p = tousLesProjets().find((x) => x.cle === cle);
  if (!p) return;
  const msg = `Supprimer le projet « ${p.nom} » ? Ses éléments restent dans ta liste, sans projet.`
    + (p.notes ? ' Claude rangera les notes dans un autre projet au prochain tri.' : '');
  if (!confirm(msg)) return;
  const items = etat.items.filter((i) => cleProjet(i.projet) === cle);
  if (!(await poserProjet(items, null, 'projet_supprime'))) return;
  if (etat.projet === cle) { etat.projet = ''; ecrire('projet', ''); }
  toast(`Projet « ${p.nom} » supprimé.`);
  charger();
}

$('#liste-projets').addEventListener('change', (e) => {
  const c = e.target.closest('[data-renommer-projet]');
  if (c) renommerProjet(c.dataset.renommerProjet, c.value);
});
$('#liste-projets').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('[data-renommer-projet]')) e.target.blur();
});
$('#liste-projets').addEventListener('click', (e) => {
  const b = e.target.closest('[data-retirer-projet]');
  if (b) retirerProjet(b.dataset.retirerProjet);
});
$('#btn-fermer-projets').addEventListener('click', fermerGestionProjets);
$('#dlg-projets').addEventListener('click', (e) => { if (e.target.id === 'dlg-projets') fermerGestionProjets(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#dlg-projets').hidden) fermerGestionProjets(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('[data-projet-de]')) { e.preventDefault(); e.target.blur(); }
});

// ---------- glisser-déposer des tâches : changer d'horizon ou d'ordre ----------
// Souris : on attrape une tâche et on la fait glisser. Téléphone : appui long, puis on glisse.
// Lâchée sur le titre d'une section (même repliée), elle va en tête de cette section.
const RANGS_HORIZON = { maintenant: 0, bientot: 1, plus_tard: 2, un_jour: 3 };
let glisse = null; // { item, el, x0, y0, actif, tactile, minuteur, fantome, repere, cible, recharger, ouvrirMinuteur }

function horizonSelonEcheance(echeance) {
  const jours = Math.round((dateDe(echeance) - dateDe(aujourdhui())) / 86400e3);
  return jours <= 1 ? 'maintenant' : jours <= 7 ? 'bientot' : jours <= 30 ? 'plus_tard' : 'un_jour';
}

document.addEventListener('pointerdown', (e) => {
  if (BUREAU || glisse || (e.pointerType === 'mouse' && e.button !== 0)) return;
  const el = e.target.closest('#vue-liste .horizon:not(.a-trier) > .items > .item');
  if (!el || e.target.closest('button, input, select, textarea, a, label, .details')) return;
  const item = etat.items.find((i) => i.id === el.dataset.id);
  if (!item || item.etat === 'a_trier') return;
  glisse = { item, el, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, actif: false, tactile: e.pointerType !== 'mouse', id: e.pointerId };
  if (glisse.tactile) glisse.minuteur = setTimeout(() => commencerGlisse(), 420);
});

function commencerGlisse() {
  const g = glisse;
  if (!g || g.actif) return;
  g.actif = true;
  const r = g.el.getBoundingClientRect();
  g.dx = g.x0 - r.left;
  g.dy = g.y0 - r.top;
  g.fantome = g.el.cloneNode(true);
  g.fantome.classList.add('fantome');
  g.fantome.style.width = r.width + 'px';
  document.body.append(g.fantome);
  g.repere = document.createElement('li');
  g.repere.className = 'repere';
  g.el.classList.add('glisse-origine');
  document.body.classList.add('glisse-en-cours');
  window.getSelection?.()?.removeAllRanges();
  if (g.tactile) navigator.vibrate?.(15);
  bougerGlisse();
  defilerAuto();
}

function annulerGlisse() {
  const g = glisse;
  if (!g) return;
  clearTimeout(g.minuteur);
  clearTimeout(g.ouvrirMinuteur);
  g.fantome?.remove();
  g.repere?.remove();
  g.el.classList.remove('glisse-origine');
  document.querySelectorAll('.horizon.cible').forEach((d) => d.classList.remove('cible'));
  document.body.classList.remove('glisse-en-cours');
  glisse = null;
  if (g.recharger) charger();
}

/** Où la tâche tomberait : { horizon, avant (id) | enTete | fin }. Place le repère. */
function bougerGlisse() {
  const g = glisse;
  g.fantome.style.transform = `translate(${g.x - g.dx}px, ${g.y - g.dy}px)`;
  const sous = document.elementFromPoint(g.x, g.y);
  const details = sous?.closest('#vue-liste details.horizon[data-section]:not(.a-trier)');
  document.querySelectorAll('.horizon.cible').forEach((d) => { if (d !== details) d.classList.remove('cible'); });
  if (!details) { g.repere.remove(); g.cible = null; clearTimeout(g.ouvrirMinuteur); g.surTitre = null; return; }
  const horizon = details.dataset.section;
  const ul = details.querySelector(':scope > .items');
  const surTitre = !!sous.closest('summary') || !details.open || !ul;
  if (surTitre) {
    g.repere.remove();
    details.classList.add('cible');
    g.cible = { horizon, enTete: true };
    // Rester un instant sur une section repliée l'ouvre, pour choisir la place exacte.
    if (!details.open && g.surTitre !== details) {
      clearTimeout(g.ouvrirMinuteur);
      g.ouvrirMinuteur = setTimeout(() => { if (glisse === g) { details.open = true; bougerGlisse(); } }, 700);
    }
    g.surTitre = details;
    return;
  }
  clearTimeout(g.ouvrirMinuteur);
  g.surTitre = null;
  details.classList.remove('cible');
  const cartes = [...ul.querySelectorAll(':scope > .item')].filter((c) => c !== g.el);
  const suivante = cartes.find((c) => { const r = c.getBoundingClientRect(); return g.y < r.top + r.height / 2; });
  if (suivante) {
    if (g.repere.nextElementSibling !== suivante) ul.insertBefore(g.repere, suivante);
    g.cible = { horizon, avant: suivante.dataset.id };
  } else {
    if (g.repere.parentNode !== ul || g.repere.nextElementSibling) ul.append(g.repere);
    g.cible = { horizon, fin: true };
  }
}

// Près du haut ou du bas de l'écran, la liste défile toute seule.
function defilerAuto() {
  const g = glisse;
  if (!g || !g.actif) return;
  const haut = ($('.entete')?.getBoundingClientRect().bottom || 0) + 50;
  const bas = ($('#form-ajout')?.getBoundingClientRect().top || innerHeight) - 50;
  const v = g.y < haut ? -Math.min(18, (haut - g.y) / 3 + 2) : g.y > bas ? Math.min(18, (g.y - bas) / 3 + 2) : 0;
  if (v) { scrollBy(0, v); bougerGlisse(); }
  requestAnimationFrame(defilerAuto);
}

document.addEventListener('pointermove', (e) => {
  const g = glisse;
  if (!g || e.pointerId !== g.id) return;
  g.x = e.clientX;
  g.y = e.clientY;
  if (!g.actif) {
    const loin = Math.hypot(g.x - g.x0, g.y - g.y0);
    if (g.tactile ? loin > 10 : loin > 6) {
      if (g.tactile) annulerGlisse(); // le doigt bouge avant l'appui long : c'est un défilement
      else commencerGlisse();
    }
    return;
  }
  bougerGlisse();
});
// Une fois l'appui long passé, le doigt fait glisser la tâche au lieu de faire défiler la page.
document.addEventListener('touchmove', (e) => { if (glisse?.actif) e.preventDefault(); }, { passive: false });
document.addEventListener('contextmenu', (e) => { if (glisse) e.preventDefault(); });
document.addEventListener('pointercancel', (e) => { if (glisse && e.pointerId === glisse.id) annulerGlisse(); });
document.addEventListener('pointerup', (e) => {
  const g = glisse;
  if (!g || e.pointerId !== g.id) return;
  if (!g.actif) { annulerGlisse(); return; }
  const cible = g.cible;
  // Le relâchement ne doit pas ouvrir la fiche de la tâche.
  const bloquer = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
  document.addEventListener('click', bloquer, { capture: true, once: true });
  setTimeout(() => document.removeEventListener('click', bloquer, { capture: true }), 50);
  g.recharger = false;
  annulerGlisse();
  if (cible) deplacer(g.item, cible);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && glisse) annulerGlisse(); });

/** Range la tâche dans l'horizon choisi, à la place choisie, et renumérote l'ordre de cet horizon (1 = en tête). */
async function deplacer(item, { horizon, avant, enTete }) {
  const voisins = etat.items.filter((i) => i.id !== item.id && i.horizon === horizon && i.etat !== 'a_trier' && TYPES_LISTE.includes(i.type));
  let pos = enTete ? 0 : avant ? voisins.findIndex((i) => i.id === avant) : voisins.length;
  if (pos < 0) pos = voisins.length;
  voisins.splice(pos, 0, item);
  const avantDeplacement = { horizon: item.horizon, ordre: item.ordre ?? null };
  const changes = [];
  voisins.forEach((i, k) => {
    const champs = {};
    if (i.ordre !== k + 1) champs.ordre = k + 1;
    if (i === item && i.horizon !== horizon) champs.horizon = horizon;
    if (Object.keys(champs).length) changes.push({ i, champs, ancien: { horizon: i.horizon, ordre: i.ordre ?? null } });
  });
  if (!changes.length) return;
  // Tout de suite à l'écran, puis dans la base.
  for (const c of changes) Object.assign(c.i, c.champs);
  etat.items.sort((a, b) => (a.ordre ?? 1e9) - (b.ordre ?? 1e9) || a.cree_le.localeCompare(b.cree_le));
  if (horizon !== avantDeplacement.horizon) etat.sections[horizon] ??= true;
  afficher();
  const res = await Promise.all(changes.map((c) => sb.from('items').update(c.champs).eq('id', c.i.id)));
  const err = res.find((r) => r.error);
  if (err) { toast('Déplacement impossible : ' + err.error.message); charger(); return; }
  await sb.from('journal').insert({ item_id: item.id, action: 'deplace', avant: avantDeplacement, apres: { horizon, ordre: item.ordre }, par: 'jeremie' });
  const nom = HORIZONS.find((h) => h.cle === horizon)?.nom || horizon;
  let message = horizon !== avantDeplacement.horizon ? `Déplacée dans « ${nom} ».` : 'Ordre modifié.';
  if (item.echeance && RANGS_HORIZON[horizon] > RANGS_HORIZON[horizonSelonEcheance(item.echeance)]) {
    message = `Échéance le ${dateCourte(item.echeance)} : Claude la remontera. Change l'échéance pour la garder ici.`;
  }
  toast(message, { nom: 'Annuler', faire: () => annulerDeplacement(changes) });
}

async function annulerDeplacement(changes) {
  for (const c of changes) Object.assign(c.i, c.ancien);
  etat.items.sort((a, b) => (a.ordre ?? 1e9) - (b.ordre ?? 1e9) || a.cree_le.localeCompare(b.cree_le));
  afficher();
  await Promise.all(changes.map((c) => sb.from('items').update(c.ancien).eq('id', c.i.id)));
  const item = changes.find((c) => 'horizon' in c.champs)?.i || changes[0].i;
  await sb.from('journal').insert({ item_id: item.id, action: 'deplace', apres: { annule: true }, par: 'jeremie' });
  charger();
}

demarrer();
