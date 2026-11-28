// Notes mises en forme : le texte est rangé en Markdown simple dans items.details
// (lisible tel quel sur le widget Android et par Claude), affiché comme un article,
// et écrit dans un éditeur plein écran façon Calm Writer.

function echap(t) {
  return String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Gras, italique, liens, barré, dans une ligne déjà échappée. */
function enLigne(t) {
  return echap(t)
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, txt, url) => `<a href="${url}" target="_blank" rel="noopener">${txt}</a>`)
    .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+?)~~/g, '<s>$1</s>');
}

/** Markdown simple -> HTML sûr (tout est échappé avant d'ajouter nos balises). */
export function rendreMarkdown(md) {
  const lignes = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let liste = null; // { type: 'ul'|'ol', items: [] }
  let citation = [];
  const fermer = () => {
    if (para.length) { out.push(`<p>${para.map(enLigne).join('<br>')}</p>`); para = []; }
    if (liste) { out.push(`<${liste.type}>${liste.items.map((x) => `<li>${enLigne(x)}</li>`).join('')}</${liste.type}>`); liste = null; }
    if (citation.length) { out.push(`<blockquote>${citation.map(enLigne).join('<br>')}</blockquote>`); citation = []; }
  };
  for (const brute of lignes) {
    const l = brute.replace(/\s+$/, '');
    let m;
    if (!l.trim()) { fermer(); continue; }
    if ((m = l.match(/^(#{1,3})\s+(.*)$/))) { fermer(); out.push(m[1].length === 3 ? `<h3>${enLigne(m[2])}</h3>` : `<h2>${enLigne(m[2])}</h2>`); continue; }
    if (/^(-{3,}|\*{3,})$/.test(l.trim())) { fermer(); out.push('<hr>'); continue; }
    if ((m = l.match(/^>\s?(.*)$/))) { if (para.length || liste) { const c = citation; citation = []; fermer(); citation = c; } citation.push(m[1]); continue; }
    if ((m = l.match(/^\s*[-*•]\s+(.*)$/))) {
      if (!liste || liste.type !== 'ul') { fermer(); liste = { type: 'ul', items: [] }; }
      liste.items.push(m[1]); continue;
    }
    if ((m = l.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (!liste || liste.type !== 'ol') { fermer(); liste = { type: 'ol', items: [] }; }
      liste.items.push(m[1]); continue;
    }
    if (liste || citation.length) fermer();
    para.push(l);
  }
  fermer();
  return out.join('');
}

/** Le texte sans les marques de mise en forme (aperçu dans la liste, comptage de mots). */
export function texteSimple(md) {
  return String(md || '')
    .replace(/^\s{0,3}(#{1,3}|>|[-*•]|\d+[.)])\s+/gm, '')
    .replace(/^(-{3,}|\*{3,})$/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*|~~/g, '')
    .replace(/(^|\W)[*_]([^*_\n]+)[*_](?=\W|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

export function nombreDeMots(md) { const t = texteSimple(md); return t ? t.split(' ').length : 0; }
export function tempsDeLecture(md) { return Math.max(1, Math.round(nombreDeMots(md) / 220)); }

// ---------- éditeur : HTML de l'éditeur -> Markdown ----------
function inlineMd(noeud) {
  let s = '';
  for (const n of noeud.childNodes) {
    if (n.nodeType === 3) { s += n.nodeValue.replace(/ /g, ' '); continue; }
    if (n.nodeType !== 1) continue;
    const tag = n.tagName;
    const dedans = inlineMd(n);
    if (tag === 'BR') s += '\n';
    else if (!dedans.trim()) s += dedans;
    else if (tag === 'B' || tag === 'STRONG' || (tag === 'SPAN' && /bold|[6-9]00/.test(n.style.fontWeight))) s += entourer(dedans, '**');
    else if (tag === 'I' || tag === 'EM' || (tag === 'SPAN' && n.style.fontStyle === 'italic')) s += entourer(dedans, '*');
    else if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') s += entourer(dedans, '~~');
    else if (tag === 'A' && /^https?:/.test(n.getAttribute('href') || '')) s += `[${dedans}](${n.getAttribute('href')})`;
    else if (['DIV', 'P'].includes(tag)) s += (s && !s.endsWith('\n') ? '\n' : '') + dedans;
    else s += dedans;
  }
  return s;
}
// Les espaces restent à l'extérieur des marques : « **mot** » et pas « ** mot** ».
function entourer(t, m) {
  const a = t.match(/^\s*/)[0];
  const b = t.match(/\s*$/)[0];
  return a + m + t.trim() + m + b;
}

export function htmlVersMarkdown(racine) {
  const blocs = [];
  const ajouter = (t) => { if (t != null) blocs.push(t); };
  for (const n of racine.childNodes) {
    if (n.nodeType === 3) { if (n.nodeValue.trim()) ajouter(n.nodeValue.trim()); continue; }
    if (n.nodeType !== 1) continue;
    const tag = n.tagName;
    const txt = inlineMd(n).replace(/\n+$/, '');
    if (tag === 'H1' || tag === 'H2') { if (txt.trim()) ajouter('## ' + txt.replace(/\n/g, ' ').trim()); }
    else if (tag === 'H3' || tag === 'H4') { if (txt.trim()) ajouter('### ' + txt.replace(/\n/g, ' ').trim()); }
    else if (tag === 'BLOCKQUOTE') { if (txt.trim()) ajouter(txt.split('\n').map((l) => '> ' + l).join('\n')); }
    else if (tag === 'UL' || tag === 'OL') {
      const items = [...n.children].filter((li) => li.tagName === 'LI').map((li) => inlineMd(li).replace(/\n+/g, ' ').trim()).filter(Boolean);
      if (items.length) ajouter(items.map((x, k) => (tag === 'OL' ? `${k + 1}. ` : '- ') + x).join('\n'));
    } else if (tag === 'HR') ajouter('---');
    else if (tag === 'BR') ajouter('');
    else ajouter(txt);
  }
  // Paragraphes séparés par une ligne vide ; les paragraphes vides consécutifs sont fusionnés.
  return blocs.join('\n\n').replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '');
}

// ---------- éditeur plein écran ----------
let ouvert = null;

/**
 * Ouvre l'éditeur plein écran pour une note.
 * enregistrer({ titre, details }) est appelé pendant l'écriture (après une pause) et à la fermeture.
 */
export function ouvrirEcrivain({ titre, details, enregistrer, fermer: quandFerme }) {
  if (ouvert) ouvert.fermer();
  document.execCommand('defaultParagraphSeparator', false, 'p');
  const voile = document.createElement('div');
  voile.className = 'ecrivain';
  voile.setAttribute('role', 'dialog');
  voile.setAttribute('aria-label', 'Écrire la note');
  voile.innerHTML = `
    <div class="ecrivain-haut"><button type="button" class="ecrivain-fin">Terminé</button></div>
    <div class="ecrivain-page">
      <textarea class="ecrivain-titre" rows="1" maxlength="200" placeholder="Titre"></textarea>
      <div class="ecrivain-texte article" contenteditable="true" spellcheck="true" data-placeholder="Raconte ton histoire…"></div>
    </div>
    <div class="ecrivain-pied"><span class="mots"></span><span class="etat-sauve"></span></div>
    <div class="barre-format" role="toolbar" aria-label="Mise en forme" hidden>
      <button type="button" data-f="gras" title="Gras (Ctrl+B)"><b>B</b></button>
      <button type="button" data-f="italique" title="Italique (Ctrl+I)"><i>i</i></button>
      <button type="button" data-f="lien" title="Lien">↗</button>
      <span class="sep"></span>
      <button type="button" data-f="h2" title="Titre (# puis espace)" class="f-h2">T</button>
      <button type="button" data-f="h3" title="Sous-titre (## puis espace)" class="f-h3">T</button>
      <button type="button" data-f="citation" title="Citation (> puis espace)" class="f-cit">“</button>
      <button type="button" data-f="liste" title="Liste (- puis espace)">•</button>
    </div>`;
  document.body.appendChild(voile);
  document.body.classList.add('ecrivain-ouvert');

  const champTitre = voile.querySelector('.ecrivain-titre');
  const texte = voile.querySelector('.ecrivain-texte');
  const barre = voile.querySelector('.barre-format');
  const mots = voile.querySelector('.mots');
  const etatSauve = voile.querySelector('.etat-sauve');
  champTitre.value = titre || '';
  texte.innerHTML = rendreMarkdown(details) || '<p><br></p>';

  const hauteurTitre = () => { champTitre.style.height = 'auto'; champTitre.style.height = champTitre.scrollHeight + 'px'; };
  hauteurTitre();

  let dernier = { titre: champTitre.value.trim(), details: htmlVersMarkdown(texte) };
  let minuteur = null;
  const compter = () => { const n = nombreDeMots(htmlVersMarkdown(texte)); mots.textContent = n + (n > 1 ? ' mots' : ' mot'); };
  const sauver = async () => {
    clearTimeout(minuteur);
    const v = { titre: champTitre.value.replace(/\s+/g, ' ').trim(), details: htmlVersMarkdown(texte) };
    if (v.titre === dernier.titre && v.details === dernier.details) return;
    etatSauve.textContent = 'Enregistrement…';
    const ok = await enregistrer(v, dernier);
    if (ok !== false) { dernier = v; etatSauve.textContent = 'Enregistré'; } else etatSauve.textContent = 'Non enregistré';
  };
  const plusTard = () => { etatSauve.textContent = ''; clearTimeout(minuteur); minuteur = setTimeout(sauver, 1500); };
  compter();

  // Le paragraphe en cours ressort, les autres s'estompent (mode concentration).
  const blocCourant = () => {
    const sel = getSelection();
    if (!sel.rangeCount || !texte.contains(sel.anchorNode)) return null;
    let n = sel.anchorNode;
    while (n && n.parentNode !== texte) n = n.parentNode;
    return n && n.nodeType === 1 ? n : null;
  };
  const marquerActif = () => {
    const b = blocCourant();
    texte.querySelectorAll('.actif').forEach((x) => { if (x !== b) x.classList.remove('actif'); });
    if (b) b.classList.add('actif');
  };

  // Barre de mise en forme au-dessus du texte sélectionné.
  const placerBarre = () => {
    const sel = getSelection();
    if (barre.classList.contains('saisie-lien')) return;
    if (!sel.rangeCount || sel.isCollapsed || !texte.contains(sel.anchorNode)) { barre.hidden = true; return; }
    const r = sel.getRangeAt(0).getBoundingClientRect();
    barre.hidden = false;
    const l = Math.min(Math.max(8, r.left + r.width / 2 - barre.offsetWidth / 2), innerWidth - barre.offsetWidth - 8);
    const haut = r.top - barre.offsetHeight - 10;
    barre.style.left = l + 'px';
    barre.style.top = (haut < 8 ? r.bottom + 10 : haut) + 'px';
    barre.classList.toggle('dessous', haut < 8);
  };

  const dansBloc = (tags) => { const b = blocCourant(); return b && tags.includes(b.tagName); };
  // Change la forme d'un bloc (paragraphe, titre, citation, liste) sans passer par execCommand,
  // qui imbrique mal les listes dans les paragraphes.
  const curseurDans = (el, fin) => {
    const r = document.createRange(); r.selectNodeContents(el); r.collapse(!fin);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  };
  const remplir = (el) => { if (!el.textContent) { el.textContent = ''; el.appendChild(document.createElement('br')); } };
  const transformer = (b, tag) => {
    if (!b) return;
    if (b.tagName === 'UL' || b.tagName === 'OL') {
      // Liste -> un paragraphe (ou un titre, une citation) par ligne.
      const cible = tag === 'ul' || tag === 'ol' ? 'p' : tag;
      const blocs = [...b.children].map((li) => { const x = document.createElement(cible); x.append(...li.childNodes); remplir(x); return x; });
      b.replaceWith(...blocs);
      curseurDans(blocs[blocs.length - 1], true);
      return;
    }
    if (tag === 'ul' || tag === 'ol') {
      const liste = document.createElement(tag);
      const li = document.createElement('li');
      li.append(...b.childNodes);
      remplir(li);
      liste.appendChild(li);
      b.replaceWith(liste);
      curseurDans(li, true);
      return;
    }
    const x = document.createElement(tag);
    x.append(...b.childNodes);
    remplir(x);
    b.replaceWith(x);
    curseurDans(x, true);
  };
  const basculer = (tag) => {
    const b = blocCourant();
    if (b) transformer(b, b.tagName.toLowerCase() === tag ? 'p' : tag);
  };
  const format = (f) => {
    texte.focus();
    if (f === 'gras') document.execCommand('bold');
    else if (f === 'italique') document.execCommand('italic');
    else if (f === 'lien') { demanderLien(); return; }
    else if (f === 'h2') basculer('h2');
    else if (f === 'h3') basculer('h3');
    else if (f === 'citation') basculer('blockquote');
    else if (f === 'liste') basculer('ul');
    compter(); plusTard(); marquerActif(); placerBarre();
  };
  // Lien : la barre devient un petit champ d'adresse (pas de fenêtre « prompt », absente du panneau Windows).
  const demanderLien = () => {
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return;
    const plage = sel.getRangeAt(0).cloneRange();
    barre.classList.add('saisie-lien');
    const f = document.createElement('form');
    f.className = 'champ-lien';
    f.innerHTML = '<input type="url" placeholder="Coller l\'adresse puis Entrée" aria-label="Adresse du lien">';
    barre.appendChild(f);
    const champ = f.querySelector('input');
    const finir = (url) => {
      f.remove(); barre.classList.remove('saisie-lien');
      texte.focus();
      const s = getSelection(); s.removeAllRanges(); s.addRange(plage);
      if (url && /^https?:\/\/\S+$/.test(url)) { document.execCommand('createLink', false, url); compter(); plusTard(); }
      placerBarre();
    };
    f.addEventListener('submit', (e) => { e.preventDefault(); let u = champ.value.trim(); if (u && !/^https?:/.test(u)) u = 'https://' + u; finir(u); });
    champ.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finir(''); } });
    champ.addEventListener('blur', () => setTimeout(() => { if (f.isConnected) finir(''); }, 150));
    champ.focus();
  };
  barre.addEventListener('mousedown', (e) => { if (!e.target.closest('input')) e.preventDefault(); }); // garder la sélection
  barre.addEventListener('click', (e) => { const b = e.target.closest('[data-f]'); if (b) format(b.dataset.f); });

  // Raccourcis à la Medium : « # », « ## », « > », « - », « 1. » en début de paragraphe, puis espace.
  texte.addEventListener('keydown', (e) => {
    if (e.key === ' ') {
      const b = blocCourant();
      const sel = getSelection();
      if (b && b.tagName === 'P' && sel.isCollapsed) {
        const avant = b.textContent.slice(0, (() => { const r = sel.getRangeAt(0).cloneRange(); r.selectNodeContents(b); r.setEnd(sel.anchorNode, sel.anchorOffset); return r.toString().length; })());
        const regles = { '#': 'h2', '##': 'h3', '###': 'h3', '>': 'blockquote', '-': 'ul', '*': 'ul', '1.': 'ol' };
        const cible = regles[avant];
        if (cible) {
          e.preventDefault();
          // Effacer la marque tapée, puis appliquer la forme.
          const premier = document.createTreeWalker(b, NodeFilter.SHOW_TEXT).nextNode();
          if (premier) premier.nodeValue = premier.nodeValue.replace(/^\s*\S+\s?/, '');
          transformer(b, cible);
          compter(); plusTard(); marquerActif();
          return;
        }
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && dansBloc(['H2', 'H3', 'BLOCKQUOTE'])) {
      // Entrée à la fin d'un titre ou d'une citation : on repart sur un paragraphe normal.
      const b = blocCourant();
      const sel = getSelection();
      const reste = sel.getRangeAt(0).cloneRange();
      reste.setEndAfter(b);
      if (!reste.toString().trim()) {
        e.preventDefault();
        const p = document.createElement('p');
        p.appendChild(document.createElement('br'));
        b.after(p);
        const r = document.createRange(); r.setStart(p, 0); r.collapse(true);
        sel.removeAllRanges(); sel.addRange(r);
        compter(); plusTard(); marquerActif();
        return;
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); format('lien'); }
  });
  texte.addEventListener('input', () => { compter(); plusTard(); marquerActif(); });
  // Coller : seulement le texte (pas les couleurs et polices d'une page web).
  texte.addEventListener('paste', (e) => {
    e.preventDefault();
    const t = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, t);
  });
  // Un clic sur un lien pendant l'écriture ne quitte pas la note.
  texte.addEventListener('click', (e) => { if (e.target.closest('a') && (e.ctrlKey || e.metaKey)) window.open(e.target.closest('a').href, '_blank', 'noopener'); });
  const surSelection = () => { if (!ouvert) return; marquerActif(); placerBarre(); };
  document.addEventListener('selectionchange', surSelection);
  voile.querySelector('.ecrivain-page').addEventListener('scroll', () => placerBarre());

  champTitre.addEventListener('input', () => { hauteurTitre(); plusTard(); });
  champTitre.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      texte.focus();
      const r = document.createRange(); r.setStart(texte, 0); r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    }
  });

  const fermer = async () => {
    if (!ouvert) return;
    ouvert = null;
    document.removeEventListener('selectionchange', surSelection);
    document.removeEventListener('keydown', echappe, true);
    await sauver();
    voile.remove();
    document.body.classList.remove('ecrivain-ouvert');
    quandFerme?.();
  };
  const echappe = (e) => { if (e.target.closest?.('.champ-lien')) return; if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); e.stopPropagation(); fermer(); } };
  document.addEventListener('keydown', echappe, true);
  voile.querySelector('.ecrivain-fin').addEventListener('click', fermer);
  window.addEventListener('beforeunload', () => { if (ouvert) sauver(); });

  ouvert = { fermer };
  // Curseur à la fin du texte (ou dans le titre s'il est vide).
  if (!champTitre.value) champTitre.focus();
  else {
    texte.focus();
    const r = document.createRange(); r.selectNodeContents(texte); r.collapse(false);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }
  marquerActif();
  return ouvert;
}
