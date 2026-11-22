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
        val chemin = "/rest/v1/items?select=id,texte_brut,titre,details,type,categorie:categories(nom),horizon,etat,theme,projet,echeance,echeance_heure,recurrence,parent_id,priorite_jour,priorite_rang" +
            "&etat=in.(a_trier,a_faire,en_cours)&special=is.null&order=ordre.asc.nullslast,cree_le.asc"
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
        // Liste de courses : nombre d'articles restant à acheter, pour la ligne « 🛒 Courses » du widget.
        try {
            val c = JSONArray(requete("GET", "/rest/v1/items?select=id&special=eq.courses", null, j))
            if (c.length() > 0) {
                val idCourses = c.getJSONObject(0).getString("id")
                Cache.ecrireCourses(ctx, (lignesTotal[idCourses] ?: 0) - (cochees[idCourses] ?: 0))
            }
        } catch (_: Exception) {}
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
                echeanceHeure = o.chaine("echeance_heure"),
                recurrent = o.has("recurrence") && !o.isNull("recurrence"),
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

    fun changerEtat(ctx: Context, id: String, ancienEtat: String, nouvelEtat: String, action: String? = null, par: String = "appli") {
        val j = jeton(ctx)
        val maj = JSONObject().put("etat", nouvelEtat)
            .put("fait_le", if (nouvelEtat == "fait") java.time.Instant.now().toString() else JSONObject.NULL)
        val rep = JSONArray(
            requete("PATCH", "/rest/v1/items?id=eq.${URLEncoder.encode(id, "UTF-8")}&select=id", maj.toString(), j, "return=representation")
        )
        if (rep.length() == 0) throw ErreurApi(404, "Élément introuvable")
        journal(j, id, action ?: if (nouvelEtat == "fait") "termine" else "modifie", JSONObject().put("etat", ancienEtat), maj, par)
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

    // ---------- liste de courses (tâche spéciale ; ses articles sont les lignes de sa checklist) ----------
    class Article(val id: String, val texte: String, var coche: Boolean, val ordre: Int = 0)

    /** Identifiant de la tâche « 🛒 Courses ». */
    fun idCourses(ctx: Context): String {
        val rep = JSONArray(requete("GET", "/rest/v1/items?select=id&special=eq.courses", null, jeton(ctx)))
        if (rep.length() == 0) throw ErreurApi(404, "Liste de courses introuvable")
        return rep.getJSONObject(0).getString("id")
    }

    fun lireArticles(ctx: Context, idCourses: String): List<Article> {
        val rep = JSONArray(requete("GET", "/rest/v1/checklist?select=id,texte,coche,ordre&item_id=eq.$idCourses&order=ordre.asc,cree_le.asc", null, jeton(ctx)))
        return (0 until rep.length()).map { rep.getJSONObject(it).let { o -> Article(o.getString("id"), o.optString("texte"), o.optBoolean("coche"), o.optInt("ordre")) } }
    }

    /** Articles déjà achetés, les plus fréquents d'abord (suggestions). */
    fun lireHistorique(ctx: Context): List<String> {
        val rep = JSONArray(requete("GET", "/rest/v1/articles_courses?select=nom&order=fois.desc,dernier.desc&limit=300", null, jeton(ctx)))
        return (0 until rep.length()).map { rep.getJSONObject(it).optString("nom") }.filter { it.isNotBlank() }
    }

    fun ajouterArticles(ctx: Context, idCourses: String, textes: List<String>, ordreDepart: Int) {
        val corps = JSONArray()
        textes.forEachIndexed { n, t -> corps.put(JSONObject().put("item_id", idCourses).put("texte", t).put("ordre", ordreDepart + n)) }
        requete("POST", "/rest/v1/checklist", corps.toString(), jeton(ctx), "return=minimal")
    }

    fun cocherArticle(ctx: Context, id: String, coche: Boolean) {
        requete("PATCH", "/rest/v1/checklist?id=eq.$id", JSONObject().put("coche", coche).toString(), jeton(ctx), "return=minimal")
    }

    /** Efface un article acheté (seulement s'il est toujours coché). */
    fun effacerArticle(ctx: Context, id: String) {
        requete("DELETE", "/rest/v1/checklist?id=eq.$id&coche=is.true", null, jeton(ctx), "return=minimal")
    }

    // ---------- priorités (déplacement par Jérémie, comme le glisser-déposer de l'appli web) ----------
    class Place(val horizon: String, val rang: Int, val total: Int)

    private fun voisins(j: String, horizon: String): List<Pair<String, Int?>> {
        val t = JSONArray(requete(
            "GET",
            "/rest/v1/items?select=id,ordre&horizon=eq.$horizon&etat=in.(a_faire,en_cours)&type=in.(tache,course)" +
                "&order=ordre.asc.nullslast,cree_le.asc",
            null, j,
        ))
        return (0 until t.length()).map { n ->
            val o = t.getJSONObject(n)
            o.getString("id") to (if (o.isNull("ordre")) null else o.getInt("ordre"))
        }
    }

    /** Place actuelle de la tâche dans son horizon (null si elle n'est pas encore rangée). */
    fun place(ctx: Context, id: String): Place? {
        val j = jeton(ctx)
        val moi = JSONArray(requete("GET", "/rest/v1/items?select=horizon,etat&id=eq.${URLEncoder.encode(id, "UTF-8")}", null, j))
        if (moi.length() == 0) throw ErreurApi(404, "Élément introuvable")
        val o = moi.getJSONObject(0)
        if (o.isNull("horizon") || o.optString("etat") == "a_trier") return null
        val h = o.getString("horizon")
        val v = voisins(j, h)
        val k = v.indexOfFirst { it.first == id }
        return Place(h, if (k < 0) v.size + 1 else k + 1, if (k < 0) v.size + 1 else v.size)
    }

    /**
     * Range la tâche dans [horizon] : [cible] = 0 en tête, -1 en dernier, sinon un décalage (-1 = monter d'un cran,
     * +1 = descendre) quand l'horizon ne change pas. Renumérote l'ordre de l'horizon (1 = en tête) et l'inscrit
     * au journal (« deplace », par jeremie) pour que le tri de Claude le respecte.
     */
    fun deplacer(ctx: Context, id: String, horizon: String, mode: String): Place {
        val j = jeton(ctx)
        val moi = JSONArray(requete("GET", "/rest/v1/items?select=horizon,ordre,etat&id=eq.${URLEncoder.encode(id, "UTF-8")}", null, j))
        if (moi.length() == 0) throw ErreurApi(404, "Élément introuvable")
        val o = moi.getJSONObject(0)
        val ancienH: String? = if (o.isNull("horizon")) null else o.getString("horizon")
        val ancienOrdre: Any = if (o.isNull("ordre")) JSONObject.NULL else o.getInt("ordre")
        val aTrier = o.optString("etat") == "a_trier"

        val liste = voisins(j, horizon).toMutableList()
        val avant = liste.indexOfFirst { it.first == id }
        val sansMoi = liste.filter { it.first != id }.toMutableList()
        var pos = when (mode) {
            "tete" -> 0
            "monter" -> if (avant < 0) sansMoi.size else (avant - 1).coerceAtLeast(0)
            "descendre" -> if (avant < 0) sansMoi.size else (avant + 1).coerceAtMost(sansMoi.size)
            else -> sansMoi.size // « fin » : dernier de l'horizon choisi
        }
        if (pos > sansMoi.size) pos = sansMoi.size
        sansMoi.add(pos, id to null)

        sansMoi.forEachIndexed { k, (autre, ordre) ->
            val champs = JSONObject()
            if (autre == id) {
                champs.put("ordre", k + 1)
                if (ancienH != horizon) champs.put("horizon", horizon)
                if (aTrier) champs.put("etat", "a_faire")
            } else if (ordre != k + 1) {
                champs.put("ordre", k + 1)
            }
            if (champs.length() > 0) {
                requete("PATCH", "/rest/v1/items?id=eq.${URLEncoder.encode(autre, "UTF-8")}", champs.toString(), j, "return=minimal")
            }
        }
        val avantJ = JSONObject().put("horizon", ancienH ?: JSONObject.NULL).put("ordre", ancienOrdre)
        if (aTrier) avantJ.put("etat", "a_trier")
        journal(j, id, "deplace", avantJ, JSONObject().put("horizon", horizon).put("ordre", pos + 1), par = "jeremie")
        return Place(horizon, pos + 1, sansMoi.size)
    }

    private fun journal(jeton: String, id: String, action: String, avant: JSONObject?, apres: JSONObject, par: String = "appli") {
        val corps = JSONObject().put("item_id", id).put("action", action).put("par", par).put("apres", apres)
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
    fun ecrireCourses(ctx: Context, n: Int) = p(ctx).edit().putInt("courses", n).apply()
    fun courses(ctx: Context): Int = p(ctx).getInt("courses", -1)
    fun vider(ctx: Context) = p(ctx).edit().clear().apply()
}
