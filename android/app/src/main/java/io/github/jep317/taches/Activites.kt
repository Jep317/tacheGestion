package io.github.jep317.taches

import android.Manifest
import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognizerIntent
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.ImageButton
import android.widget.TextView
import android.widget.Toast
import java.text.SimpleDateFormat
import java.util.Locale
import kotlin.concurrent.thread

private val principal = Handler(Looper.getMainLooper())

/** Lance un travail réseau en fond, puis revient sur l'écran. */
private fun Activity.enFond(travail: () -> Unit, ensuite: (Exception?) -> Unit) {
    thread {
        val erreur = try { travail(); null } catch (e: Exception) { e }
        principal.post { if (!isFinishing && !isDestroyed) ensuite(erreur) }
    }
}

private fun ouvrirAppliWeb(ctx: Context, parametres: String = "") {
    try {
        ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(Supabase.APPLI_WEB + parametres)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (_: ActivityNotFoundException) {}
}

/** Petits textes partagés entre le widget et l'écran de détail. */
object Details {
    fun meta(i: Supabase.Item): String {
        val m = mutableListOf<String>()
        i.parent?.let { m += "↳ $it" }
        if (i.sousTotal > 0) m += "▾ ${i.sousFaites}/${i.sousTotal}"
        if (i.checkTotal > 0) m += "☑ ${i.checkCochees}/${i.checkTotal}"
        i.categorie?.let { m += it }
        if (i.type == "course") m += "Course"
        if (i.type == "idee") m += "Idée"
        if (i.type == "note") m += "Note"
        if (i.etat == "en_cours") m += "En cours"
        i.echeance?.let { m += dateCourte(it) + (i.echeanceHeure?.let { h -> " " + heureCourte(h) } ?: "") }
        if (i.recurrent) m += "🔁"
        i.theme?.let { m += it }
        i.projet?.let { m += it + (i.groupe?.let { g -> " › $g" } ?: "") }
        return m.joinToString(" · ")
    }

    private fun dateCourte(iso: String): String = try {
        val jour = java.time.LocalDate.parse(iso)
        val auj = java.time.LocalDate.now()
        when {
            jour.isBefore(auj) -> SimpleDateFormat("d MMM", Locale.FRANCE).format(SimpleDateFormat("yyyy-MM-dd", Locale.US).parse(iso)!!) + " (en retard)"
            jour == auj -> "aujourd'hui"
            jour == auj.plusDays(1) -> "demain"
            else -> SimpleDateFormat("d MMM", Locale.FRANCE).format(SimpleDateFormat("yyyy-MM-dd", Locale.US).parse(iso)!!)
        }
    } catch (e: Exception) {
        iso
    }

    fun heureCourte(h: String): String {
        val p = h.split(":")
        if (p.size < 2) return h
        val hh = p[0].toIntOrNull() ?: return h
        return if (p[1] == "00") "$hh h" else "$hh h ${p[1]}"
    }

    fun intention(i: Supabase.Item): Intent = Intent()
        .putExtra("id", i.id)
        .putExtra("libelle", i.libelle)
        .putExtra("brut", if (i.titre != null) i.texteBrut else null)
        .putExtra("details", i.details)
        .putExtra("meta", meta(i))
        .putExtra("etat", i.etat)
        .putExtra("type", i.type)
}

// ---------- Écran principal : connexion, puis raccourcis ----------
class MainActivity : Activity() {
    override fun onCreate(etat: Bundle?) {
        super.onCreate(etat)
        afficher()
    }

    private fun afficher() {
        if (!Supabase.estConnecte(this)) {
            setContentView(R.layout.ecran_connexion)
            val email = findViewById<EditText>(R.id.email)
            val mdp = findViewById<EditText>(R.id.mdp)
            val msg = findViewById<TextView>(R.id.message)
            val bouton = findViewById<Button>(R.id.btn_connexion)
            Supabase.email(this)?.let { email.setText(it) }
            val seConnecter = {
                val e = email.text.toString().trim()
                val p = mdp.text.toString()
                if (e.isEmpty() || p.isEmpty()) {
                    msg.text = "Saisis ton e-mail et ton mot de passe."
                } else {
                    msg.text = "Connexion…"
                    bouton.isEnabled = false
                    var reponse: String? = null
                    enFond({ reponse = Supabase.connecter(this, e, p) }) {
                        bouton.isEnabled = true
                        if (reponse == null) {
                            WidgetTaches.actualiser(this)
                            afficher()
                        } else {
                            msg.text = reponse
                        }
                    }
                }
            }
            bouton.setOnClickListener { seConnecter() }
            mdp.setOnEditorActionListener { _, action, _ ->
                if (action == EditorInfo.IME_ACTION_DONE) { seConnecter(); true } else false
            }
            return
        }

        setContentView(R.layout.ecran_principal)
        Rappels.demanderPermission(this)
        Rappels.programmerSynchro(this)
        findViewById<TextView>(R.id.compte).text = "Connecté : " + (Supabase.email(this) ?: "")
        val g = AppWidgetManager.getInstance(this)
        val poser = findViewById<Button>(R.id.btn_poser)
        val dejaPose = g.getAppWidgetIds(ComponentName(this, WidgetTaches::class.java)).isNotEmpty()
        findViewById<TextView>(R.id.aide).text = if (dejaPose)
            "Le widget est sur ton écran d'accueil. Il se met à jour tout seul toutes les 30 minutes, ou avec ↻."
        else
            "Pour voir ta liste sur l'écran d'accueil, pose le widget avec le bouton ci-dessous " +
                "(ou appui long sur l'écran d'accueil › Widgets › Tâches)."
        if (g.isRequestPinAppWidgetSupported) {
            poser.setOnClickListener { g.requestPinAppWidget(ComponentName(this, WidgetTaches::class.java), null, null) }
        } else {
            poser.visibility = View.GONE
        }
        findViewById<Button>(R.id.btn_ajouter).setOnClickListener { startActivity(Intent(this, AjoutActivity::class.java)) }
        findViewById<Button>(R.id.btn_courses).setOnClickListener { startActivity(Intent(this, CoursesActivity::class.java)) }
        findViewById<Button>(R.id.btn_notes).setOnClickListener { ouvrirAppliWeb(this, "?notes=1") }
        findViewById<Button>(R.id.btn_appli).setOnClickListener { ouvrirAppliWeb(this) }
        findViewById<Button>(R.id.btn_categories).setOnClickListener { ouvrirAppliWeb(this, "?categories=1") }
        findViewById<Button>(R.id.btn_deconnexion).setOnClickListener {
            enFond({ Supabase.deconnecter(this) }) {
                WidgetTaches.actualiser(this)
                afficher()
            }
        }
    }
}

// ---------- Ajout rapide (texte ou dictée) ----------
class AjoutActivity : Activity() {
    companion object {
        const val VOCAL = "vocal"
        private const val CODE_DICTEE = 1
        private const val CODE_MICRO = 3
    }

    private lateinit var saisie: EditText
    private lateinit var statut: TextView
    private lateinit var micro: ImageButton
    private var source = "widget"
    private var dictee: DicteeContinue? = null
    private val vientDuWidget get() = intent.getBooleanExtra(VOCAL, false)

    override fun onCreate(etat: Bundle?) {
        super.onCreate(etat)
        if (!Supabase.estConnecte(this)) {
            Toast.makeText(this, "Connecte-toi d'abord dans l'appli Tâches.", Toast.LENGTH_LONG).show()
            startActivity(Intent(this, MainActivity::class.java))
            finish()
            return
        }
        setContentView(R.layout.ecran_ajout)
        saisie = findViewById(R.id.saisie)
        statut = findViewById(R.id.statut_dictee)
        micro = findViewById(R.id.btn_micro)
        val envoyer = findViewById<Button>(R.id.btn_envoyer)
        micro.setOnClickListener { if (dictee?.active == true) dictee?.terminer() else dicter() }
        findViewById<Button>(R.id.btn_annuler).setOnClickListener { finish() }
        envoyer.setOnClickListener { envoyer(envoyer) }
        saisie.setOnEditorActionListener { _, action, _ ->
            if (action == EditorInfo.IME_ACTION_SEND) { envoyer(envoyer); true } else false
        }
        if (etat == null && vientDuWidget) {
            dicter()
        } else {
            saisie.requestFocus()
            window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE)
        }
    }

    override fun onPause() {
        super.onPause()
        // Écran quitté (appel, autre appli) : on arrête d'écouter mais on garde le texte.
        dictee?.terminer()
    }

    override fun onDestroy() {
        dictee?.liberer()
        super.onDestroy()
    }

    /** Dictée longue : écoute jusqu'à ce que Jérémie touche le micro, même s'il fait des pauses. */
    private fun dicter() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), CODE_MICRO)
            return
        }
        val d = dictee ?: DicteeContinue(
            this,
            surTexte = { t ->
                saisie.setText(t)
                saisie.setSelection(saisie.text.length)
                source = "vocal"
            },
            surFin = { erreur -> finDictee(erreur) },
        ).also { dictee = it }
        d.demarrer(saisie.text.toString())
        if (!d.active) return
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        statut.visibility = View.VISIBLE
        statut.text = "🎙 J'écoute… Parle aussi longtemps que tu veux, même avec des pauses. Touche ■ pour finir."
        micro.setImageResource(R.drawable.ic_stop)
        micro.contentDescription = "Terminer la dictée"
    }

    private fun finDictee(erreur: String?) {
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        micro.setImageResource(R.drawable.ic_micro)
        micro.contentDescription = "Dicter"
        if (erreur != null) {
            statut.visibility = View.VISIBLE
            statut.text = erreur
        } else if (saisie.text.isNotBlank()) {
            statut.visibility = View.VISIBLE
            statut.text = "Relis si tu veux, puis « Ajouter ». Claude découpera en tâches et notes."
        } else {
            statut.visibility = View.GONE
        }
    }

    /** Ancienne dictée (une phrase) si le micro n'est pas autorisé. */
    private fun dicterUnePhrase() {
        val i = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, "fr-FR")
            .putExtra(RecognizerIntent.EXTRA_PROMPT, "Dis ce qu'il faut ajouter")
        try {
            @Suppress("DEPRECATION")
            startActivityForResult(i, CODE_DICTEE)
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, "Dictée indisponible sur ce téléphone.", Toast.LENGTH_LONG).show()
        }
    }

    override fun onRequestPermissionsResult(code: Int, permissions: Array<out String>, resultats: IntArray) {
        super.onRequestPermissionsResult(code, permissions, resultats)
        if (code != CODE_MICRO) return
        if (resultats.firstOrNull() == PackageManager.PERMISSION_GRANTED) dicter() else dicterUnePhrase()
    }

    @Deprecated("API Activity simple, sans AndroidX")
    override fun onActivityResult(code: Int, resultat: Int, donnees: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(code, resultat, donnees)
        if (code != CODE_DICTEE) return
        val texte = donnees?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
        if (resultat == RESULT_OK && !texte.isNullOrBlank()) {
            val avant = saisie.text.toString().trimEnd()
            saisie.setText(if (avant.isEmpty()) texte else "$avant $texte")
            saisie.setSelection(saisie.text.length)
            source = "vocal"
        } else if (saisie.text.isBlank() && vientDuWidget) {
            // Dictée annulée depuis le bouton micro du widget : on referme sans rien laisser à l'écran.
            finish()
        }
    }

    private fun envoyer(bouton: Button) {
        dictee?.terminer()
        val texte = saisie.text.toString().trim()
        if (texte.isEmpty()) return
        bouton.isEnabled = false
        enFond({ Supabase.ajouter(this, texte, source) }) { erreur ->
            if (erreur == null) {
                Toast.makeText(this, "Ajouté. Claude le rangera.", Toast.LENGTH_SHORT).show()
                WidgetTaches.actualiser(this)
                finish()
            } else {
                bouton.isEnabled = true
                Toast.makeText(this, "Ajout impossible : " + (erreur.message ?: "erreur"), Toast.LENGTH_LONG).show()
            }
        }
    }
}

