package io.github.jep317.taches

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

// Accès direct à Supabase (API REST), sans bibliothèque : connexion, lecture de la liste, ajout, changement d'état.
// L'appli ne fait qu'ajouter des éléments « à trier » et cocher ce qui est fait ; c'est Claude qui range.
object Supabase {
    // Mêmes valeurs que config.js de l'appli web. La clé est la clé publique, faite pour être dans une appli.
    const val URL_PROJET = "https://rxkcnajehfzckwfuxdqp.supabase.co"
    const val CLE = "sb_publishable_skk6r88Nu-5Ra0uSBqFi2Q_VllTV0nV"
    const val APPLI_WEB = "https://jep317.github.io/tacheGestion/"

    class ErreurApi(val code: Int, message: String) : IOException(message)

    class Item(
        val id: String,
        val texteBrut: String,
        val titre: String?,
        val details: String?,
        val type: String,
        val categorie: String?,
        val horizon: String?,
        val etat: String,
        val theme: String?,
        val projet: String?,
        val echeance: String?,
        val echeanceHeure: String? = null,
        val recurrent: Boolean = false,
    ) {
        val libelle: String get() = titre?.takeIf { it.isNotBlank() } ?: texteBrut
    }

    private const val PREFS = "session"
    private val verrou = Any()

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun estConnecte(ctx: Context) = prefs(ctx).getString("refresh", null) != null
    fun email(ctx: Context): String? = prefs(ctx).getString("email", null)

    // ---------- HTTP ----------
    private fun requete(methode: String, chemin: String, corps: String?, jeton: String?, prefer: String? = null): String {
        val c = URL(URL_PROJET + chemin).openConnection() as HttpURLConnection
        try {
            c.requestMethod = methode
            c.connectTimeout = 15000
            c.readTimeout = 20000
            c.setRequestProperty("apikey", CLE)
            // En-tête en ASCII seulement (un accent ici faisait échouer la connexion du panneau Windows).
            c.setRequestProperty("User-Agent", "Taches-Android/1.0")
            c.setRequestProperty("Accept", "application/json")
            if (jeton != null) c.setRequestProperty("Authorization", "Bearer $jeton")
            if (prefer != null) c.setRequestProperty("Prefer", prefer)
            if (corps != null) {
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                c.outputStream.use { it.write(corps.toByteArray(Charsets.UTF_8)) }
            }
            val code = c.responseCode
            val flux = if (code in 200..299) c.inputStream else c.errorStream
            val texte = flux?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
            if (code !in 200..299) throw ErreurApi(code, messageErreur(texte, code))
            return texte
        } finally {
            c.disconnect()
        }
    }

    private fun messageErreur(texte: String, code: Int): String = try {
        val o = JSONObject(texte)
        o.optString("error_description").ifBlank { o.optString("msg") }.ifBlank { o.optString("message") }
            .ifBlank { "Erreur $code" }
    } catch (e: Exception) {
        "Erreur $code"
    }

    // ---------- connexion ----------
    /** Renvoie null si tout va bien, sinon un message à afficher. */
    fun connecter(ctx: Context, email: String, motDePasse: String): String? = try {
        val corps = JSONObject().put("email", email).put("password", motDePasse).toString()
        val rep = JSONObject(requete("POST", "/auth/v1/token?grant_type=password", corps, null))
        synchronized(verrou) { enregistrer(ctx, rep) }
        null
    } catch (e: ErreurApi) {
        val m = e.message ?: ""
        when {
            m.contains("invalid login", true) -> "E-mail ou mot de passe incorrect."
            m.contains("not confirmed", true) -> "Confirme d'abord ton adresse avec le lien reçu par e-mail."
            else -> "Erreur : $m"
        }
    } catch (e: IOException) {
        "Pas de connexion internet ?"
    }

    fun deconnecter(ctx: Context) {
        val jeton = prefs(ctx).getString("acces", null)
        if (jeton != null) try { requete("POST", "/auth/v1/logout", null, jeton) } catch (_: Exception) {}
        prefs(ctx).edit().clear().apply()
        Cache.vider(ctx)
    }

    private fun enregistrer(ctx: Context, rep: JSONObject) {
        val expireLe = if (rep.has("expires_at")) rep.getLong("expires_at") * 1000
        else System.currentTimeMillis() + rep.optLong("expires_in", 3600) * 1000
        val email = rep.optJSONObject("user")?.optString("email")
        val e = prefs(ctx).edit()
            .putString("acces", rep.getString("access_token"))
            .putString("refresh", rep.getString("refresh_token"))
            .putLong("expire", expireLe)
        if (!email.isNullOrBlank()) e.putString("email", email)
        e.commit()
    }

    /** Jeton d'accès valide, renouvelé si besoin. Lève une erreur si la session n'existe plus. */
    private fun jeton(ctx: Context): String = synchronized(verrou) {
        val p = prefs(ctx)
        val refresh = p.getString("refresh", null) ?: throw ErreurApi(401, "Pas connecté")
        val acces = p.getString("acces", null)
        if (acces != null && p.getLong("expire", 0) - 60_000 > System.currentTimeMillis()) return acces
        try {
            val corps = JSONObject().put("refresh_token", refresh).toString()
            val rep = JSONObject(requete("POST", "/auth/v1/token?grant_type=refresh_token", corps, null))
            enregistrer(ctx, rep)
            rep.getString("access_token")
        } catch (e: ErreurApi) {
            // Session révoquée ou expirée : il faudra se reconnecter dans l'appli.
            if (e.code in 400..499) p.edit().remove("refresh").remove("acces").commit()
            throw e
        }
    }

