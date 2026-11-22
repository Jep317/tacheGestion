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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rappels' }, charger)
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
  const [items, cats, rappels] = await Promise.all([
    sb.from('items')
      .select('id, texte_brut, titre, details, type, categorie_id, horizon, etat, theme, projet, ordre, echeance, echeance_heure, recurrence, cree_le')
      .in('etat', ['a_trier', 'a_faire', 'en_cours'])
      .order('ordre', { ascending: true, nullsFirst: false })
      .order('cree_le', { ascending: true }),
    sb.from('categories').select('id, nom, ordre').order('ordre').order('nom'),
    sb.from('rappels').select('id, item_id, titre, texte, quand, relatif_min')
      .gte('quand', new Date(Date.now() - 3600e3).toISOString()).order('quand'),
  ]);
  const error = items.error || cats.error || rappels.error;
  if (error) { toast('Impossible de charger la liste : ' + error.message); return; }
  etat.items = items.data;
  etat.categories = cats.data;
  etat.rappels = rappels.data;
  planifierNotifications();
  if (etat.filtre !== 'tout' && etat.filtre !== 'aucune' && !categorie(etat.filtre)) etat.filtre = 'tout';
  afficherFiltres();
  afficher();
  if (!$('#dlg-categories').hidden) afficherGestion();
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
    .join('');
}

function choisirProjet(p) {
  etat.projet = etat.projet === p ? '' : p;
  ecrire('projet', etat.projet);
  afficher();
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
  if (i.echeance) tags.push(tagEcheance(i));
  if (i.recurrence) tags.push(`<span class="tag" title="${echap(texteRecurrence(i.recurrence))}">🔁 ${echap(texteRecurrence(i.recurrence, true))}</span>`);
  if (rappelsDe(i.id).length) tags.push(`<span class="tag" title="Rappel ${echap(dateHeure(rappelsDe(i.id)[0].quand))}">🔔</span>`);
  if (i.theme) tags.push(`<span>${echap(i.theme)}</span>`);
  if (i.projet && !etat.projet && etat.vue !== 'notes') tags.push(`<span>· ${echap(i.projet)}</span>`);

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
    if (cocher) morceaux.push(blocPlanif(i));
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
  afficherProjets();
  // Liste par horizon (« À trier » n'a pas encore de projet : on le montre toujours)
  const liste = etat.items.filter((i) => filtreCategorie(i) && (i.etat === 'a_trier' || filtreProjet(i)));
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
}

// ---------- échéance, rappels et répétition ----------
const JOURS = ['L', 'M', 'M', 'J', 'V', 'S', 'D']; // 1 = lundi … 7 = dimanche (comme la base)
const NOMS_JOURS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const UNITES = { jour: ['jour', 'jours'], semaine: ['semaine', 'semaines'], mois: ['mois', 'mois'], an: ['an', 'ans'] };

function isoJour(d) { // date locale -> 'AAAA-MM-JJ'
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function aujourdhui() { return isoJour(new Date()); }
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
  const classe = i.echeance < auj ? ' retard' : i.echeance === auj ? ' aujourdhui' : '';
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
      if (item) { etat.ouverts.add(item.id); afficher(); }
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
  afficher();
}));

// Filtre par projet : les puces de l'entête et les titres de groupe dans « Notes ».
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-projet]');
  if (b) choisirProjet(b.dataset.projet);
});

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

// ?item=<id> (bouton « Échéance, répéter… » de l'appli Android) : ouvre directement le détail de la tâche.
let itemDemande = new URLSearchParams(location.search).get('item');
function montrerItem(id) {
  const item = etat.items.find((i) => i.id === id);
  if (!item) return;
  itemDemande = null;
  if (etat.filtre !== 'tout' && !filtreCategorie(item)) choisirFiltre('tout');
  if (etat.projet && !filtreProjet(item)) etat.projet = '';
  etat.sections[item.etat === 'a_trier' ? 'a_trier' : item.horizon] = true;
  etat.ouverts.add(id);
  afficher();
  document.querySelector(`.item[data-id="${id}"]`)?.scrollIntoView({ block: 'center' });
}

// Raccourcis Android « Ajouter » et « Dicter » (?ajout=1, ?vocal=1)
function actionsDeLancement() {
  const p = new URLSearchParams(location.search);
  if (p.has('ajout')) saisie.focus();
  if (p.has('vocal')) demarrerDictee();
  if (p.has('categories')) ouvrirGestion();
  if (p.has('ajout') || p.has('vocal') || p.has('categories') || p.has('item')) history.replaceState(null, '', location.pathname + (BUREAU ? '?bureau=1' : ''));
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});


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
  document.body.classList.add('panneau');
}

demarrer();
