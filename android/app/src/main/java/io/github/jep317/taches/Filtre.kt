package io.github.jep317.taches

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Context
import android.graphics.Typeface
import android.os.Bundle
import android.text.SpannableString
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.util.Locale

/**
 * Filtre d'un widget, comme les pastilles de l'appli PC : un panneau qui monte du bas,
 * une rangée de pastilles « Catégorie » et une rangée « Sujet ». Toucher une pastille applique et ferme ;
 * glisser vers le bas, toucher à côté ou le bouton retour ferment sans rien changer.
 */
class FiltreActivity : Activity() {
    companion object {
        const val EFFACER = "effacer"
        private val COULEURS = intArrayOf(R.color.c0, R.color.c1, R.color.c2, R.color.c3, R.color.c4, R.color.c5, R.color.c6, R.color.c7)
    }

    private val glisse = GlisserPourFermer(this)
    override fun dispatchTouchEvent(e: android.view.MotionEvent): Boolean =
        glisse.traiter(e) { super.dispatchTouchEvent(it) }

    private var id = AppWidgetManager.INVALID_APPWIDGET_ID
    private var items: List<Supabase.Item> = emptyList()
    private var cat: String? = null
    private var proj: String? = null
    private lateinit var rangeeCat: Rangee
    private lateinit var rangeeSujet: Rangee
    private lateinit var titreSujet: TextView

