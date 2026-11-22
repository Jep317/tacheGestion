package io.github.jep317.taches

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.text.SpannableString
import android.text.style.StyleSpan
import android.graphics.Typeface
import android.view.View
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// Widget de l'écran d'accueil : la liste (À trier, Maintenant, Bientôt), et les boutons Ajouter, Dicter, Actualiser.
class WidgetTaches : AppWidgetProvider() {

    override fun onUpdate(ctx: Context, gestionnaire: AppWidgetManager, ids: IntArray) {
        for (id in ids) gestionnaire.updateAppWidget(id, vues(ctx, id))
        gestionnaire.notifyAppWidgetViewDataChanged(ids, R.id.liste)
    }

    override fun onReceive(ctx: Context, intent: Intent) {
        when (intent.action) {
            ACTUALISER -> actualiser(ctx)
            ONGLET -> {
                val id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
                if (id != AppWidgetManager.INVALID_APPWIDGET_ID) {
                    choisirOnglet(ctx, id, intent.getStringExtra("onglet") ?: TACHES)
                    val g = AppWidgetManager.getInstance(ctx)
                    g.updateAppWidget(id, vues(ctx, id))
                    g.notifyAppWidgetViewDataChanged(intArrayOf(id), R.id.liste)
                }
            }
            else -> super.onReceive(ctx, intent)
        }
    }

    override fun onDeleted(ctx: Context, ids: IntArray) {
        val e = ctx.getSharedPreferences("widget", Context.MODE_PRIVATE).edit()
        for (id in ids) e.remove("onglet_$id").remove("cat_$id").remove("proj_$id")
        e.apply()
    }