// ---------- Détail d'une tâche touchée dans le widget ----------
class DetailActivity : Activity() {
    override fun onCreate(etat: Bundle?) {
        super.onCreate(etat)
        if (intent.getBooleanExtra("courses", false)) {
            startActivity(Intent(this, CoursesActivity::class.java))
            finish()
            return
        }
        val id = intent.getStringExtra("id")
        if (id != null && intent.getStringExtra("action") == "terminer") {
            // Rond touché dans le widget : simple fenêtre de confirmation.
            startActivity(Intent(this, ConfirmerActivity::class.java).putExtras(intent))
            finish()
            return
        }
        if (id == null) {
            // Ligne de résumé : ouvrir l'appli complète (ou la connexion si besoin).
            if (Supabase.estConnecte(this)) ouvrirAppliWeb(this)
            else startActivity(Intent(this, MainActivity::class.java))
            finish()
            return
        }
        setContentView(R.layout.ecran_detail)
        // Panneau en bas de l'écran, sur toute la largeur.
        window.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT)
        window.setGravity(android.view.Gravity.BOTTOM)
        val etatActuel = intent.getStringExtra("etat") ?: "a_faire"
        findViewById<TextView>(R.id.titre).text = intent.getStringExtra("libelle")
        fun remplir(vue: Int, texte: String?) {
            val t = findViewById<TextView>(vue)
            if (texte.isNullOrBlank()) t.visibility = View.GONE else t.text = texte
        }
        remplir(R.id.meta, intent.getStringExtra("meta"))
        remplir(R.id.details, intent.getStringExtra("details"))
        if (intent.getStringExtra("type") in setOf("note", "idee")) styleArticle(intent.getStringExtra("details"))
        remplir(R.id.brut, intent.getStringExtra("brut")?.let { "« $it »" })

