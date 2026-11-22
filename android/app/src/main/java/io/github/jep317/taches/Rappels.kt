package io.github.jep317.taches

import android.Manifest
import android.app.Activity
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import kotlin.concurrent.thread

// Rappels : l'appli lit la table « rappels » de Supabase (toutes les 15 minutes, au démarrage, et après chaque
// rappel ajouté depuis le téléphone) et confie chaque rappel à venir au réveil d'Android (AlarmManager).
// À l'heure dite, RecepteurRappel vérifie que la tâche n'est pas déjà faite, puis affiche la notification.
// Un rappel sans tâche (item_id vide) est un simple message, comme le résumé du matin.
object Rappels {
    private const val CANAL = "rappels"
    private const val JOB_PERIODIQUE = 4201
    private const val JOB_IMMEDIAT = 4202
    const val ALARME = "io.github.jep317.taches.RAPPEL"
    const val FAIT = "io.github.jep317.taches.RAPPEL_FAIT"
    const val REPORTER = "io.github.jep317.taches.RAPPEL_REPORTER"

    private fun prefs(ctx: Context) = ctx.getSharedPreferences("rappels", Context.MODE_PRIVATE)

    // ---------- permission et canal ----------
    fun demanderPermission(a: Activity) {
        if (Build.VERSION.SDK_INT >= 33 &&
            a.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            a.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7)
        }
    }

    private fun canal(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CANAL) == null) {
            val c = NotificationChannel(CANAL, "Rappels", NotificationManager.IMPORTANCE_HIGH)
            c.description = "Rappels des tâches et messages de Claude"
            c.enableVibration(true)
            nm.createNotificationChannel(c)
        }
    }

    // ---------- synchronisation ----------
    /** Toutes les 15 minutes (le minimum d'Android), même appli fermée et après redémarrage. */
    fun programmerSynchro(ctx: Context) {
        val js = ctx.getSystemService(JobScheduler::class.java)
        if (js.getPendingJob(JOB_PERIODIQUE) == null) {
            js.schedule(
                JobInfo.Builder(JOB_PERIODIQUE, ComponentName(ctx, ServiceSynchroRappels::class.java))
                    .setPeriodic(15 * 60 * 1000L)
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setPersisted(true)
                    .build()
            )
        }
        // et une synchro tout de suite
        js.schedule(
            JobInfo.Builder(JOB_IMMEDIAT, ComponentName(ctx, ServiceSynchroRappels::class.java))
                .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                .setOverrideDeadline(60_000)
                .build()
        )
    }

    /** Lit les rappels dans Supabase et (re)programme les alarmes. À appeler hors du fil principal. */
    fun synchroniser(ctx: Context) {
        if (!Supabase.estConnecte(ctx)) { programmer(ctx, JSONArray()); return }
        val texte = Supabase.lireRappels(ctx)
        prefs(ctx).edit().putString("liste", texte).apply()
        programmer(ctx, JSONArray(texte))
    }

    /** Après un redémarrage : on reprogramme à partir de la dernière liste connue. */
    fun reprogrammerDepuisCache(ctx: Context) {
        val t = prefs(ctx).getString("liste", null) ?: return
        try { programmer(ctx, JSONArray(t)) } catch (_: Exception) {}
    }

    private fun programmer(ctx: Context, liste: JSONArray) {
        val am = ctx.getSystemService(AlarmManager::class.java)
        val p = prefs(ctx)
        val dejaVus = vus(ctx)
        val anciens = p.getStringSet("programmes", emptySet())!!
        val nouveaux = mutableSetOf<String>()
        val maintenant = System.currentTimeMillis()
        for (n in 0 until liste.length()) {
            val r = liste.getJSONObject(n)
            val id = r.getString("id")
            val quand = r.getString("quand")
            val cle = "$id|$quand"
            val item = r.optJSONObject("item")
            if (cle in dejaVus) continue
            if (item != null && item.optString("etat") in setOf("fait", "abandonne")) continue
            val t = try { java.time.OffsetDateTime.parse(quand).toInstant().toEpochMilli() } catch (e: Exception) { continue }
            if (t < maintenant - 3600_000) continue
            val pi = alarme(ctx, r, PendingIntent.FLAG_UPDATE_CURRENT) ?: continue
            val declenche = maxOf(t, maintenant + 1000)
            if (Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, declenche, pi)
            } else {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, declenche, pi)
            }
            nouveaux += id
        }
        // Rappels supprimés ou tâches faites depuis la dernière fois : on annule leur alarme.
        for (id in anciens - nouveaux) {
            val r = JSONObject().put("id", id)
            alarme(ctx, r, PendingIntent.FLAG_NO_CREATE)?.let { am.cancel(it); it.cancel() }
        }
        p.edit().putStringSet("programmes", nouveaux).apply()
    }

    private fun alarme(ctx: Context, r: JSONObject, drapeau: Int): PendingIntent? {
        val id = r.getString("id")
        val i = Intent(ctx, RecepteurRappel::class.java).setAction(ALARME)
            .setData(Uri.parse("rappel:$id"))
        if (r.has("quand")) {
            val item = r.optJSONObject("item")
            var texte = r.chaine("texte")
            val echeance = item?.chaine("echeance")
            if (texte == null && item != null && echeance != null) {
                val jour = try {
                    java.time.format.DateTimeFormatter.ofPattern("EEEE d MMMM", java.util.Locale.FRANCE)
                        .format(java.time.LocalDate.parse(echeance))
                } catch (e: Exception) { echeance }
                texte = "Échéance : " + jour + (item.chaine("echeance_heure")?.let { " à " + Details.heureCourte(it) } ?: "")
            }
            i.putExtra("id", id)
                .putExtra("quand", r.getString("quand"))
                .putExtra("item_id", if (r.isNull("item_id")) null else r.optString("item_id"))
                .putExtra("titre", r.chaine("titre") ?: item?.let { it.chaine("titre") ?: it.chaine("texte_brut") } ?: "Rappel")
                .putExtra("texte", texte)
                .putExtra("etat", item?.optString("etat"))
        }
        return PendingIntent.getBroadcast(ctx, 0, i, drapeau or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun JSONObject.chaine(c: String): String? = if (isNull(c)) null else optString(c).ifBlank { null }

    // ---------- déjà montrés (pour ne jamais notifier deux fois le même rappel) ----------
    private fun vus(ctx: Context): Set<String> = prefs(ctx).getStringSet("vus", emptySet())!!

    fun marquerVu(ctx: Context, cle: String) {
        val p = prefs(ctx)
        // On ne garde que les 300 dernières clés.
        val l = (p.getString("vus_ordre", "") ?: "").split('\n').filter { it.isNotBlank() }.toMutableList()
        l += cle
        while (l.size > 300) l.removeAt(0)
        p.edit().putString("vus_ordre", l.joinToString("\n")).putStringSet("vus", l.toSet()).apply()
    }

    // ---------- notification ----------
    fun notifier(ctx: Context, i: Intent) {
        canal(ctx)
        val id = i.getStringExtra("id") ?: return
        val itemId = i.getStringExtra("item_id")
        val titre = i.getStringExtra("titre") ?: "Rappel"
        val num = id.hashCode()

        val ouvrir = if (itemId != null) {
            Intent(ctx, DetailActivity::class.java)
                .putExtra("id", itemId)
                .putExtra("libelle", titre)
                .putExtra("meta", i.getStringExtra("texte"))
                .putExtra("etat", i.getStringExtra("etat") ?: "a_faire")
        } else {
            // Message libre : la revue de la semaine s'ouvre directement sur sa fenêtre.
            val page = if (titre.startsWith("Revue", ignoreCase = true)) "?revue=1" else ""
            Intent(Intent.ACTION_VIEW, Uri.parse(Supabase.APPLI_WEB + page))
        }.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)

        val b = Notification.Builder(ctx, CANAL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(titre)
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_REMINDER)
            .setContentIntent(PendingIntent.getActivity(ctx, num, ouvrir, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        i.getStringExtra("texte")?.let { b.setContentText(it).setStyle(Notification.BigTextStyle().bigText(it)) }

        if (itemId != null) {
            fun action(quoi: String, nom: String): Notification.Action {
                val a = Intent(ctx, RecepteurRappel::class.java).setAction(quoi).setData(Uri.parse("rappel:$id:$quoi"))
                    .putExtra("id", id).putExtra("item_id", itemId).putExtra("etat", i.getStringExtra("etat"))
                    .putExtra("titre", titre).putExtra("texte", i.getStringExtra("texte"))
                val pi = PendingIntent.getBroadcast(ctx, num, a, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                return Notification.Action.Builder(null as android.graphics.drawable.Icon?, nom, pi).build()
            }
            b.addAction(action(FAIT, "✓ Fait"))
            b.addAction(action(REPORTER, "Reporter 1 h"))
        }
        try {
            ctx.getSystemService(NotificationManager::class.java).notify(id, 1, b.build())
        } catch (_: SecurityException) { /* notifications refusées */ }
    }

    fun retirer(ctx: Context, id: String) = ctx.getSystemService(NotificationManager::class.java).cancel(id, 1)
}

/** Réveil d'Android à l'heure d'un rappel, boutons de la notification, et redémarrage du téléphone. */
class RecepteurRappel : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val fin = goAsync()
        thread {
            try { traiter(ctx, intent) } catch (_: Exception) {} finally { fin.finish() }
        }
    }

    private fun traiter(ctx: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> {
                Rappels.reprogrammerDepuisCache(ctx)
                Rappels.programmerSynchro(ctx)
            }
            Rappels.ALARME -> {
                val id = intent.getStringExtra("id") ?: return
                val cle = id + "|" + intent.getStringExtra("quand")
                // Dernière vérification : rappel supprimé, déplacé ou tâche faite entre-temps ? (hors ligne : on notifie)
                val montrer = try {
                    val r = Supabase.lireRappel(ctx, id)
                    val etat = r?.optJSONObject("item")?.optString("etat")
                    r != null && etat !in setOf("fait", "abandonne") &&
                        java.time.OffsetDateTime.parse(r.getString("quand")).toInstant()
                            .isBefore(Instant.now().plusSeconds(120))
                } catch (e: Supabase.ErreurApi) {
                    e.code >= 500 || e.code == 401
                } catch (e: Exception) {
                    true
                }
                Rappels.marquerVu(ctx, cle)
                if (montrer) Rappels.notifier(ctx, intent)
                else try { Rappels.synchroniser(ctx) } catch (_: Exception) {}
            }
            Rappels.FAIT -> {
                val id = intent.getStringExtra("id") ?: return
                val itemId = intent.getStringExtra("item_id") ?: return
                Rappels.retirer(ctx, id)
                try {
                    Supabase.changerEtat(ctx, itemId, intent.getStringExtra("etat") ?: "a_faire", "fait")
                    WidgetTaches.actualiser(ctx)
                    Rappels.synchroniser(ctx)
                } catch (_: Exception) {
                    Rappels.notifier(ctx, intent.putExtra("texte", "Pas pu marquer comme fait (connexion ?). Réessaie."))
                }
            }
            Rappels.REPORTER -> {
                val id = intent.getStringExtra("id") ?: return
                Rappels.retirer(ctx, id)
                val quand = Instant.now().plusSeconds(3600)
                try {
                    Supabase.reporterRappel(ctx, id, quand)
                    Rappels.synchroniser(ctx)
                } catch (_: Exception) {
                    // Hors ligne : on reprogramme quand même sur le téléphone.
                    val am = ctx.getSystemService(AlarmManager::class.java)
                    val i = Intent(intent).setAction(Rappels.ALARME).setData(Uri.parse("rappel:$id"))
                        .putExtra("quand", quand.toString())
                    val pi = PendingIntent.getBroadcast(ctx, 0, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                    am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, quand.toEpochMilli(), pi)
                }
            }
        }
    }
}

/** Synchronisation des rappels en tâche de fond (toutes les 15 minutes). */
class ServiceSynchroRappels : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        thread {
            var reessayer = false
            try { Rappels.synchroniser(applicationContext) } catch (e: java.io.IOException) { reessayer = e !is Supabase.ErreurApi } catch (_: Exception) {}
            jobFinished(params, reessayer)
        }
        return true
    }

    override fun onStopJob(params: JobParameters) = true
}