    companion object {
        const val ACTUALISER = "io.github.jep317.taches.ACTUALISER"
        const val ONGLET = "io.github.jep317.taches.ONGLET"
        const val TACHES = "taches"
        const val NOTES = "notes"

        /** Onglet affiché par un widget posé : « taches » ou « notes ». */
        fun onglet(ctx: Context, id: Int): String =
            ctx.getSharedPreferences("widget", Context.MODE_PRIVATE).getString("onglet_$id", TACHES) ?: TACHES

        /** Filtre d'un widget : catégorie (nom, ou "" = sans catégorie) et projet ; null = pas de filtre. */
        fun filtreCategorie(ctx: Context, id: Int): String? =
            ctx.getSharedPreferences("widget", Context.MODE_PRIVATE).getString("cat_$id", null)
        fun filtreProjet(ctx: Context, id: Int): String? =
            ctx.getSharedPreferences("widget", Context.MODE_PRIVATE).getString("proj_$id", null)
        fun choisirFiltre(ctx: Context, id: Int, categorie: String?, projet: String?) {
            val e = ctx.getSharedPreferences("widget", Context.MODE_PRIVATE).edit()
            if (categorie == null) e.remove("cat_$id") else e.putString("cat_$id", categorie)
            if (projet == null) e.remove("proj_$id") else e.putString("proj_$id", projet)
            e.commit()
            val g = AppWidgetManager.getInstance(ctx)
            g.updateAppWidget(id, vues(ctx, id))
            g.notifyAppWidgetViewDataChanged(intArrayOf(id), R.id.liste)
        }

        private fun choisirOnglet(ctx: Context, id: Int, onglet: String) =
            ctx.getSharedPreferences("widget", Context.MODE_PRIVATE).edit().putString("onglet_$id", onglet).commit()

        private fun versOnglet(ctx: Context, id: Int, onglet: String): PendingIntent {
            val i = Intent(ctx, WidgetTaches::class.java).setAction(ONGLET)
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
                .putExtra("onglet", onglet)
            i.data = Uri.parse("taches://onglet/$id/$onglet") // un PendingIntent distinct par widget et par onglet
            return PendingIntent.getBroadcast(ctx, 0, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        }

        private fun ids(ctx: Context): IntArray =
            AppWidgetManager.getInstance(ctx).getAppWidgetIds(ComponentName(ctx, WidgetTaches::class.java))

        /** Redessine les widgets et recharge la liste depuis Supabase. */
        fun actualiser(ctx: Context) {
            Rappels.programmerSynchro(ctx) // les rappels se resynchronisent en même temps que la liste
            val g = AppWidgetManager.getInstance(ctx)
            val ids = ids(ctx)
            if (ids.isEmpty()) return
            for (id in ids) g.updateAppWidget(id, vues(ctx, id, "…"))
            g.notifyAppWidgetViewDataChanged(ids, R.id.liste)
        }

        /** Met à jour la petite mention d'heure dans l'en-tête. */
        fun indiquerEtat(ctx: Context, texte: String) {
            val g = AppWidgetManager.getInstance(ctx)
            for (id in ids(ctx)) {
                val v = RemoteViews(ctx.packageName, R.layout.widget)
                v.setTextViewText(R.id.etat, texte)
                g.partiallyUpdateAppWidget(id, v)
            }
        }

        private fun activite(ctx: Context, code: Int, intent: Intent, modifiable: Boolean = false): PendingIntent =
            PendingIntent.getActivity(
                ctx, code, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or (if (modifiable) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE),
            )

        fun vues(ctx: Context, id: Int, etat: String? = null): RemoteViews {
            val v = RemoteViews(ctx.packageName, R.layout.widget)

            // Liste, fournie par ServiceListe ; l'URI distingue chaque widget posé.
            val service = Intent(ctx, ServiceListe::class.java)
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
            service.data = Uri.parse(service.toUri(Intent.URI_INTENT_SCHEME))
            @Suppress("DEPRECATION")
            v.setRemoteAdapter(R.id.liste, service)
            v.setEmptyView(R.id.liste, R.id.vide)

            // Toucher une ligne : détail de la tâche (ou l'appli complète pour les lignes de résumé).
            v.setPendingIntentTemplate(R.id.liste, activite(ctx, 10, Intent(ctx, DetailActivity::class.java), modifiable = true))

            val notes = onglet(ctx, id) == NOTES
            val actif = ctx.getColor(R.color.texte)
            val inactif = ctx.getColor(R.color.discret)
            v.setTextColor(R.id.onglet_taches, if (notes) inactif else actif)
            v.setTextColor(R.id.onglet_notes, if (notes) actif else inactif)
            v.setOnClickPendingIntent(R.id.onglet_taches, versOnglet(ctx, id, TACHES))
            v.setOnClickPendingIntent(R.id.onglet_notes, versOnglet(ctx, id, NOTES))

            val cat = filtreCategorie(ctx, id)
            val proj = filtreProjet(ctx, id)
            val morceaux = listOfNotNull(cat?.let { if (it.isEmpty()) "Sans catégorie" else it }, proj)
            v.setTextViewText(R.id.filtre, if (morceaux.isEmpty()) "Filtrer : tout ▾" else "Filtre : " + morceaux.joinToString(" · ") + " ▾")
            val filtre = Intent(ctx, FiltreActivity::class.java).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
            filtre.data = Uri.parse("taches://filtre/$id")
            v.setOnClickPendingIntent(R.id.filtre, activite(ctx, 0, filtre))
            v.setOnClickPendingIntent(R.id.vide, activite(ctx, 2, Intent(ctx, MainActivity::class.java)))
            v.setOnClickPendingIntent(R.id.btn_ajouter, activite(ctx, 3, Intent(ctx, AjoutActivity::class.java)))
            v.setOnClickPendingIntent(
                R.id.btn_dicter,
                activite(ctx, 4, Intent(ctx, AjoutActivity::class.java).putExtra(AjoutActivity.VOCAL, true)),
            )
            v.setOnClickPendingIntent(R.id.btn_courses, activite(ctx, 6, Intent(ctx, CoursesActivity::class.java)))
            val actu = Intent(ctx, WidgetTaches::class.java).setAction(ACTUALISER)
            v.setOnClickPendingIntent(
                R.id.btn_actualiser,
                PendingIntent.getBroadcast(ctx, 5, actu, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE),
            )
            if (etat != null) v.setTextViewText(R.id.etat, etat)
            return v
        }
    }
}

class ServiceListe : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory =
        Fabrique(applicationContext, intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID))
}

