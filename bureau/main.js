// Tâches sur le bureau Windows : un panneau qui affiche l'appli web (même liste, même compte),
// à droite de l'écran, qu'on montre ou cache au clavier.
//   Ctrl+Alt+T : afficher / masquer le panneau
//   Ctrl+Alt+N : ouvrir le panneau directement dans le champ d'ajout
//   Échap      : masquer le panneau
// L'icône près de l'horloge donne les mêmes actions, plus « Toujours au premier plan »,
// « Lancer au démarrage de Windows » et « Quitter ».
const { app, BrowserWindow, Tray, Menu, globalShortcut, nativeImage, screen, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

const ADRESSE = 'https://jep317.github.io/tacheGestion/';
const RACCOURCI_PANNEAU = 'Control+Alt+T';
const RACCOURCI_AJOUT = 'Control+Alt+N';
const LARGEUR = 420;
const BARRE = { width: 150, height: 36 }; // panneau réduit : une petite barre « Tâches »

// Retouches d'affichage propres au panneau : on peut déplacer la fenêtre par l'en-tête,
// et le micro est caché (la dictée du navigateur ne marche pas ici ; Windows+H dicte dans n'importe quel champ).
const CSS_PANNEAU = `
  .entete, .connexion h1 { -webkit-app-region: drag; }
  .entete button, .entete input, .entete a { -webkit-app-region: no-drag; }
  body.verrouille .entete, body.verrouille .connexion h1 { -webkit-app-region: no-drag; }
  #btn-micro { display: none !important; }
`;

app.setAppUserModelId('com.jep317.taches');

// Electron met le nom de l'appli (« Tâches ») dans l'en-tête User-Agent, et l'envoie en Latin-1.
// Supabase rejette alors la connexion (« Database error granting user ») : on garde un User-Agent en ASCII pur.
app.userAgentFallback = app.userAgentFallback
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^\x20-\x7e]/g, '') +
  // Marqueur lu par le site : il n'affiche le bouton « masquer » que dans un panneau qui sait le traiter.
  ' TachesPanneau/4'; // 2 : sait aussi verrouiller la position ; 3 : sait se réduire en petite barre ;
                      // 4 : sait ouvrir une note en grand dans sa propre fenêtre (taches://ecrire/<id>)
const premiereInstance = app.requestSingleInstanceLock();
if (!premiereInstance) app.quit();

let fenetre = null;
let icone = null;
let horsLigne = false;
let minuteurReessai = null;
let quitter = false;

// ---------- réglages (position, taille, options) ----------
const fichierReglages = () => path.join(app.getPath('userData'), 'reglages.json');
function lireReglages() {
  try { return JSON.parse(fs.readFileSync(fichierReglages(), 'utf8')); } catch { return {}; }
}
let reglages = {};
function enregistrer(modifs) {
  reglages = { ...reglages, ...modifs };
  try { fs.writeFileSync(fichierReglages(), JSON.stringify(reglages, null, 2)); } catch { /* sans gravité */ }
}

function cadreParDefaut() {
  const zone = screen.getPrimaryDisplay().workArea;
  const hauteur = Math.min(zone.height - 32, 900);
  return { x: zone.x + zone.width - LARGEUR - 16, y: zone.y + 16, width: LARGEUR, height: hauteur };
}
function cadreValide(c) {
  if (!c) return false;
  // Le cadre enregistré doit encore tomber sur un écran branché.
  return screen.getAllDisplays().some(({ workArea: z }) =>
    c.x < z.x + z.width - 50 && c.x + c.width > z.x + 50 && c.y >= z.y - 10 && c.y < z.y + z.height - 50);
}

