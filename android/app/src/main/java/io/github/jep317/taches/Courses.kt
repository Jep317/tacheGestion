package io.github.jep317.taches

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Paint
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognizerIntent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.ArrayAdapter
import android.widget.AutoCompleteTextView
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.CheckBox
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import android.widget.Toast
import kotlin.concurrent.thread

// ---------- Liste de courses : ajout rapide (texte, dictée, suggestions), un appui = acheté ----------
// La liste est la tâche spéciale « 🛒 Courses » ; ses articles sont les lignes de sa checklist.
// Un article coché disparaît au bout de quelques secondes (le temps de se rattraper en le décochant).
class CoursesActivity : Activity() {
    companion object {
        private const val CODE_DICTEE = 2
        private const val DELAI_ACHETE = 4000L
    }

    private val principal = Handler(Looper.getMainLooper())
    private var idCourses: String? = null
    private var articles: List<Supabase.Article> = emptyList()
    private var historique: List<String> = emptyList()
    private val effacements = HashMap<String, Runnable>()

    private lateinit var saisie: AutoCompleteTextView
    private lateinit var vide: TextView
    private lateinit var suggestions: LinearLayout
    private val adaptateur = Adaptateur()

    private fun enFond(travail: () -> Unit, ensuite: (Exception?) -> Unit = {}) {
        thread {
            val erreur = try { travail(); null } catch (e: Exception) { e }
            principal.post { if (!isFinishing && !isDestroyed) ensuite(erreur) }
        }
    }

    override fun onCreate(etat: Bundle?) {
        super.onCreate(etat)
        if (!Supabase.estConnecte(this)) {
            Toast.makeText(this, "Connecte-toi d'abord dans l'appli Tâches.", Toast.LENGTH_LONG).show()
            startActivity(Intent(this, MainActivity::class.java))
            finish()
            return
        }
        setContentView(R.layout.ecran_courses)
        saisie = findViewById(R.id.saisie)
        vide = findViewById(R.id.vide)
        suggestions = findViewById(R.id.suggestions)
        val liste = findViewById<ListView>(R.id.liste)
        liste.adapter = adaptateur
        liste.emptyView = vide
        findViewById<Button>(R.id.btn_fermer).setOnClickListener { finish() }
        findViewById<ImageButton>(R.id.btn_micro).setOnClickListener { dicter() }
        findViewById<ImageButton>(R.id.btn_envoyer).setOnClickListener { envoyer(saisie.text.toString(), false) }
        saisie.setOnEditorActionListener { _, action, _ ->
            if (action == EditorInfo.IME_ACTION_DONE || action == EditorInfo.IME_ACTION_SEND) { envoyer(saisie.text.toString(), false); true } else false
        }
        saisie.setOnItemClickListener { _, _, _, _ -> envoyer(saisie.text.toString(), false) }
        saisie.requestFocus()
        charger()
    }

    override fun onPause() {
        super.onPause()
        WidgetTaches.actualiser(this)
    }

    private fun charger() {
        var id: String? = null
        var a: List<Supabase.Article> = emptyList()
        var h: List<String> = emptyList()
        enFond({
            id = idCourses ?: Supabase.idCourses(this)
            a = Supabase.lireArticles(this, id!!)
            h = try { Supabase.lireHistorique(this) } catch (_: Exception) { historique }
        }) { erreur ->
            if (erreur != null) {
                vide.text = "Liste indisponible : " + (erreur.message ?: "pas de connexion ?")
                return@enFond
            }
            idCourses = id
            articles = a
            historique = h
            afficher()
            // Articles cochés ailleurs (ou avant de quitter) : ils disparaissent aussi.
            articles.filter { it.coche }.forEach { programmerEffacement(it) }
        }
    }

