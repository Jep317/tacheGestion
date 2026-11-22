package io.github.jep317.taches

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer

/**
 * Dictée longue, sans limite de durée : la reconnaissance vocale du téléphone (gratuite, celle de Google)
 * s'arrête d'elle-même à chaque pause ; on la relance aussitôt et on met bout à bout les phrases reconnues,
 * jusqu'à ce que Jérémie touche « Terminer ». Rien n'est enregistré ni envoyé ailleurs que vers la reconnaissance
 * vocale habituelle d'Android.
 */
class DicteeContinue(
    private val ctx: Context,
    /** Texte reconnu jusqu'ici (phrases terminées + phrase en cours), à chaque changement. */
    private val surTexte: (String) -> Unit,
    /** Appelé quand la dictée s'arrête pour de bon (fin demandée ou erreur), avec un message d'erreur éventuel. */
    private val surFin: (String?) -> Unit,
) {
    private companion object { const val SILENCE_MAX = 3 * 60 * 1000L }

    private val main = Handler(Looper.getMainLooper())
    private var reco: SpeechRecognizer? = null
    private val phrases = StringBuilder()
    private var enCours = ""
    var active = false
        private set
    private var echecsDeSuite = 0
    private var derniereParole = 0L

    fun demarrer(texteDeDepart: String) {
        if (active) return
        if (!SpeechRecognizer.isRecognitionAvailable(ctx)) { surFin("Dictée indisponible sur ce téléphone."); return }
        phrases.clear()
        phrases.append(texteDeDepart.trimEnd())
        enCours = ""
        echecsDeSuite = 0
        derniereParole = System.currentTimeMillis()
        active = true
        reco = SpeechRecognizer.createSpeechRecognizer(ctx).also { it.setRecognitionListener(ecouteur) }
        ecouter()
    }

    /** Fin demandée : on garde ce qui a été reconnu, y compris la phrase en cours. */
    fun terminer() {
        if (!active) return
        active = false
        main.removeCallbacksAndMessages(null)
        valider(enCours)
        liberer()
        surFin(null)
    }

    fun liberer() {
        active = false
        main.removeCallbacksAndMessages(null)
        reco?.let { try { it.cancel(); it.destroy() } catch (_: Exception) {} }
        reco = null
    }

    private fun ecouter() {
        val r = reco ?: return
        val i = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, "fr-FR")
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            .putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, ctx.packageName)
            // Demande de tolérer de longues pauses (certains téléphones en tiennent compte, sinon on relance).
            .putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 6000L)
            .putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 6000L)
            .putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 15000L)
        try { r.startListening(i) } catch (e: Exception) { arret("Dictée impossible : " + (e.message ?: "erreur")) }
    }

    private fun relancer(delai: Long = 150) {
        if (!active) return
        main.postDelayed({ if (active) ecouter() }, delai)
    }

    private fun valider(texte: String) {
        val t = texte.trim()
        if (t.isNotEmpty()) {
            if (phrases.isNotEmpty()) phrases.append(if (phrases.endsWith(".") || phrases.endsWith("?") || phrases.endsWith("!")) " " else ". ")
            phrases.append(t.replaceFirstChar { it.uppercase() })
        }
        enCours = ""
        surTexte(phrases.toString())
    }

    private fun arret(message: String?) {
        valider(enCours)
        liberer()
        surFin(message)
    }

    private fun premier(b: Bundle?) = b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()

    private val ecouteur = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onEvent(eventType: Int, params: Bundle?) {}

        override fun onPartialResults(partiels: Bundle?) {
            if (!active) return
            val t = premier(partiels)
            if (t.isBlank()) return
            enCours = t
            derniereParole = System.currentTimeMillis()
            val sep = if (phrases.isEmpty()) "" else " "
            surTexte(phrases.toString() + sep + t)
        }

        override fun onResults(resultats: Bundle?) {
            if (!active) return
            val t = premier(resultats)
            valider(t.ifBlank { enCours })
            if (t.isNotBlank()) derniereParole = System.currentTimeMillis()
            echecsDeSuite = 0
            relancer()
        }

        override fun onError(code: Int) {
            if (!active) return
            when (code) {
                // Silence ou rien compris : on garde la phrase en cours et on réécoute.
                // Au bout de 3 minutes sans un mot, on s'arrête (batterie) en gardant tout.
                SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> {
                    if (System.currentTimeMillis() - derniereParole > SILENCE_MAX) arret(null)
                    else { valider(enCours); relancer() }
                }
                SpeechRecognizer.ERROR_RECOGNIZER_BUSY, SpeechRecognizer.ERROR_CLIENT -> {
                    if (++echecsDeSuite > 8) arret("La dictée s'est arrêtée. Retouche le micro pour continuer.")
                    else { reco?.cancel(); relancer(400) }
                }
                SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT, SpeechRecognizer.ERROR_SERVER -> {
                    if (++echecsDeSuite > 3) arret("Pas de connexion pour la dictée. Ce qui a été dit est gardé.")
                    else relancer(1000)
                }
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> arret("Autorise le micro pour dicter.")
                else -> {
                    if (++echecsDeSuite > 3) arret("La dictée s'est arrêtée (erreur $code). Retouche le micro pour continuer.")
                    else relancer(500)
                }
            }
        }
    }
}