// ---------- note ouverte en grand ----------
// Une vraie fenêtre Windows (déplaçable, redimensionnable, plein écran) avec l'éditeur de la note.
// Une seule fenêtre par note ; la taille et la place sont retenues pour la suivante.
const fenetresNotes = new Map();
function ouvrirNote(id) {
  if (!/^[0-9a-f-]{8,64}$/i.test(id)) return;
  const deja = fenetresNotes.get(id);
  if (deja && !deja.isDestroyed()) { if (deja.isMinimized()) deja.restore(); deja.show(); deja.focus(); return; }
  const memo = reglages.editeur || {};
  const cadre = memo.cadre && cadreValide(memo.cadre) ? memo.cadre : { width: 900, height: 780 };
  const f = new BrowserWindow({
    ...cadre,
    minWidth: 420,
    minHeight: 360,
    show: false,
    title: 'Note',
    icon: path.join(__dirname, 'icone.png'),
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: true },
  });
  fenetresNotes.set(id, f);
  f.setMenuBarVisibility(false);
  f.loadURL(ADRESSE + '?ecrire=' + encodeURIComponent(id));
  f.once('ready-to-show', () => { if (memo.maximisee) f.maximize(); f.show(); });
  f.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  f.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ADRESSE)) { e.preventDefault(); shell.openExternal(url); }
  });
  const retenir = () => {
    if (f.isDestroyed() || f.isMinimized()) return;
    enregistrer({ editeur: { cadre: f.isMaximized() ? (reglages.editeur || {}).cadre : f.getBounds(), maximisee: f.isMaximized() } });
  };
  f.on('resized', retenir);
  f.on('moved', retenir);
  f.on('maximize', retenir);
  f.on('unmaximize', retenir);
  // Avant de fermer : la page enregistre ce qui vient d'être tapé (au plus 3 secondes d'attente).
  let peutFermer = false;
  f.on('close', (e) => {
    if (peutFermer) return;
    e.preventDefault();
    retenir();
    const fin = () => { peutFermer = true; if (!f.isDestroyed()) f.close(); };
    Promise.race([
      f.webContents.executeJavaScript('window.__avantFermeture ? window.__avantFermeture() : true'),
      new Promise((r) => setTimeout(r, 3000)),
    ]).catch(() => {}).finally(fin);
  });
  f.on('closed', () => fenetresNotes.delete(id));
}

// ---------- fenêtre ----------
function creerFenetre({ visible }) {
  const cadre = cadreValide(reglages.cadre) ? reglages.cadre : cadreParDefaut();
  fenetre = new BrowserWindow({
    ...cadre,
    minWidth: 300,
    minHeight: 300,
    show: false,
    frame: false,
    skipTaskbar: true,
    alwaysOnTop: !!reglages.premierPlan,
    title: 'Tâches',
    icon: path.join(__dirname, 'icone.png'),
    backgroundColor: '#f4efe6',
    webPreferences: { contextIsolation: true, sandbox: true, spellcheck: true },
  });

  fenetre.webContents.session.setSpellCheckerLanguages(['fr']);
  fenetre.loadURL(ADRESSE);

  fenetre.webContents.on('dom-ready', () => {
    if (!horsLigne) { fenetre.webContents.insertCSS(CSS_PANNEAU); signalerEtat(); }
  });
  fenetre.webContents.on('did-fail-load', (_e, code, _desc, url, principal) => {
    if (!principal || code === -3) return; // -3 : chargement annulé, sans importance
    horsLigne = true;
    fenetre.loadFile(path.join(__dirname, 'hors-ligne.html'));
    clearTimeout(minuteurReessai);
    minuteurReessai = setTimeout(() => { horsLigne = false; fenetre.loadURL(ADRESSE); }, 30000);
  });

  // Liens externes : dans le navigateur habituel, pas dans le panneau.
  fenetre.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'taches://masquer') fenetre.hide(); // bouton « masquer » du site
    else if (url === 'taches://verrou') verrouiller(!reglages.verrouille); // bouton cadenas du site
    else if (url === 'taches://reduire') reduire(true); // bouton « réduire » du site
    else if (url === 'taches://agrandir') reduire(false); // bouton de la petite barre
    else if (url.startsWith('taches://ecrire/')) ouvrirNote(decodeURIComponent(url.slice('taches://ecrire/'.length))); // « Ouvrir en grand »
    else if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  fenetre.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ADRESSE) && !url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); }
  });

  fenetre.webContents.on('before-input-event', (e, entree) => {
    // Échap cache le panneau, sauf pendant l'écriture d'une note (Échap ferme alors l'éditeur).
    if (entree.type === 'keyDown' && entree.key === 'Escape' && !fenetre.webContents.getTitle().includes('écriture')) {
      e.preventDefault(); fenetre.hide();
    }
  });

  // En petite barre, on retient la place de la barre sans toucher au cadre du panneau ouvert.
  const memoriserCadre = () => {
    if (fenetre.isMinimized()) return;
    const b = fenetre.getBounds();
    if (reglages.reduit) enregistrer({ barre: { x: b.x, y: b.y } });
    else enregistrer({ cadre: b });
  };
  fenetre.on('moved', memoriserCadre);
  fenetre.on('resized', memoriserCadre);

  // Fermer = masquer ; on quitte seulement depuis l'icône près de l'horloge.
  fenetre.on('close', (e) => { if (!quitter) { e.preventDefault(); fenetre.hide(); } });
  fenetre.on('hide', () => installerMaj());
  fenetre.on('blur', () => installerMaj());

  appliquerTaille();
  fenetre.once('ready-to-show', () => {
    if (visible === 'actif') { fenetre.show(); fenetre.focus(); }
    else if (visible) fenetre.showInactive();
  });
}

