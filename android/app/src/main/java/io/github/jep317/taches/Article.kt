package io.github.jep317.taches

import android.text.Html
import android.text.Spanned

/**
 * Notes mises en forme : le texte est rangé en Markdown simple (titres « ## », citations « > », listes « - »,
 * **gras**, *italique*, [liens](https://…)), comme dans l'appli PC. Ici on l'affiche joliment.
 */
object Article {
    private val TITRE = Regex("""^(#{1,3})\s+(.*)$""")
    private val CITATION = Regex("""^>\s?(.*)$""")
    private val PUCE = Regex("""^\s*[-*•]\s+(.*)$""")
    private val NUMERO = Regex("""^\s*\d+[.)]\s+(.*)$""")
    private val TRAIT = Regex("""^(-{3,}|\*{3,})$""")

    private fun echap(t: String) = t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")

    private fun enLigne(t: String): String = echap(t)
        .replace(Regex("""\[([^\]\n]+)\]\((https?://[^)\s]+)\)"""), "<a href=\"$2\">$1</a>")
        .replace(Regex("""\*\*([^*\n]+?)\*\*"""), "<b>$1</b>")
        .replace(Regex("""(^|[^*\w])\*([^*\n]+?)\*(?!\w)"""), "$1<i>$2</i>")
        .replace(Regex("""(^|[^_\w])_([^_\n]+?)_(?!\w)"""), "$1<i>$2</i>")
        .replace(Regex("""~~([^~\n]+?)~~"""), "<s>$1</s>")

    /** Markdown simple -> HTML compris par Android (Html.fromHtml). */
    fun html(md: String): String {
        val out = StringBuilder()
        val para = mutableListOf<String>()
        var typeListe: String? = null
        val liste = mutableListOf<String>()
        val citation = mutableListOf<String>()
        fun fermerPara() {
            if (para.isNotEmpty()) { out.append("<p>").append(para.joinToString("<br>") { enLigne(it) }).append("</p>"); para.clear() }
        }
        fun fermerListe() {
            if (typeListe != null) {
                out.append("<$typeListe>"); liste.forEach { out.append("<li>").append(enLigne(it)).append("</li>") }; out.append("</$typeListe>")
            }
            typeListe = null; liste.clear()
        }
        fun fermerCitation() {
            if (citation.isNotEmpty()) { out.append("<blockquote>").append(citation.joinToString("<br>") { enLigne(it) }).append("</blockquote>"); citation.clear() }
        }
        fun fermer() { fermerPara(); fermerListe(); fermerCitation() }

        for (brute in md.replace("\r\n", "\n").split("\n")) {
            val l = brute.trimEnd()
            if (l.isBlank()) { fermer(); continue }
            val titre = TITRE.find(l)
            val cit = CITATION.find(l)
            val puce = PUCE.find(l)
            val num = NUMERO.find(l)
            when {
                titre != null -> {
                    fermer()
                    val n = if (titre.groupValues[1].length == 3) "h4" else "h3"
                    out.append("<$n>").append(enLigne(titre.groupValues[2])).append("</$n>")
                }
                TRAIT.matches(l.trim()) -> { fermer(); out.append("<p>· · ·</p>") }
                cit != null -> { fermerPara(); fermerListe(); citation += cit.groupValues[1] }
                puce != null -> {
                    if (typeListe != "ul") { fermer(); typeListe = "ul" }
                    liste += puce.groupValues[1]
                }
                num != null -> {
                    if (typeListe != "ol") { fermer(); typeListe = "ol" }
                    liste += num.groupValues[1]
                }
                else -> { fermerListe(); fermerCitation(); para += l }
            }
        }
        fermer()
        return out.toString()
    }

    fun mettreEnForme(md: String): CharSequence {
        val s: Spanned = Html.fromHtml(html(md), Html.FROM_HTML_MODE_COMPACT)
        // Html.fromHtml laisse des sauts de ligne en trop à la fin.
        var fin = s.length
        while (fin > 0 && s[fin - 1] == '\n') fin--
        return s.subSequence(0, fin)
    }

    /** Le texte sans les marques (aperçu dans le widget). */
    fun texteSimple(md: String?): String = (md ?: "")
        .replace(Regex("""(?m)^\s{0,3}(#{1,3}|>|[-*•]|\d+[.)])\s+"""), "")
        .replace(Regex("""(?m)^(-{3,}|\*{3,})$"""), "")
        .replace(Regex("""\[([^\]]+)\]\([^)]+\)"""), "$1")
        .replace("**", "").replace("~~", "")
        .replace(Regex("""(^|\W)[*_]([^*_\n]+)[*_](?=\W|$)"""), "$1$2")
        .replace(Regex("""\s+"""), " ")
        .trim()

    fun tempsDeLecture(md: String?): Int {
        val mots = texteSimple(md).split(' ').count { it.isNotEmpty() }
        return maxOf(1, Math.round(mots / 220f))
    }
}
