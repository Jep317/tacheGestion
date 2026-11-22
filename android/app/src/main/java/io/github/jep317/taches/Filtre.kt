package io.github.jep317.taches

import android.app.Activity
import android.app.AlertDialog
import android.appwidget.AppWidgetManager
import android.content.res.Configuration
import android.os.Bundle

/** Choix du filtre d'un widget : une catégorie et/ou un projet, parmi ceux présents dans la liste. */
class FiltreActivity : Activity() {
    override fun onCreate(etat: Bundle?) {
        super.onCreate(etat)
        val id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
        if (id == AppWidgetManager.INVALID_APPWIDGET_ID) { finish(); return }

        val items = Cache.lire(this)?.let { try { Supabase.analyser(it) } catch (_: Exception) { null } } ?: emptyList()
        val categories = items.mapNotNull { it.categorie }.distinct().sortedBy { it.lowercase() }
        val sansCategorie = items.any { it.categorie == null && it.etat != "a_trier" }
        val projets = items.mapNotNull { it.projet?.takeIf { p -> p.isNotBlank() } }.distinct().sortedBy { it.lowercase() }
        val cat = WidgetTaches.filtreCategorie(this, id)
        val proj = WidgetTaches.filtreProjet(this, id)

        // Chaque ligne : texte affiché et effet (nouvelle catégorie, nouveau projet).
        class Choix(val texte: String, val categorie: String?, val projet: String?)
        val choix = mutableListOf<Choix>()
        fun coche(actif: Boolean) = if (actif) "✓ " else "    "
        choix += Choix(coche(cat == null && proj == null) + "Tout voir", null, null)
        if (categories.isNotEmpty() || sansCategorie) {
            choix += Choix(coche(cat == null && proj != null) + "Toutes les catégories", null, proj)
            categories.forEach { choix += Choix(coche(cat == it) + "Catégorie : $it", it, proj) }
            if (sansCategorie) choix += Choix(coche(cat == "") + "Sans catégorie", "", proj)
        }
        if (projets.isNotEmpty()) {
            choix += Choix(coche(proj == null && cat != null) + "Tous les projets", cat, null)
            projets.forEach { choix += Choix(coche(proj == it) + "Projet : $it", cat, it) }
        }

        val nuit = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        val theme = if (nuit) android.R.style.Theme_Material_Dialog_Alert else android.R.style.Theme_Material_Light_Dialog_Alert
        AlertDialog.Builder(this, theme)
            .setTitle("Filtrer le widget")
            .setItems(choix.map { it.texte }.toTypedArray()) { _, n ->
                WidgetTaches.choisirFiltre(this, id, choix[n].categorie, choix[n].projet)
            }
            .setOnDismissListener { finish() }
            .show()
    }
}