        // Contenu (sous-tâches, checklist, notes attachées), ✏ et ＋ : chargés depuis la base.
        preparerContenu(id, intent.getStringExtra("type") in setOf("note", "idee"))

        val fait = findViewById<Button>(R.id.btn_fait)
        val enCours = findViewById<Button>(R.id.btn_en_cours)
        val estNote = intent.getStringExtra("type") in setOf("note", "idee")
        if (etatActuel == "en_cours" || estNote) enCours.visibility = View.GONE
        if (estNote) {
            // Archiver une note est une action secondaire : pastille discrète, pas le gros bouton vert.
            fait.text = "Archiver"
            fait.setBackgroundResource(R.drawable.fond_pilule)
            fait.setTextColor(getColor(R.color.discret))
            fait.setTypeface(null, android.graphics.Typeface.NORMAL)
        }
        val supprimer = findViewById<Button>(R.id.btn_supprimer)
        supprimer.setOnClickListener {
            android.app.AlertDialog.Builder(this)
                .setTitle(if (estNote) "Supprimer cette note ?" else "Supprimer cette tâche ?")
                .setMessage(intent.getStringExtra("libelle"))
                .setNegativeButton("Annuler", null)
                .setPositiveButton("Supprimer") { _, _ ->
                    supprimer.isEnabled = false
                    enFond({ Supabase.changerEtat(this, id, etatActuel, "abandonne", action = "supprime", par = "jeremie") }) { erreur ->
                        if (erreur == null) {
                            Toast.makeText(this, if (estNote) "Note supprimée." else "Tâche supprimée.", Toast.LENGTH_SHORT).show()
                            WidgetTaches.actualiser(this)
                            finish()
                        } else {
                            supprimer.isEnabled = true
                            Toast.makeText(this, "Suppression impossible : " + (erreur.message ?: "erreur"), Toast.LENGTH_LONG).show()
                        }
                    }
                }
                .show()
        }
        findViewById<Button>(R.id.btn_fermer).setOnClickListener { finish() }
        findViewById<Button>(R.id.btn_appli).setOnClickListener { ouvrirAppliWeb(this); finish() }

