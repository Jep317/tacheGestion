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
  vue: 'liste',
  categories: [],            // catégories choisies par Jérémie (table categories)
  filtre: lire('filtre') || 'tout', // 'tout', 'aucune' ou l'id d'une catégorie
  recherche: '',
  ouverts: new Set(),        // éléments dont on affiche le détail
  sections: BUREAU ? {} : JSON.parse(lire('sections') || '{}'),
};

// ---------- utilitaires ----------
function lire(cle) { try { return localStorage.getItem('taches.' + cle); } catch { return null; } }
function ecrire(cle, v) { try { localStorage.setItem('taches.' + cle, v); } catch { /* navigation privée */ } }
function echap(t) {
  return String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'items' }, charger)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'categories' }, charger)
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
async function charger() {
  const [items, cats] = await Promise.all([
    sb.from('items')
      .select('id, texte_brut, titre, details, type, categorie_id, horizon, etat, theme, projet, ordre, echeance, cree_le')
      .in('etat', ['a_trier', 'a_faire', 'en_cours'])
      .order('ordre', { ascending: true, nullsFirst: false })
      .order('cree_le', { ascending: true }),
    sb.from('categories').select('id, nom, ordre').order('ordre').order('nom'),
  ]);
  const error = items.error || cats.error;
  if (error) { toast('Impossible de charger la liste : ' + error.message); return; }
  etat.items = items.data;
  etat.categories = cats.data;
  if (etat.filtre !== 'tout' && etat.filtre !== 'aucune' && !categorie(etat.filtre)) etat.filtre = 'tout';
  afficherFiltres();
  afficher();
  if (!$('#dlg-categories').hidden) afficherGestion();
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

async function changerEtat(item, nouvelEtat) {
  const avant = { etat: item.etat };
  const maj = { etat: nouvelEtat, fait_le: nouvelEtat === 'fait' ? new Date().toISOString() : null };
  const { error } = await sb.from('items').update(maj).eq('id', item.id);
  if (error) { toast('Modification impossible : ' + error.message); return; }
  await sb.from('journal').insert({
    item_id: item.id, action: nouvelEtat === 'fait' ? 'termine' : 'modifie', avant, apres: maj, par: 'appli',
  });
  charger();
}

async function changerCategorie(item, categorieId) {
  const avant = { categorie_id: item.categorie_id };
  const apres = { categorie_id: categorieId || null };
  const { error } = await sb.from('items').update(apres).eq('id', item.id);
  if (error) { toast('Modification impossible : ' + error.message); return; }
  await sb.from('journal').insert({ item_id: item.id, action: 'modifie', avant, apres, par: 'appli' });
  charger();
}

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

function carte(i, { cocher = true } = {}) {
  const brut = !i.titre;
  const ouvert = etat.ouverts.has(i.id);
  const tags = [];
  const cat = categorie(i.categorie_id);
  if (etat.filtre === 'tout' && cat) tags.push(`<span class="tag cat c${couleur(cat.id)}">${echap(cat.nom)}</span>`);
  if (i.type === 'course') tags.push('<span class="tag">Course</span>');
  if (i.type === 'idee') tags.push('<span class="tag">Idée</span>');
  if (i.etat === 'en_cours') tags.push('<span class="tag">En cours</span>');
  if (i.echeance) tags.push(`<span class="tag echeance">${dateCourte(i.echeance)}</span>`);
  if (i.theme) tags.push(`<span>${echap(i.theme)}</span>`);
  if (i.projet) tags.push(`<span>· ${echap(i.projet)}</span>`);

  let detail = '';
  if (ouvert) {
    const morceaux = [];
    if (i.details) morceaux.push(`<p>${echap(i.details)}</p>`);
    if (!brut) morceaux.push(`<p>« ${echap(i.texte_brut)} »</p>`);
    if (cocher && i.etat !== 'en_cours') morceaux.push(`<p><button class="lien" data-action="en_cours" data-id="${i.id}">Marquer en cours</button></p>`);
    if (etat.categories.length) {
      const options = [`<option value="">${i.etat === 'a_trier' ? 'Laisser Claude choisir' : 'Sans catégorie'}</option>`]
        .concat(etat.categories.map((c) => `<option value="${c.id}" ${c.id === i.categorie_id ? 'selected' : ''}>${echap(c.nom)}</option>`));
      morceaux.push(`<p><label class="choix-cat">Catégorie <select data-categorie-de="${i.id}">${options.join('')}</select></label></p>`);
    }
    detail = `<div class="details">${morceaux.join('') || '<p>Rien de plus.</p>'}</div>`;
  }

  return `<li class="item${brut ? ' brut' : ''}" data-id="${i.id}">
    ${cocher ? `<button class="case" data-action="fait" data-id="${i.id}" aria-label="Marquer comme fait" title="Fait"></button>` : '<span></span>'}
    <div class="corps" data-action="ouvrir" data-id="${i.id}">
      <div class="titre">${echap(i.titre || i.texte_brut)}</div>
      ${tags.length ? `<div class="meta">${tags.join('')}</div>` : ''}
    </div>
    ${detail}
  </li>`;
}

function section(cle, nom, items, ouvertParDefaut, classe = '') {
  const ouvert = etat.sections[cle] ?? ouvertParDefaut;
  return `<details class="horizon ${classe}" data-section="${cle}" ${ouvert ? 'open' : ''}>
    <summary>${nom} <span class="compte">${items.length}</span></summary>
    ${items.length ? `<ul class="items">${items.map((i) => carte(i)).join('')}</ul>` : '<div class="vide">Rien ici.</div>'}
  </details>`;
}

function afficher() {
  // Liste par horizon
  const liste = etat.items.filter((i) => filtreCategorie(i));
  const aTrier = liste.filter((i) => i.etat === 'a_trier');
  let html = '';
  if (aTrier.length) html += section('a_trier', 'À trier', aTrier, true, 'a-trier');
  for (const h of HORIZONS) {
    html += section(h.cle, h.nom, liste.filter((i) => i.etat !== 'a_trier' && i.horizon === h.cle && TYPES_LISTE.includes(i.type)), h.ouvert);
  }
  if (BUREAU) {
    const maintenant = new Date();
    html = `<div class="date-bureau">${maintenant.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })}</div>` + html;
  }
  $('#vue-liste').innerHTML = html;

  // Notes et idées
  const q = etat.recherche.toLowerCase();
  const notes = liste
    .filter((i) => i.etat !== 'a_trier' && TYPES_NOTES.includes(i.type))
    .filter((i) => !q || [i.titre, i.texte_brut, i.details, i.theme, i.projet].some((t) => (t || '').toLowerCase().includes(q)));
  $('#liste-notes').innerHTML = notes.length
    ? `<ul class="items">${notes.map((i) => carte(i, { cocher: false })).join('')}</ul>`
    : `<div class="vide">${q ? 'Aucune note ne correspond.' : 'Pas encore de notes.'}</div>`;
}

// ---------- interactions ----------
document.addEventListener('click', (e) => {
  const cible = e.target.closest('[data-action]');
  if (!cible) return;
  const item = etat.items.find((i) => i.id === cible.dataset.id);
  if (!item) return;
  const action = cible.dataset.action;
  if (action === 'ouvrir') {
    etat.ouverts.has(item.id) ? etat.ouverts.delete(item.id) : etat.ouverts.add(item.id);
    afficher();
  } else if (action === 'fait') {
    const ancien = item.etat;
    changerEtat(item, 'fait');
    toast('Fait : ' + (item.titre || item.texte_brut), { nom: 'Annuler', faire: () => changerEtat({ ...item, etat: 'fait' }, ancien) });
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
}));

$('#filtres').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.hasAttribute('data-gerer')) ouvrirGestion();
  else choisirFiltre(b.dataset.filtre);
});