// Position verrouillée : le panneau ne se déplace ni ne se redimensionne plus, jusqu'au déverrouillage
// (cadenas en haut du panneau, ou menu de l'icône près de l'horloge).
function verrouiller(oui) {
  enregistrer({ verrouille: oui });
  appliquerVerrou();
}
function appliquerVerrou() {
  if (!fenetre) return;
  const v = !!reglages.verrouille;
  fenetre.setMovable(!v);
  fenetre.setResizable(!v && !reglages.reduit);
  signalerEtat();
}
// Le site affiche le cadenas fermé ou ouvert (et coupe la zone de déplacement quand c'est verrouillé),
// et ne montre plus que la petite barre quand le panneau est réduit.
function signalerEtat() {
  if (!fenetre || horsLigne) return;
  fenetre.webContents.executeJavaScript(
    `document.body.classList.toggle('verrouille', ${!!reglages.verrouille});` +
    `document.body.classList.toggle('reduit', ${!!reglages.reduit});`).catch(() => {});
}

// Petite barre : le panneau se réduit à une barre « Tâches » (aucune tâche visible), pour travailler
// sans être distrait ; ▢ ou un clic rouvre le panneau à sa place. Le choix est gardé au redémarrage.
function reduire(oui) {
  if (!fenetre) return;
  if (!!reglages.reduit === oui) return;
  if (oui && !fenetre.isMinimized()) enregistrer({ cadre: fenetre.getBounds() });
  enregistrer({ reduit: oui });
  appliquerTaille();
  if (!fenetre.isVisible()) fenetre.showInactive();
  if (icone) icone.setContextMenu(construireMenu());
}
function appliquerTaille() {
  if (!fenetre) return;
  fenetre.setResizable(true); // le temps de changer de taille ; le verrou est réappliqué juste après
  if (reglages.reduit) {
    fenetre.setMinimumSize(BARRE.width, BARRE.height);
    const c = cadreValide(reglages.cadre) ? reglages.cadre : cadreParDefaut();
    let pos = { x: c.x + c.width - BARRE.width, y: c.y };
    if (reglages.barre && cadreValide({ ...reglages.barre, ...BARRE, width: 200, height: 100 })) pos = reglages.barre;
    fenetre.setBounds({ ...pos, ...BARRE });
  } else {
    fenetre.setMinimumSize(300, 300);
    fenetre.setBounds(cadreValide(reglages.cadre) ? reglages.cadre : cadreParDefaut());
  }
  appliquerVerrou();
}

function montrer() {
  if (!fenetre) return;
  if (fenetre.isMinimized()) fenetre.restore();
  fenetre.show();
  fenetre.focus();
}
function basculer() {
  if (!fenetre) return;
  if (!fenetre.isVisible() || fenetre.isMinimized()) montrer();
  else if (fenetre.isFocused()) fenetre.hide();
  else montrer(); // visible mais derrière d'autres fenêtres : on le ramène devant
}
function ajoutRapide() {
  reduire(false);
  montrer();
  fenetre.webContents.focus();
  fenetre.webContents.executeJavaScript(`
    (() => {
      const onglet = document.querySelector('[data-vue="liste"]');
      if (onglet && onglet.getAttribute('aria-selected') !== 'true') onglet.click();
      const s = document.querySelector('#saisie');
      if (s) { s.focus(); s.select(); }
    })();`).catch(() => {});
}

// ---------- icône près de l'horloge ----------
// Version Microsoft Store (MSIX) : le Store gère les mises à jour, et le démarrage avec Windows
// passe par le paquet (réglable dans Paramètres > Applications > Démarrage).
const VERSION_STORE = !!process.windowsStore;

function demarreAvecWindows() { return app.getLoginItemSettings().openAtLogin; }
function reglerDemarrage(oui) {
  app.setLoginItemSettings({ openAtLogin: oui, args: ['--au-demarrage'] });
}

function construireMenu() {
  return Menu.buildFromTemplate([
    { label: `Afficher / masquer\t${raccourciLisible(RACCOURCI_PANNEAU)}`, click: basculer },
    { label: `Ajouter une tâche\t${raccourciLisible(RACCOURCI_AJOUT)}`, click: ajoutRapide },
    { label: 'Recharger', click: () => { horsLigne = false; fenetre.loadURL(ADRESSE); } },
    { type: 'separator' },
    {
      label: 'Toujours au premier plan', type: 'checkbox', checked: !!reglages.premierPlan,
      click: (item) => { enregistrer({ premierPlan: item.checked }); fenetre.setAlwaysOnTop(item.checked); },
    },
    ...(VERSION_STORE ? [] : [{
      label: 'Lancer au démarrage de Windows', type: 'checkbox', checked: demarreAvecWindows(),
      click: (item) => reglerDemarrage(item.checked),
    }]),
    {
      label: 'Réduire en petite barre', type: 'checkbox', checked: !!reglages.reduit,
      click: (item) => { reduire(item.checked); montrer(); },
    },
    {
      label: 'Verrouiller la position', type: 'checkbox', checked: !!reglages.verrouille,
      click: (item) => verrouiller(item.checked),
    },
    { label: 'Remettre le panneau à droite', click: () => {
      enregistrer({ cadre: cadreParDefaut(), barre: null });
      appliquerTaille(); montrer();
    } },
    { type: 'separator' },
    { label: 'Quitter', click: () => { quitter = true; app.quit(); } },
  ]);
}
function raccourciLisible(r) { return r.replace('Control', 'Ctrl'); }