        fun changer(nouvel: String, message: String) {
            fait.isEnabled = false
            enCours.isEnabled = false
            enFond({ Supabase.changerEtat(this, id, etatActuel, nouvel) }) { erreur ->
                if (erreur == null) {
                    Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
                    WidgetTaches.actualiser(this)
                    finish()
                } else {
                    fait.isEnabled = true
                    enCours.isEnabled = true
                    Toast.makeText(this, "Modification impossible : " + (erreur.message ?: "erreur"), Toast.LENGTH_LONG).show()
                }
            }
        }
        fait.setOnClickListener { changer("fait", if (estNote) "Archivée." else "Fait.") }
        enCours.setOnClickListener { changer("en_cours", "Marqué en cours.") }

        // Priorité : monter / descendre / en tête, ou changer d'horizon. La fenêtre reste ouverte pour enchaîner.
        val bloc = findViewById<View>(R.id.bloc_priorite)
        if (estNote) bloc.visibility = View.GONE else preparerPriorite(id)

        // Échéance et répétition se règlent dans l'appli complète, ouverte directement sur cette tâche.
        findViewById<Button>(R.id.btn_planifier).setOnClickListener {
            ouvrirAppliWeb(this, "?item=" + Uri.encode(id))
            finish()
        }
        findViewById<Button>(R.id.btn_rappel).setOnClickListener {
            Rappels.demanderPermission(this)
            choisirRappel(id)
        }
    }

    // Glisser la fiche vers le bas pour la fermer (convention des panneaux du bas).
    private val glisse = GlisserPourFermer(this)
    override fun dispatchTouchEvent(e: android.view.MotionEvent): Boolean =
        glisse.traiter(e) { super.dispatchTouchEvent(it) }

    // ---------- contenu de la fiche, édition du titre et du texte, menu ＋ ----------
    private var fiche: Supabase.Fiche? = null

    private fun dp(n: Int) = (n * resources.displayMetrics.density).toInt()

    private fun preparerContenu(id: String, estNote: Boolean) {
        val editer = findViewById<Button>(R.id.btn_editer)
        val plus = findViewById<Button>(R.id.btn_plus)
        editer.isEnabled = false
        plus.isEnabled = false
        editer.setOnClickListener { fiche?.let { editerTexte(id, it) } }
        plus.setOnClickListener { fiche?.let { menuPlus(id, it, estNote) } }
        chargerContenu(id)
    }

    private fun chargerContenu(id: String) {
        var recu: Supabase.Fiche? = null
        enFond({ recu = Supabase.fiche(this, id) }) { _ ->
            val f = recu
            if (f != null) {
                fiche = f
                afficherContenu(id, f)
            }
            findViewById<Button>(R.id.btn_editer).isEnabled = fiche != null
            findViewById<Button>(R.id.btn_plus).isEnabled = fiche != null
        }
    }

    /** Une note se lit comme un article : titre et texte en serif, titres, citations, listes et liens mis en forme. */
    private fun styleArticle(md: String?) {
        val titre = findViewById<TextView>(R.id.titre)
        titre.typeface = android.graphics.Typeface.create(android.graphics.Typeface.SERIF, android.graphics.Typeface.BOLD)
        titre.textSize = 23f
        val det = findViewById<TextView>(R.id.details)
        det.typeface = android.graphics.Typeface.SERIF
        det.textSize = 17f
        det.setLineSpacing(0f, 1.3f)
        if (!md.isNullOrBlank()) {
            det.text = Article.mettreEnForme(md)
            det.movementMethod = android.text.method.LinkMovementMethod.getInstance()
        }
    }

    private fun afficherContenu(id: String, f: Supabase.Fiche) {
        findViewById<TextView>(R.id.titre).text = f.titre
        val det = findViewById<TextView>(R.id.details)
        if (f.details.isNullOrBlank()) det.visibility = View.GONE else { det.visibility = View.VISIBLE; det.text = f.details }
        if (intent.getStringExtra("type") in setOf("note", "idee")) styleArticle(f.details)
        val boite = findViewById<android.widget.LinearLayout>(R.id.contenu)
        boite.removeAllViews()
        fun rubrique(t: String) {
            boite.addView(TextView(this).apply {
                text = t
                setTextAppearance(R.style.Rubrique)
                setPadding(0, dp(16), 0, dp(2))
            })
        }
        val taches = f.enfants.filter { it.type == "tache" || it.type == "course" }
        val notes = f.enfants.filter { it.type == "note" || it.type == "idee" }
        if (taches.isNotEmpty()) {
            rubrique("Sous-tâches · ${taches.count { it.etat == "fait" }}/${taches.size}")
            for (t in taches) boite.addView(caseACocher(t.libelle, t.etat == "fait") { coche ->
                enFond({ Supabase.changerEtat(this, t.id, t.etat, if (coche) "fait" else "a_faire") }) { e -> apres(id, e) }
            })
        }
        if (f.lignes.isNotEmpty()) {
            rubrique("Checklist · ${f.lignes.count { it.coche }}/${f.lignes.size}")
            for (l in f.lignes) boite.addView(caseACocher(l.texte, l.coche) { coche ->
                enFond({ Supabase.cocherArticle(this, l.id, coche) }) { e -> apres(id, e) }
            })
        }
        if (notes.isNotEmpty()) {
            rubrique("Notes")
            for (n in notes) boite.addView(TextView(this).apply {
                text = "📝  " + n.libelle
                textSize = 15f
                setTextColor(getColor(R.color.texte))
                setPadding(0, dp(6), 0, dp(6))
            })
        }
    }

    private fun caseACocher(texte: String, coche: Boolean, changer: (Boolean) -> Unit) = android.widget.CheckBox(this).apply {
        text = texte
        isChecked = coche
        textSize = 15f
        setTextColor(getColor(if (coche) R.color.discret else R.color.texte))
        buttonTintList = android.content.res.ColorStateList.valueOf(getColor(R.color.accent))
        if (coche) paintFlags = paintFlags or android.graphics.Paint.STRIKE_THRU_TEXT_FLAG
        setOnCheckedChangeListener { b, v ->
            b.isEnabled = false
            changer(v)
        }
    }

    /** Après une modification : message d'erreur éventuel, contenu rechargé, widget redessiné en quittant. */
    private fun apres(id: String, e: Exception?) {
        if (e != null) Toast.makeText(this, "Impossible : " + (e.message ?: "erreur"), Toast.LENGTH_LONG).show()
        aBouge = true
        chargerContenu(id)
    }

    private fun champ(texte: String, aide: String, lignes: Int): EditText = EditText(this).apply {
        setText(texte)
        hint = aide
        inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or
            (if (lignes > 1) android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE else 0)
        if (lignes > 1) { minLines = lignes; gravity = android.view.Gravity.TOP }
    }

    private fun editerTexte(id: String, f: Supabase.Fiche) {
        val titre = champ(f.titre, "Titre", 1)
        val texte = champ(f.details ?: "", "Texte (facultatif)", 4)
        val boite = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            setPadding(dp(20), dp(8), dp(20), 0)
            addView(titre)
            addView(texte)
        }
        android.app.AlertDialog.Builder(this)
            .setTitle("Modifier")
            .setView(boite)
            .setNegativeButton("Annuler", null)
            .setPositiveButton("Enregistrer") { _, _ ->
                val t = titre.text.toString().replace(Regex("\\s+"), " ").trim()
                if (t.isEmpty()) {
                    Toast.makeText(this, "Le titre ne peut pas être vide.", Toast.LENGTH_SHORT).show()
                } else {
                    val d = texte.text.toString().trimEnd().ifEmpty { null }
                    enFond({ Supabase.modifierTexte(this, id, f, t, d) }) { e ->
                        if (e == null) Toast.makeText(this, "Enregistré.", Toast.LENGTH_SHORT).show()
                        apres(id, e)
                    }
                }
            }
            .show()
    }

    private fun menuPlus(id: String, f: Supabase.Fiche, estNote: Boolean) {
        // (libellé, titre de la saisie, aide, action)
        val choix = mutableListOf<Triple<String, String, String>>()
        if (!estNote) choix += Triple("↳  Sous-tâche", "Nouvelle sous-tâche", "Ce qu'il faut faire")
        choix += Triple("☑  Checklist", "Lignes de checklist", "Une ligne par virgule ou retour à la ligne")
        if (!estNote) choix += Triple("📝  Note rattachée", "Note rattachée", "Le texte de la note")
        android.app.AlertDialog.Builder(this)
            .setTitle("Ajouter")
            .setItems(choix.map { it.first }.toTypedArray()) { _, n ->
                val (libelle, titre, aide) = choix[n]
                demanderTexte(titre, aide) { texte ->
                    enFond({
                        when {
                            libelle.contains("Sous-tâche") -> Supabase.ajouterSousTache(this, id, f, texte)
                            libelle.contains("Checklist") -> Supabase.ajouterLignes(this, id, f, texte)
                            else -> Supabase.attacherNote(this, id, f, texte)
                        }
                    }) { e -> apres(id, e) }
                }
            }
            .show()
    }

    private fun demanderTexte(titre: String, aide: String, ok: (String) -> Unit) {
        val saisie = champ("", aide, 2)
        val boite = android.widget.FrameLayout(this).apply {
            setPadding(dp(20), dp(8), dp(20), 0)
            addView(saisie)
        }
        val d = android.app.AlertDialog.Builder(this)
            .setTitle(titre)
            .setView(boite)
            .setNegativeButton("Annuler", null)
            .setPositiveButton("Ajouter") { _, _ -> saisie.text.toString().trim().takeIf { it.isNotEmpty() }?.let(ok) }
            .create()
        d.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE)
        d.show()
        saisie.requestFocus()
    }

    private val horizons = listOf(
        "maintenant" to R.id.h_maintenant, "bientot" to R.id.h_bientot,
        "plus_tard" to R.id.h_plus_tard, "un_jour" to R.id.h_un_jour,
    )
    private val nomsHorizons = mapOf("maintenant" to "Maintenant", "bientot" to "Bientôt", "plus_tard" to "Plus tard", "un_jour" to "Un jour")
    private var horizonActuel: String? = null
    private var aBouge = false

    private fun preparerPriorite(id: String) {
        val position = findViewById<TextView>(R.id.position)
        val boutons = listOf(R.id.btn_tete, R.id.btn_monter, R.id.btn_descendre).map { findViewById<Button>(it) } +
            horizons.map { findViewById<Button>(it.second) }
        fun afficher(p: Supabase.Place?) {
            horizonActuel = p?.horizon
            position.text = if (p == null) "Pas encore rangée"
            else "${if (p.rang == 1) "1re" else "${p.rang}e"} sur ${p.total} dans ${nomsHorizons[p.horizon] ?: p.horizon}"
            val rangee = p != null
            findViewById<Button>(R.id.btn_tete).isEnabled = rangee && p!!.rang > 1
            findViewById<Button>(R.id.btn_monter).isEnabled = rangee && p!!.rang > 1
            findViewById<Button>(R.id.btn_descendre).isEnabled = rangee && p!!.rang < p.total
            for ((cle, vue) in horizons) {
                val b = findViewById<Button>(vue)
                // Segment choisi : plein, en couleur d'accent ; les autres restent touchables.
                val choisi = cle == p?.horizon
                b.isEnabled = !choisi
                b.setBackgroundResource(if (choisi) R.drawable.fond_segment_actif else android.R.color.transparent)
                b.setTextColor(getColor(if (choisi) R.color.accent_texte else R.color.texte))
            }
            for (vue in listOf(R.id.btn_tete, R.id.btn_monter, R.id.btn_descendre)) {
                val b = findViewById<Button>(vue)
                b.alpha = if (b.isEnabled) 1f else 0.4f
            }
        }
        fun bouger(horizon: String?, mode: String) {
            val h = horizon ?: horizonActuel ?: return
            boutons.forEach { it.isEnabled = false }
            var place: Supabase.Place? = null
            enFond({ place = Supabase.deplacer(this, id, h, mode) }) { erreur ->
                if (erreur == null) {
                    aBouge = true
                    afficher(place)
                } else {
                    afficher(null)
                    Toast.makeText(this, "Déplacement impossible : " + (erreur.message ?: "erreur"), Toast.LENGTH_LONG).show()
                    enFond({ place = Supabase.place(this, id) }) { afficher(place) }
                }
            }
        }
        boutons.forEach { it.isEnabled = false }
        position.text = "…"
        var place: Supabase.Place? = null
        enFond({ place = Supabase.place(this, id) }) { e ->
            if (e == null) afficher(place) else { position.text = "Position indisponible (hors ligne ?)" }
        }
        findViewById<Button>(R.id.btn_tete).setOnClickListener { bouger(null, "tete") }
        findViewById<Button>(R.id.btn_monter).setOnClickListener { bouger(null, "monter") }
        findViewById<Button>(R.id.btn_descendre).setOnClickListener { bouger(null, "descendre") }
        for ((cle, vue) in horizons) findViewById<Button>(vue).setOnClickListener { bouger(cle, "fin") }
    }

    override fun onDestroy() {
        // Le widget se redessine une fois, en quittant, avec le nouvel ordre.
        if (aBouge) WidgetTaches.actualiser(this)
        super.onDestroy()
    }

    private fun choisirRappel(id: String) {
        val maintenant = java.time.ZonedDateTime.now()
        val ceSoir = maintenant.withHour(18).withMinute(0).withSecond(0).withNano(0)
        val choix = mutableListOf<Pair<String, java.time.ZonedDateTime?>>()
        choix += "Dans 1 heure" to maintenant.plusHours(1)
        if (ceSoir.isAfter(maintenant.plusMinutes(5))) choix += "Ce soir à 18 h" to ceSoir
        choix += "Demain à 8 h" to maintenant.plusDays(1).withHour(8).withMinute(0).withSecond(0).withNano(0)
        choix += "Choisir le jour et l'heure…" to null
        android.app.AlertDialog.Builder(this)
            .setTitle("Me rappeler")
            .setItems(choix.map { it.first }.toTypedArray()) { _, n ->
                val quand = choix[n].second
                if (quand != null) enregistrerRappel(id, quand) else choisirDateHeure(id)
            }
            .show()
    }

    private fun choisirDateHeure(id: String) {
        val d = java.time.ZonedDateTime.now().plusHours(1)
        android.app.DatePickerDialog(this, { _, a, m, j ->
            android.app.TimePickerDialog(this, { _, h, mn ->
                enregistrerRappel(id, java.time.ZonedDateTime.of(a, m + 1, j, h, mn, 0, 0, java.time.ZoneId.systemDefault()))
            }, 9, 0, true).show()
        }, d.year, d.monthValue - 1, d.dayOfMonth).show()
    }

    private fun enregistrerRappel(id: String, quand: java.time.ZonedDateTime) {
        if (quand.isBefore(java.time.ZonedDateTime.now())) {
            Toast.makeText(this, "Cette heure est déjà passée.", Toast.LENGTH_LONG).show()
            return
        }
        enFond({
            Supabase.ajouterRappel(this, id, quand.toInstant())
            Rappels.synchroniser(this)
        }) { erreur ->
            if (erreur == null) {
                val texte = java.time.format.DateTimeFormatter.ofPattern("EEEE d MMMM 'à' H'h'mm", Locale.FRANCE).format(quand)
                Toast.makeText(this, "Rappel $texte.", Toast.LENGTH_LONG).show()
                finish()
            } else {
                Toast.makeText(this, "Rappel impossible : " + (erreur.message ?: "erreur"), Toast.LENGTH_LONG).show()
            }
        }
    }
}