    private fun afficher() {
        vide.text = "La liste est vide. Ajoute un article en bas."
        adaptateur.notifyDataSetChanged()
        val restants = articles.count { !it.coche }
        findViewById<TextView>(R.id.titre).text = if (restants > 0) "🛒 Courses ($restants)" else "🛒 Courses"
        val dedans = articles.filter { !it.coche }.map { it.texte.lowercase() }.toSet()
        val proposes = historique.filter { it.lowercase() !in dedans }
        saisie.setAdapter(ArrayAdapter(this, android.R.layout.simple_dropdown_item_1line, proposes))
        suggestions.removeAllViews()
        for (nom in proposes.take(12)) {
            val b = Button(this, null, android.R.attr.borderlessButtonStyle)
            b.text = "＋ $nom"
            b.isAllCaps = false
            b.setTextColor(getColor(R.color.accent))
            b.setOnClickListener { envoyer(nom, false) }
            suggestions.addView(b)
        }
        findViewById<View>(R.id.zone_suggestions).visibility = if (proposes.isEmpty()) View.GONE else View.VISIBLE
    }

    private fun envoyer(brut: String, vocal: Boolean) {
        val id = idCourses ?: return
        // En dictée, « du lait et du pain » donne deux articles.
        val texte = if (vocal) brut.replace(Regex("\\s+(et|puis)\\s+", RegexOption.IGNORE_CASE), ",") else brut
        val dedans = articles.filter { !it.coche }.map { it.texte.lowercase() }.toSet()
        val nouveaux = texte.split(Regex("[\\n;,]+")).map { it.trim().take(200) }.filter { it.isNotEmpty() }
            .distinctBy { it.lowercase() }.filter { it.lowercase() !in dedans }
        saisie.setText("")
        if (nouveaux.isEmpty()) {
            if (texte.isNotBlank()) Toast.makeText(this, "Déjà dans la liste.", Toast.LENGTH_SHORT).show()
            return
        }
        val depart = (articles.maxOfOrNull { it.ordre } ?: 0) + 1
        enFond({ Supabase.ajouterArticles(this, id, nouveaux, depart) }) { erreur ->
            if (erreur != null) {
                saisie.setText(brut)
                Toast.makeText(this, "Ajout impossible : " + (erreur.message ?: "erreur"), Toast.LENGTH_LONG).show()
            } else {
                charger()
            }
        }
    }

    private fun basculer(a: Supabase.Article) {
        a.coche = !a.coche
        afficher()
        if (a.coche) programmerEffacement(a) else effacements.remove(a.id)?.let { principal.removeCallbacks(it) }
        enFond({ Supabase.cocherArticle(this, a.id, a.coche) }) { erreur ->
            if (erreur != null) {
                Toast.makeText(this, "Modification impossible : " + (erreur.message ?: "erreur"), Toast.LENGTH_LONG).show()
                charger()
            }
        }
    }

    private fun programmerEffacement(a: Supabase.Article) {
        if (effacements.containsKey(a.id)) return
        val r = Runnable {
            effacements.remove(a.id)
            if (!a.coche) return@Runnable
            enFond({ Supabase.effacerArticle(this, a.id) }) { charger() }
        }
        effacements[a.id] = r
        principal.postDelayed(r, DELAI_ACHETE)
    }

    private fun dicter() {
        val i = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, "fr-FR")
            .putExtra(RecognizerIntent.EXTRA_PROMPT, "Quels articles ajouter ?")
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
        if (code != CODE_DICTEE || resultat != RESULT_OK) return
        val texte = donnees?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
        if (!texte.isNullOrBlank()) envoyer(texte, true)
    }

    private inner class Adaptateur : BaseAdapter() {
        override fun getCount() = articles.size
        override fun getItem(position: Int) = articles[position]
        override fun getItemId(position: Int) = position.toLong()
        override fun getView(position: Int, recyclee: View?, parent: ViewGroup): View {
            val v = (recyclee ?: layoutInflater.inflate(R.layout.ligne_article, parent, false)) as CheckBox
            val a = articles[position]
            v.text = a.texte
            v.isChecked = a.coche
            v.paintFlags = if (a.coche) v.paintFlags or Paint.STRIKE_THRU_TEXT_FLAG else v.paintFlags and Paint.STRIKE_THRU_TEXT_FLAG.inv()
            v.alpha = if (a.coche) 0.55f else 1f
            v.setOnClickListener { basculer(a) }
            return v
        }
    }
}