    override fun onCreate(etat: Bundle?) {
        super.onCreate(etat)
        id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
        if (id == AppWidgetManager.INVALID_APPWIDGET_ID) { finish(); return }
        if (intent.getBooleanExtra(EFFACER, false)) {
            WidgetTaches.choisirFiltre(this, id, null, null)
            finish()
            return
        }
        items = Cache.lire(this)?.let { try { Supabase.analyser(it) } catch (_: Exception) { null } } ?: emptyList()
        cat = WidgetTaches.filtreCategorie(this, id)
        proj = WidgetTaches.filtreProjet(this, id)

        val d = resources.displayMetrics.density
        fun dp(n: Int) = (n * d).toInt()
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(10), dp(20), dp(28))
        }
        col.addView(View(this).apply { setBackgroundResource(R.drawable.fond_poignee) },
            LinearLayout.LayoutParams(dp(36), dp(4)).apply { gravity = Gravity.CENTER_HORIZONTAL })
        col.addView(TextView(this).apply {
            text = "Filtrer le widget"
            setTextColor(getColor(R.color.texte))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
            setTypeface(typeface, Typeface.BOLD)
            setPadding(0, dp(14), 0, dp(4))
        })
        fun rubrique(t: String) = TextView(this).apply {
            text = t
            setTextColor(getColor(R.color.accent))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setTypeface(typeface, Typeface.BOLD)
            setPadding(0, dp(14), 0, dp(8))
        }
        col.addView(rubrique("Catégorie"))
        rangeeCat = Rangee(this, dp(8))
        col.addView(rangeeCat)
        titreSujet = rubrique("Sujet")
        col.addView(titreSujet)
        rangeeSujet = Rangee(this, dp(8))
        col.addView(rangeeSujet)


        setContentView(ScrollView(this).apply { addView(col) })
        window.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT)
        window.setGravity(Gravity.BOTTOM)
        remplir()
    }

    /** Types de l'onglet affiché par le widget (tâches ou notes), comme l'appli PC. */
    private fun dansOnglet(i: Supabase.Item) =
        if (WidgetTaches.onglet(this, id) == WidgetTaches.NOTES) i.type == "note" || i.type == "idee"
        else i.type == "tache" || i.type == "course"

    private fun dansCategorie(i: Supabase.Item, c: String?) =
        c == null || (if (c.isEmpty()) i.categorie == null && i.etat != "a_trier" else i.categorie == c)

    private fun remplir() {
        // Catégories : l'ordre et les couleurs de l'appli PC ; à défaut, celles présentes dans la liste.
        val connues = Cache.categories(this).ifEmpty {
            items.mapNotNull { it.categorie }.distinct().sortedBy { it.lowercase(Locale.FRANCE) }
        }
        rangeeCat.removeAllViews()
        rangeeCat.addView(pastille("Tout", cat == null, null) { choisirCategorie(null) })
        connues.forEachIndexed { n, c ->
            rangeeCat.addView(pastille(c, cat == c, getColor(COULEURS[n % COULEURS.size])) { choisirCategorie(c) })
        }
        if (items.any { it.categorie == null && it.etat != "a_trier" }) {
            rangeeCat.addView(pastille("Sans catégorie", cat == "", null) { choisirCategorie("") })
        }

        // Sujets : ceux de l'onglet affiché, dans la catégorie choisie.
        val vus = items.filter { it.etat != "a_trier" && dansOnglet(it) && dansCategorie(it, cat) }
        val sujets = vus.mapNotNull { it.projet?.trim()?.takeIf { p -> p.isNotEmpty() } }
            .distinct().sortedBy { it.lowercase(Locale.FRANCE) }
        val sansSujet = vus.any { it.projet.isNullOrBlank() }
        rangeeSujet.removeAllViews()
        val montrer = sujets.isNotEmpty() || proj != null
        titreSujet.visibility = if (montrer) View.VISIBLE else View.GONE
        rangeeSujet.visibility = if (montrer) View.VISIBLE else View.GONE
        rangeeSujet.addView(pastille("Tous les sujets", proj == null, null) { choisirSujet(null) })
        sujets.forEach { s -> rangeeSujet.addView(pastille(s, proj == s, null) { choisirSujet(s) }) }
        if (proj != null && proj != "" && proj !in sujets) rangeeSujet.addView(pastille(proj!!, true, null) { choisirSujet(proj) })
        if (sansSujet && sujets.isNotEmpty()) rangeeSujet.addView(pastille("Sans sujet", proj == "", null) { choisirSujet("") })
    }

    private fun choisirCategorie(c: String?) {
        // Le sujet choisi est gardé seulement s'il existe encore dans la nouvelle catégorie.
        val p = proj?.takeIf { s -> items.any { dansCategorie(it, c) && dansOnglet(it) && (if (s.isEmpty()) it.projet.isNullOrBlank() else it.projet?.trim() == s) } }
        appliquer(c, p)
        finish()
    }

    private fun choisirSujet(s: String?) {
        appliquer(cat, s)
        finish()
    }

    private fun appliquer(c: String?, p: String?) {
        cat = c; proj = p
        WidgetTaches.choisirFiltre(this, id, c, p)
    }

    /** Une pastille arrondie ; [couleur] : point de couleur de la catégorie. */
    private fun pastille(texte: String, actif: Boolean, couleur: Int?, action: () -> Unit): TextView {
        val d = resources.displayMetrics.density
        return TextView(this).apply {
            text = if (couleur == null) texte else SpannableString("●  $texte").apply {
                setSpan(ForegroundColorSpan(if (actif) getColor(R.color.accent_texte) else couleur), 0, 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setTextColor(getColor(if (actif) R.color.accent_texte else R.color.texte))
            if (actif) setTypeface(typeface, Typeface.BOLD)
            setBackgroundResource(if (actif) R.drawable.fond_filtre_actif else R.drawable.fond_filtre)
            setPadding((14 * d).toInt(), (8 * d).toInt(), (14 * d).toInt(), (8 * d).toInt())
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
            isClickable = true
            setOnClickListener { action() }
        }
    }
}

/** Rangée de pastilles qui passe à la ligne quand la place manque. */
class Rangee(ctx: Context, private val ecart: Int) : ViewGroup(ctx) {
    override fun onMeasure(largeurSpec: Int, hauteurSpec: Int) {
        val largeur = MeasureSpec.getSize(largeurSpec)
        var x = 0; var y = 0; var hLigne = 0
        for (n in 0 until childCount) {
            val e = getChildAt(n)
            if (e.visibility == GONE) continue
            e.measure(MeasureSpec.makeMeasureSpec(largeur, MeasureSpec.AT_MOST), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
            if (x > 0 && x + e.measuredWidth > largeur) { x = 0; y += hLigne + ecart; hLigne = 0 }
            x += e.measuredWidth + ecart
            hLigne = maxOf(hLigne, e.measuredHeight)
        }
        setMeasuredDimension(largeur, y + hLigne)
    }

    override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
        val largeur = r - l
        var x = 0; var y = 0; var hLigne = 0
        for (n in 0 until childCount) {
            val e = getChildAt(n)
            if (e.visibility == GONE) continue
            if (x > 0 && x + e.measuredWidth > largeur) { x = 0; y += hLigne + ecart; hLigne = 0 }
            e.layout(x, y, x + e.measuredWidth, y + e.measuredHeight)
            x += e.measuredWidth + ecart
            hLigne = maxOf(hLigne, e.measuredHeight)
        }
    }
}