// ---------- Confirmation avant de terminer une tâche depuis le widget ----------
class ConfirmerActivity : Activity() {
    override fun onCreate(etat: Bundle?) {
        super.onCreate(etat)
        val id = intent.getStringExtra("id")
        if (id == null) { finish(); return }
        val libelle = intent.getStringExtra("libelle") ?: ""
        val etatActuel = intent.getStringExtra("etat") ?: "a_faire"
        val nuit = (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) ==
            android.content.res.Configuration.UI_MODE_NIGHT_YES
        val theme = if (nuit) android.R.style.Theme_Material_Dialog_Alert else android.R.style.Theme_Material_Light_Dialog_Alert
        android.app.AlertDialog.Builder(this, theme)
            .setTitle("Terminer cette tâche ?")
            .setMessage(libelle)
            .setNegativeButton("Annuler", null)
            .setPositiveButton("✓ Terminer") { _, _ ->
                val ctx = applicationContext
                thread {
                    val erreur = try { Supabase.changerEtat(ctx, id, etatActuel, "fait"); null } catch (e: Exception) { e }
                    principal.post {
                        Toast.makeText(ctx, if (erreur == null) "Fait : $libelle" else "Impossible : " + (erreur.message ?: "erreur"), Toast.LENGTH_SHORT).show()
                        WidgetTaches.actualiser(ctx)
                    }
                }
            }
            .setOnDismissListener { finish() }
            .show()
    }
}

