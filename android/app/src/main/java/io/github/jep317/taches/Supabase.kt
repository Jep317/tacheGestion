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
        val parent: String? = null,      // titre de la tâche parente (sous-tâche ou note attachée)
        val sousFaites: Int = 0,         // sous-tâches faites / total : « 2/5 »
        val sousTotal: Int = 0,
        val checkCochees: Int = 0,       // lignes de checklist cochées / total : « ☑ 2/4 »
        val checkTotal: Int = 0,
        val prioriteJour: String? = null,   // date (AAAA-MM-JJ) où Claude l'a choisie parmi les priorités du jour
        val prioriteRang: Int = 0,
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
        val j = jeton(ctx)
        val chemin = "/rest/v1/items?select=id,texte_brut,titre,details,type,categorie:categories(nom),horizon,etat,theme,projet,echeance,parent_id,priorite_jour,priorite_rang" +
            "&etat=in.(a_trier,a_faire,en_cours)&order=ordre.asc.nullslast,cree_le.asc"
        val liste = JSONArray(requete("GET", chemin, null, j))
        // Sous-tâches (faites comprises) et checklists, pour afficher « 2/5 » et « ☑ 2/4 ».
        val liens = JSONArray(requete("GET", "/rest/v1/items?select=id,parent_id,etat,type,titre,texte_brut&parent_id=not.is.null", null, j))
        val lignes = JSONArray(requete("GET", "/rest/v1/checklist?select=item_id,coche", null, j))
        val faites = HashMap<String, Int>(); val total = HashMap<String, Int>()
        for (n in 0 until liens.length()) {
            val o = liens.getJSONObject(n)
            if (o.optString("type") !in setOf("tache", "course") || o.optString("etat") == "abandonne") continue
            val p = o.getString("parent_id")
            total[p] = (total[p] ?: 0) + 1
            if (o.optString("etat") == "fait") faites[p] = (faites[p] ?: 0) + 1
        }
        val cochees = HashMap<String, Int>(); val lignesTotal = HashMap<String, Int>()
        for (n in 0 until lignes.length()) {
            val o = lignes.getJSONObject(n)
            val id = o.getString("item_id")
            lignesTotal[id] = (lignesTotal[id] ?: 0) + 1
            if (o.optBoolean("coche")) cochees[id] = (cochees[id] ?: 0) + 1
        }
        // Titre des parents : dans la liste, ou parmi les éléments déjà faits (requête courte si besoin).
        val titres = HashMap<String, String>()
        fun titreDe(o: JSONObject) = o.optString("titre").takeIf { !o.isNull("titre") && it.isNotBlank() } ?: o.optString("texte_brut")
        for (n in 0 until liste.length()) liste.getJSONObject(n).let { titres[it.getString("id")] = titreDe(it) }
        val manquants = (0 until liste.length()).mapNotNull { liste.getJSONObject(it).let { o -> if (o.isNull("parent_id")) null else o.getString("parent_id") } }
            .filter { it !in titres }.distinct()
        if (manquants.isNotEmpty()) {
            val p = JSONArray(requete("GET", "/rest/v1/items?select=id,titre,texte_brut&id=in.(${manquants.joinToString(",")})", null, j))
            for (n in 0 until p.length()) p.getJSONObject(n).let { titres[it.getString("id")] = titreDe(it) }
        }
        for (n in 0 until liste.length()) {
            val o = liste.getJSONObject(n)
            val id = o.getString("id")
            if (!o.isNull("parent_id")) titres[o.getString("parent_id")]?.let { o.put("_parent", it) }
            o.put("_sous_faites", faites[id] ?: 0).put("_sous_total", total[id] ?: 0)
            o.put("_check_cochees", cochees[id] ?: 0).put("_check_total", lignesTotal[id] ?: 0)
        }
        val texte = liste.toString()
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
                parent = o.chaine("_parent"),
                sousFaites = o.optInt("_sous_faites"),
                sousTotal = o.optInt("_sous_total"),
                checkCochees = o.optInt("_check_cochees"),
                checkTotal = o.optInt("_check_total"),
                prioriteJour = o.chaine("priorite_jour"),
                prioriteRang = o.optInt("priorite_rang", 0),
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
