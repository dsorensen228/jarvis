package com.jarvis.wearjarvis.speech

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer

class SpeechRecognizerHelper(
    private val context: Context,
    private val onPartial: (String) -> Unit,
    private val onFinal: (String) -> Unit,
    private val onError: (Int) -> Unit,
) {
    private var recognizer: SpeechRecognizer? = null

    fun start() {
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            onError(SpeechRecognizer.ERROR_CLIENT)
            return
        }
        destroy()
        val speech =
            SpeechRecognizer.createSpeechRecognizer(context).apply {
                setRecognitionListener(
                    object : RecognitionListener {
                        override fun onReadyForSpeech(params: Bundle?) {}

                        override fun onBeginningOfSpeech() {}

                        override fun onRmsChanged(rmsdB: Float) {}

                        override fun onBufferReceived(buffer: ByteArray?) {}

                        override fun onEndOfSpeech() {}

                        override fun onError(error: Int) {
                            this@SpeechRecognizerHelper.onError(error)
                        }

                        override fun onResults(results: Bundle?) {
                            val list = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                            val text = list?.firstOrNull()?.trim().orEmpty()
                            if (text.isNotEmpty()) {
                                onFinal(text)
                            } else {
                                this@SpeechRecognizerHelper.onError(SpeechRecognizer.ERROR_NO_MATCH)
                            }
                            this@SpeechRecognizerHelper.destroy()
                        }

                        override fun onPartialResults(partialResults: Bundle?) {
                            val list =
                                partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                            val text = list?.firstOrNull()?.trim().orEmpty()
                            if (text.isNotEmpty()) {
                                onPartial(text)
                            }
                        }

                        override fun onEvent(eventType: Int, params: Bundle?) {}
                    },
                )
            }
        recognizer = speech

        val intent =
            Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(
                    RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                    RecognizerIntent.LANGUAGE_MODEL_FREE_FORM,
                )
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            }
        speech.startListening(intent)
    }

    fun stop() {
        try {
            recognizer?.stopListening()
        } catch (_: Exception) {
            // ignore
        }
    }

    fun destroy() {
        try {
            recognizer?.destroy()
        } catch (_: Exception) {
            // ignore
        }
        recognizer = null
    }
}