function creerIcone() {
  const image = nativeImage.createFromPath(path.join(__dirname, 'icone.png')).resize({ width: 32, height: 32 });
  icone = new Tray(image);
  icone.setToolTip(`Tâches (${raccourciLisible(RACCOURCI_PANNEAU)})`);
  icone.on('click', basculer);
  icone.on('right-click', () => icone.popUpContextMenu(construireMenu()));
}

// ---------- mises à jour de l'appli Windows ----------
// La liste elle-même vient du site : elle est toujours à jour. Ceci ne concerne que le panneau.
// Journal des mises à jour (%APPDATA%\Tâches\maj.log), pour comprendre un éventuel souci.
function journal(niveau, ...msg) {
  const ligne = `${new Date().toISOString()} ${niveau} ${msg.map(String).join(' ')}\n`;
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'maj.log'), ligne); } catch { /* sans gravité */ }
}
autoUpdater.logger = {
  info: (...m) => journal('info', ...m), warn: (...m) => journal('warn', ...m),
  error: (...m) => journal('erreur', ...m), debug: () => {},
};

// Une mise à jour téléchargée s'installe tout de suite (en silence, puis le panneau se relance),
// dès que le panneau n'est pas en cours d'utilisation. On ne compte pas sur « à la fermeture ».
let majPrete = false;
function installerMaj() {
  if (!majPrete) return;
  if (fenetre && fenetre.isVisible() && fenetre.isFocused()) return; // on attend que le panneau soit laissé
  majPrete = false;
  journal('info', 'installation de la mise à jour');
  quitter = true;
  globalShortcut.unregisterAll();
  if (icone) icone.destroy();
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
}
autoUpdater.on('update-downloaded', (info) => {
  journal('info', 'mise à jour téléchargée', info && info.version);
  majPrete = true;
  installerMaj();
});
autoUpdater.on('error', (err) => journal('erreur', err && (err.stack || err.message)));

function verifierMisesAJour() {
  if (!app.isPackaged || VERSION_STORE) return;
  journal('info', 'version', app.getVersion(), ': recherche de mise à jour');
  autoUpdater.checkForUpdates().catch((err) => journal('erreur', err && err.message));
}

// ---------- démarrage ----------
app.on('second-instance', montrer); // relancer l'appli = afficher le panneau

app.whenReady().then(() => {
  if (!premiereInstance) return;
  reglages = lireReglages();
  const auDemarrage = process.argv.includes('--au-demarrage');
  const premiereFois = !reglages.dejaLance;

  if (premiereFois) {
    if (!VERSION_STORE) reglerDemarrage(true); // démarrage avec Windows activé d'office, désactivable dans le menu
    enregistrer({ dejaLance: true });
  }

  creerFenetre({ visible: auDemarrage ? true : 'actif' });
  creerIcone();

  const ok1 = globalShortcut.register(RACCOURCI_PANNEAU, basculer);
  const ok2 = globalShortcut.register(RACCOURCI_AJOUT, ajoutRapide);

  if (premiereFois && Notification.isSupported()) {
    new Notification({
      title: 'Tâches est installé',
      body: `${raccourciLisible(RACCOURCI_PANNEAU)} pour afficher ou masquer la liste, ${raccourciLisible(RACCOURCI_AJOUT)} pour ajouter. ` +
        'Il se lance avec Windows. Clic droit sur son icône près de l\'horloge pour les options.',
    }).show();
  }
  if ((!ok1 || !ok2) && Notification.isSupported()) {
    new Notification({
      title: 'Tâches : raccourci clavier indisponible',
      body: 'Un autre programme utilise déjà ce raccourci. L\'icône près de l\'horloge fonctionne toujours.',
    }).show();
  }

  verifierMisesAJour();
  setInterval(verifierMisesAJour, 6 * 60 * 60 * 1000);
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('before-quit', () => { quitter = true; });
app.on('window-all-closed', (e) => e.preventDefault());
