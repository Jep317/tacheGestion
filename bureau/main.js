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

// Retouches d'affichage propres au panneau : on peut déplacer la fenêtre par l'en-tête,
// et le micro est caché (la dictée du navigateur ne marche pas ici ; Windows+H dicte dans n'importe quel champ).
const CSS_PANNEAU = `
  .entete, .connexion h1 { -webkit-app-region: drag; }
  .entete button, .entete input, .entete a { -webkit-app-region: no-drag; }
  #btn-micro { display: none !important; }
`;

app.setAppUserModelId('com.jep317.taches');
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
    if (!horsLigne) fenetre.webContents.insertCSS(CSS_PANNEAU);
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
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  fenetre.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ADRESSE) && !url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); }
  });

  fenetre.webContents.on('before-input-event', (e, entree) => {
    if (entree.type === 'keyDown' && entree.key === 'Escape') { e.preventDefault(); fenetre.hide(); }
  });

  const memoriserCadre = () => { if (!fenetre.isMinimized()) enregistrer({ cadre: fenetre.getBounds() }); };
  fenetre.on('moved', memoriserCadre);
  fenetre.on('resized', memoriserCadre);

  // Fermer = masquer ; on quitte seulement depuis l'icône près de l'horloge.
  fenetre.on('close', (e) => { if (!quitter) { e.preventDefault(); fenetre.hide(); } });

  fenetre.once('ready-to-show', () => {
    if (visible === 'actif') { fenetre.show(); fenetre.focus(); }
    else if (visible) fenetre.showInactive();
  });
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
    {
      label: 'Lancer au démarrage de Windows', type: 'checkbox', checked: demarreAvecWindows(),
      click: (item) => reglerDemarrage(item.checked),
    },
    { label: 'Remettre le panneau à droite', click: () => { fenetre.setBounds(cadreParDefaut()); montrer(); } },
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
function verifierMisesAJour() {
  if (!app.isPackaged) return;
  autoUpdater.checkForUpdatesAndNotify().catch(() => {});
}

// ---------- démarrage ----------
app.on('second-instance', montrer); // relancer l'appli = afficher le panneau

app.whenReady().then(() => {
  if (!premiereInstance) return;
  reglages = lireReglages();
  const auDemarrage = process.argv.includes('--au-demarrage');
  const premiereFois = !reglages.dejaLance;

  if (premiereFois) {
    reglerDemarrage(true); // démarrage avec Windows activé d'office, désactivable dans le menu
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
