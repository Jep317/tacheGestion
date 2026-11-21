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

const etat = {
  items: [],
  vue: 'liste',
  espace: lire('espace') || 'tout',
  recherche: '',
  ouverts: new Set(),        // éléments dont on affiche le détail
  sections: JSON.parse(lire('sections') || '{}'),
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
  const { data, error } = await sb
    .from('items')
    .select('id, texte_brut, titre, details, type, espace, horizon, etat, theme, projet, ordre, echeance, cree_le')
    .in('etat', ['a_trier', 'a_faire', 'en_cours'])
    .order('ordre', { ascending: true, nullsFirst: false })
    .order('cree_le', { ascending: true });
  if (error) { toast('Impossible de charger la liste : ' + error.message); return; }
  etat.items = data;
  afficher();
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

// ---------- affichage ----------
function filtreEspace(i) { return etat.espace === 'tout' || i.espace === etat.espace; }

function carte(i, { cocher = true } = {}) {
  const brut = !i.titre;
  const ouvert = etat.ouverts.has(i.id);
  const tags = [];
  if (etat.espace === 'tout' && i.etat !== 'a_trier') tags.push(`<span class="tag ${i.espace}">${i.espace === 'famille' ? 'Famille' : 'Perso'}</span>`);
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
  const liste = etat.items.filter((i) => filtreEspace(i));
  const aTrier = liste.filter((i) => i.etat === 'a_trier');
  let html = '';
  if (aTrier.length) html += section('a_trier', 'À trier', aTrier, true, 'a-trier');
  for (const h of HORIZONS) {
    html += section(h.cle, h.nom, liste.filter((i) => i.etat !== 'a_trier' && i.horizon === h.cle && TYPES_LISTE.includes(i.type)), h.ouvert);
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
    ecrire('sections', JSON.stringify(etat.sections));
  }
}, true);

document.querySelectorAll('[data-vue]').forEach((b) => b.addEventListener('click', () => {
  etat.vue = b.dataset.vue;
  document.querySelectorAll('[data-vue]').forEach((x) => x.setAttribute('aria-selected', x === b));
  $('#vue-liste').hidden = etat.vue !== 'liste';
  $('#vue-notes').hidden = etat.vue !== 'notes';
}));

function choisirEspace(esp) {
  etat.espace = esp;
  ecrire('espace', esp);
  document.querySelectorAll('[data-espace]').forEach((x) => x.setAttribute('aria-pressed', x.dataset.espace === esp));
  afficher();
}
document.querySelectorAll('[data-espace]').forEach((b) => b.addEventListener('click', () => choisirEspace(b.dataset.espace)));
choisirEspace(etat.espace);

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
  if (p.has('ajout') || p.has('vocal')) history.replaceState(null, '', location.pathname);
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

demarrer();