    // ---------- données ----------
    fun lireListe(ctx: Context): List<Item> {
        val chemin = "/rest/v1/items?select=id,texte_brut,titre,details,type,categorie:categories(nom),horizon,etat,theme,projet,echeance,echeance_heure,recurrence" +
            "&etat=in.(a_trier,a_faire,en_cours)&order=ordre.asc.nullslast,cree_le.asc"
        val texte = requete("GET", chemin, null, jeton(ctx))
        Cache.ecrire(ctx, texte)
        return analyser(texte)
    }

    fun analyser(texte: String): List<Item> {
        val t = JSONArray(texte)
        fun JSONObject.chaine(c: String): String? = if (isNull(c)) null else optString(c).ifBlank { null }
        return (0 until t.length()).map { n ->
            val o = t.getJSONObject(n)
            Item(
                id = o.getString("id"),
                texteBrut = o.optString("texte_brut"),
                titre = o.chaine("titre"),
                details = o.chaine("details"),
                type = o.optString("type", "tache"),
                categorie = o.optJSONObject("categorie")?.chaine("nom"),
                horizon = o.chaine("horizon"),
                etat = o.optString("etat", "a_trier"),
                theme = o.chaine("theme"),
                projet = o.chaine("projet"),
                echeance = o.chaine("echeance"),
                echeanceHeure = o.chaine("echeance_heure"),
                recurrent = o.has("recurrence") && !o.isNull("recurrence"),
            )
        }
    }

    fun ajouter(ctx: Context, texte: String, source: String) {
        val j = jeton(ctx)
        val corps = JSONObject().put("texte_brut", texte).put("source", source).toString()
        val rep = JSONArray(requete("POST", "/rest/v1/items?select=id", corps, j, "return=representation"))
        if (rep.length() == 0) throw ErreurApi(403, "Ajout refusé (compte non autorisé ?)")
        val id = rep.getJSONObject(0).getString("id")
        journal(j, id, "cree", null, JSONObject().put("texte_brut", texte).put("source", source))
    }

    fun changerEtat(ctx: Context, id: String, ancienEtat: String, nouvelEtat: String) {
        val j = jeton(ctx)
        val maj = JSONObject().put("etat", nouvelEtat)
            .put("fait_le", if (nouvelEtat == "fait") java.time.Instant.now().toString() else JSONObject.NULL)
        val rep = JSONArray(
            requete("PATCH", "/rest/v1/items?id=eq.${URLEncoder.encode(id, "UTF-8")}&select=id", maj.toString(), j, "return=representation")
        )
        if (rep.length() == 0) throw ErreurApi(404, "Élément introuvable")
        journal(j, id, if (nouvelEtat == "fait") "termine" else "modifie", JSONObject().put("etat", ancienEtat), maj)
    }

    // ---------- rappels (voir Rappels.kt) ----------
    /** Rappels à venir (et ceux de la dernière heure), avec l'élément lié s'il y en a un. */
    fun lireRappels(ctx: Context): String {
        val depuis = URLEncoder.encode(java.time.Instant.now().minusSeconds(3600).toString(), "UTF-8")
        return requete(
            "GET",
            "/rest/v1/rappels?select=id,item_id,titre,texte,quand,item:items(titre,texte_brut,etat,echeance,echeance_heure)" +
                "&quand=gte.$depuis&order=quand.asc&limit=200",
            null, jeton(ctx),
        )
    }

    /** Un rappel et l'état de son élément, juste avant de notifier (null si le rappel n'existe plus). */
    fun lireRappel(ctx: Context, id: String): JSONObject? {
        val t = JSONArray(
            requete(
                "GET",
                "/rest/v1/rappels?select=id,quand,item:items(etat)&id=eq.${URLEncoder.encode(id, "UTF-8")}",
                null, jeton(ctx),
            )
        )
        return if (t.length() == 0) null else t.getJSONObject(0)
    }

    fun ajouterRappel(ctx: Context, itemId: String, quand: java.time.Instant) {
        val j = jeton(ctx)
        val corps = JSONObject().put("item_id", itemId).put("quand", quand.toString())
        requete("POST", "/rest/v1/rappels", corps.toString(), j, "return=minimal")
        journal(j, itemId, "rappel", null, corps)
    }

    fun reporterRappel(ctx: Context, id: String, quand: java.time.Instant) {
        val corps = JSONObject().put("quand", quand.toString()).put("relatif_min", JSONObject.NULL)
        requete("PATCH", "/rest/v1/rappels?id=eq.${URLEncoder.encode(id, "UTF-8")}", corps.toString(), jeton(ctx), "return=minimal")
    }

    private fun journal(jeton: String, id: String, action: String, avant: JSONObject?, apres: JSONObject) {
        val corps = JSONObject().put("item_id", id).put("action", action).put("par", "appli").put("apres", apres)
        if (avant != null) corps.put("avant", avant)
        try { requete("POST", "/rest/v1/journal", corps.toString(), jeton, "return=minimal") } catch (_: Exception) {}
    }
}

/** Dernière liste reçue, pour que le widget affiche quelque chose même hors ligne. */
object Cache {
    private fun p(ctx: Context) = ctx.getSharedPreferences("cache", Context.MODE_PRIVATE)
    fun ecrire(ctx: Context, json: String) =
        p(ctx).edit().putString("liste", json).putLong("le", System.currentTimeMillis()).apply()
    fun lire(ctx: Context): String? = p(ctx).getString("liste", null)
    fun date(ctx: Context): Long = p(ctx).getLong("le", 0)
    fun vider(ctx: Context) = p(ctx).edit().clear().apply()
}
