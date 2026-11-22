package io.github.jep317.taches

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
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
        i.projet?.let { m += it }
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
    }

    private lateinit var saisie: EditText
    private var source = "widget"

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
        val envoyer = findViewById<Button>(R.id.btn_envoyer)
        findViewById<ImageButton>(R.id.btn_micro).setOnClickListener { dicter() }
        findViewById<Button>(R.id.btn_annuler).setOnClickListener { finish() }
        envoyer.setOnClickListener { envoyer(envoyer) }
        saisie.setOnEditorActionListener { _, action, _ ->
            if (action == EditorInfo.IME_ACTION_SEND) { envoyer(envoyer); true } else false
        }
        if (etat == null && intent.getBooleanExtra(VOCAL, false)) {
            dicter()
        } else {
            saisie.requestFocus()
            window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE)
        }
    }

    private fun dicter() {
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
        } else if (saisie.text.isBlank() && intent.getBooleanExtra(VOCAL, false)) {
            // Dictée annulée depuis le bouton micro du widget : on referme sans rien laisser à l'écran.
            finish()
        }
    }

    private fun envoyer(bouton: Button) {
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
        if (id == null) {
            // Ligne de résumé : ouvrir l'appli complète (ou la connexion si besoin).
            if (Supabase.estConnecte(this)) ouvrirAppliWeb(this)
            else startActivity(Intent(this, MainActivity::class.java))
            finish()
            return
        }
        setContentView(R.layout.ecran_detail)
        val etatActuel = intent.getStringExtra("etat") ?: "a_faire"
        findViewById<TextView>(R.id.titre).text = intent.getStringExtra("libelle")
        fun remplir(vue: Int, texte: String?) {
            val t = findViewById<TextView>(vue)
            if (texte.isNullOrBlank()) t.visibility = View.GONE else t.text = texte
        }
        remplir(R.id.meta, intent.getStringExtra("meta"))
        remplir(R.id.details, intent.getStringExtra("details"))
        remplir(R.id.brut, intent.getStringExtra("brut")?.let { "« $it »" })

        val fait = findViewById<Button>(R.id.btn_fait)
        val enCours = findViewById<Button>(R.id.btn_en_cours)
        if (etatActuel == "en_cours") enCours.visibility = View.GONE
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
        fait.setOnClickListener { changer("fait", "Fait.") }
        enCours.setOnClickListener { changer("en_cours", "Marqué en cours.") }

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