/** Construit les lignes de la liste du widget. Appelée sur un fil de fond : le réseau y est permis. */
class Fabrique(private val ctx: Context, private val widgetId: Int) : RemoteViewsService.RemoteViewsFactory {

    private sealed class Ligne {
        class Entete(val nom: String, val compte: Int) : Ligne()
        class Tache(val item: Supabase.Item) : Ligne()
        class Info(val texte: String) : Ligne()
        class Courses(val restants: Int) : Ligne()
    }

    private var lignes: List<Ligne> = emptyList()

    override fun onCreate() {}
    override fun onDestroy() {}
    override fun getCount() = lignes.size
    override fun getViewTypeCount() = 3
    override fun getItemId(position: Int) = position.toLong()
    override fun hasStableIds() = false
    override fun getLoadingView(): RemoteViews? = null

    override fun onDataSetChanged() {
        if (!Supabase.estConnecte(ctx)) {
            lignes = listOf(Ligne.Info("Ouvre l'appli Tâches pour te connecter."))
            WidgetTaches.indiquerEtat(ctx, "")
            return
        }
        val heure = SimpleDateFormat("HH:mm", Locale.FRANCE)
        val items = try {
            val l = Supabase.lireListe(ctx)
            WidgetTaches.indiquerEtat(ctx, heure.format(Date()))
            l
        } catch (e: Exception) {
            val cache = Cache.lire(ctx)
            if (!Supabase.estConnecte(ctx)) {
                lignes = listOf(Ligne.Info("Session expirée : ouvre l'appli Tâches pour te reconnecter."))
                WidgetTaches.indiquerEtat(ctx, "")
                return
            }
            WidgetTaches.indiquerEtat(ctx, if (cache != null) "hors ligne · " + heure.format(Date(Cache.date(ctx))) else "hors ligne")
            if (cache == null) {
                lignes = listOf(Ligne.Info("Liste indisponible pour l'instant. Touche ↻ pour réessayer."))
                return
            }
            Supabase.analyser(cache)
        }
        // Filtre catégorie / projet du widget, comme les pastilles de l'appli web.
        val cat = WidgetTaches.filtreCategorie(ctx, widgetId)
        val proj = WidgetTaches.filtreProjet(ctx, widgetId)
        val filtres = items.filter { i ->
            (cat == null || (if (cat.isEmpty()) i.categorie == null && i.etat != "a_trier" else i.categorie == cat)) &&
                (proj == null || i.projet == proj)
        }
        lignes = if (WidgetTaches.onglet(ctx, widgetId) == WidgetTaches.NOTES) construireNotes(filtres) else construire(filtres)
        if (lignes.isEmpty() || (cat != null || proj != null) && filtres.isEmpty()) {
            lignes = listOf(Ligne.Info("Rien avec ce filtre. Touche « Filtre » en haut pour tout voir."))
        }
    }

    /** Onglet Notes : notes et idées rangées par projet, comme l'onglet Notes de l'appli. */
    private fun construireNotes(items: List<Supabase.Item>): List<Ligne> {
        val notes = items.filter { it.type == "note" || it.type == "idee" }
        if (notes.isEmpty()) return listOf(Ligne.Info("Pas encore de notes. Dicte par exemple « note : code du portail 1234 », Claude la rangera ici."))
        val res = mutableListOf<Ligne>()
        val groupes = notes.groupBy { it.projet?.takeIf { p -> p.isNotBlank() } }
        val noms = groupes.keys.filterNotNull().sortedBy { it.lowercase(Locale.FRANCE) }
        for (nom in noms) {
            val g = groupes.getValue(nom)
            res += Ligne.Entete(nom, g.size)
            g.forEach { res += Ligne.Tache(it) }
        }
        groupes[null]?.let { g ->
            res += Ligne.Entete(if (noms.isEmpty()) "Notes et idées" else "Sans projet", g.size)
            g.forEach { res += Ligne.Tache(it) }
        }
        return res
    }