/**
 * Panneau du bas qu'on ferme en le glissant vers le bas, quand son contenu est défilé tout en haut.
 * À appeler depuis dispatchTouchEvent de l'activité.
 */
class GlisserPourFermer(private val a: Activity) {
    private var depart = -1f
    private var x0 = 0f
    private var enCours = false
    private fun dp(n: Int) = n * a.resources.displayMetrics.density

    fun traiter(e: android.view.MotionEvent, suite: (android.view.MotionEvent) -> Boolean): Boolean {
        val defile = a.findViewById<android.view.ViewGroup>(android.R.id.content).getChildAt(0) as? android.widget.ScrollView
        val decor = a.window.decorView
        when (e.actionMasked) {
            android.view.MotionEvent.ACTION_DOWN -> {
                depart = if ((defile?.scrollY ?: 0) == 0) e.rawY else -1f
                x0 = e.rawX
                enCours = false
            }
            android.view.MotionEvent.ACTION_MOVE -> if (depart >= 0) {
                val dy = e.rawY - depart
                if (!enCours && dy > dp(12) && dy > 2 * kotlin.math.abs(e.rawX - x0)) {
                    enCours = true
                    // Les boutons sous le doigt ne doivent pas recevoir de « toucher ».
                    suite(android.view.MotionEvent.obtain(e).apply { action = android.view.MotionEvent.ACTION_CANCEL })
                }
                if (enCours) { decor.translationY = maxOf(0f, dy); return true }
                if (dy < -dp(12)) depart = -1f
            }
            android.view.MotionEvent.ACTION_UP, android.view.MotionEvent.ACTION_CANCEL -> if (enCours) {
                enCours = false
                if (decor.translationY > dp(90)) {
                    decor.animate().translationY(decor.height.toFloat()).setDuration(160).withEndAction {
                        a.finish()
                        @Suppress("DEPRECATION")
                        a.overridePendingTransition(0, 0)
                    }.start()
                } else {
                    decor.animate().translationY(0f).setDuration(160).start()
                }
                return true
            }
        }
        return suite(e)
    }
}