document.addEventListener('change', (e) => {
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

$('#recherche').addEventListener('input', (e) => { etat.recherche = e.target.value; afficher(); });

// ---------- ajout et dictée ----------
const saisie = $('#saisie');
let sourceSaisie = 'app';
function ajusterHauteur() { saisie.style.height = 'auto'; saisie.style.height = saisie.scrollHeight + 'px'; }
saisie.addEventListener('input', ajusterHauteur);
saisie.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#form-ajout').requestSubmit(); }
});
$('#form-ajout').addEventListener('submit', async (e) => {
  e.preventDefault();
  arreterDictee();
  if (await ajouter(saisie.value, sourceSaisie)) {
    saisie.value = '';
    sourceSaisie = 'app';
    ajusterHauteur();
  }
});

const Reconnaissance = window.SpeechRecognition || window.webkitSpeechRecognition;
let reco = null;
const micro = $('#btn-micro');
if (!Reconnaissance) micro.hidden = true;

function demarrerDictee() {
  if (!Reconnaissance || reco) return;
  reco = new Reconnaissance();
  reco.lang = 'fr-FR';
  reco.interimResults = true;
  reco.continuous = false;
  const debut = saisie.value ? saisie.value.trimEnd() + ' ' : '';
  reco.onresult = (ev) => {
    let texte = '';
    for (const r of ev.results) texte += r[0].transcript;
    saisie.value = debut + texte;
    sourceSaisie = 'vocal';
    ajusterHauteur();
  };
  reco.onerror = (ev) => { if (ev.error !== 'no-speech' && ev.error !== 'aborted') toast('Dictée impossible : ' + ev.error); };
  reco.onend = () => { reco = null; micro.classList.remove('ecoute'); saisie.focus(); };
  micro.classList.add('ecoute');
  reco.start();
}
function arreterDictee() { if (reco) reco.stop(); }
micro.addEventListener('click', () => (reco ? arreterDictee() : demarrerDictee()));

// Raccourcis Android « Ajouter » et « Dicter » (?ajout=1, ?vocal=1)
function actionsDeLancement() {
  const p = new URLSearchParams(location.search);
  if (p.has('ajout')) saisie.focus();
  if (p.has('vocal')) demarrerDictee();
  if (p.has('categories')) ouvrirGestion();
  if (p.has('ajout') || p.has('vocal') || p.has('categories')) history.replaceState(null, '', location.pathname + (BUREAU ? '?bureau=1' : ''));
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// En fond d'écran, la page reste ouverte des jours : on rafraîchit la date et la liste de temps en temps.
if (BUREAU) setInterval(() => { charger(); }, 15 * 60 * 1000);

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
  document.body.classList.add('panneau');
}

demarrer();