    private fun construire(items: List<Supabase.Item>): List<Ligne> {
        val res = mutableListOf<Ligne>()
        val listes = setOf("tache", "course")
        Cache.courses(ctx).let { if (it >= 0) res += Ligne.Courses(it) }
        // Résumé du matin : les priorités choisies par Claude pour aujourd'hui (heure de Paris).
        val jour = java.time.LocalDate.now(java.time.ZoneId.of("Europe/Paris")).toString()
        val prio = items.filter { it.prioriteJour == jour && (it.etat == "a_faire" || it.etat == "en_cours") }
            .sortedBy { it.prioriteRang }
        if (prio.isNotEmpty()) {
            res += Ligne.Entete("Aujourd'hui", prio.size)
            prio.forEach { res += Ligne.Tache(it) }
        }
        val aTrier = items.filter { it.etat == "a_trier" }
        if (aTrier.isNotEmpty()) {
            res += Ligne.Entete("À trier", aTrier.size)
            aTrier.forEach { res += Ligne.Tache(it) }
        }
        fun horizon(cle: String) = items.filter { it.etat != "a_trier" && it.horizon == cle && it.type in listes }
        for ((cle, nom) in listOf("maintenant" to "Maintenant", "bientot" to "Bientôt")) {
            val h = horizon(cle)
            res += Ligne.Entete(nom, h.size)
            if (h.isEmpty()) res += Ligne.Info("Rien ici.")
            h.forEach { res += Ligne.Tache(it) }
        }
        val plusTard = horizon("plus_tard").size
        val unJour = horizon("un_jour").size
        if (plusTard + unJour > 0) res += Ligne.Info("Plus tard : $plusTard · Un jour : $unJour — toucher pour tout voir")
        return res
    }

    override fun getViewAt(position: Int): RemoteViews {
        val l = lignes.getOrNull(position) ?: return RemoteViews(ctx.packageName, R.layout.ligne_info)
        return when (l) {
            is Ligne.Entete -> RemoteViews(ctx.packageName, R.layout.ligne_entete).apply {
                setTextViewText(R.id.nom, l.nom)
                setTextViewText(R.id.compte, l.compte.toString())
            }
            is Ligne.Info -> RemoteViews(ctx.packageName, R.layout.ligne_info).apply {
                setTextViewText(R.id.texte, l.texte)
                setOnClickFillInIntent(R.id.texte, Intent())
            }
            is Ligne.Courses -> RemoteViews(ctx.packageName, R.layout.ligne_tache).apply {
                setTextViewText(R.id.titre, "🛒 Courses")
                setTextViewText(R.id.meta, when (l.restants) { 0 -> "Liste vide · toucher pour ajouter"; 1 -> "1 article"; else -> "${l.restants} articles" })
                setViewVisibility(R.id.meta, View.VISIBLE)
                setOnClickFillInIntent(R.id.ligne, Intent().putExtra("courses", true))
            }
            is Ligne.Tache -> RemoteViews(ctx.packageName, R.layout.ligne_tache).apply {
                val i = l.item
                if (i.titre == null) {
                    val s = SpannableString(i.libelle)
                    s.setSpan(StyleSpan(Typeface.ITALIC), 0, s.length, 0)
                    setTextViewText(R.id.titre, s)
                } else {
                    setTextViewText(R.id.titre, i.libelle)
                }
                val meta = Details.meta(i)
                setTextViewText(R.id.meta, meta)
                setViewVisibility(R.id.meta, if (meta.isEmpty()) View.GONE else View.VISIBLE)
                setOnClickFillInIntent(R.id.ligne, Details.intention(i))
                if (i.type == "note" || i.type == "idee") {
                    setTextViewText(R.id.rond, "•")
                } else {
                    setTextViewText(R.id.rond, "○")
                    // Toucher le rond : terminer, après confirmation.
                    setOnClickFillInIntent(R.id.rond, Details.intention(i).putExtra("action", "terminer"))
                }
            }
        }
    }
}
