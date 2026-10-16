package com.jarvis.wearfactory.speech

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import com.jarvis.wearfactory.task.TranscriptBuffer

class PushToTalkRecognizer(
    private val context: Context,
    private val onPartial: (String) -> Unit,
    private val onStopped: (String) -> Unit,
    private val onFailure: (String) -> Unit,
) {
    private var recognizer: SpeechRecognizer? = null
    private var committed = ""
    private var partial = ""
    private var armed = false
    private var stopping = false

    fun start() {
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            onFailure("Speech recognition is unavailable")
            return
        }
        committed = ""
        partial = ""
        armed = true
        stopping = false
        listen()
    }

    fun stop() {
        if (!armed) return
        stopping = true
        armed = false
        try {
            recognizer?.stopListening()
        } catch (_: Exception) {
            finishWithTranscript()
        }
    }

    fun destroy() {
        armed = false
        stopping = false
        try {
            recognizer?.destroy()
        } catch (_: Exception) {
            // ignore
        }
        recognizer = null
    }

    private fun listen() {
        destroyRecognizerOnly()
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
                            if (stopping) {
                                finishWithTranscript()
                                return
                            }
                            if (!armed) return
                            if (error == SpeechRecognizer.ERROR_NO_MATCH ||
                                error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT
                            ) {
                                listen()
                                return
                            }
                            armed = false
                            onFailure(speechErrorLabel(error))
                            destroy()
                        }

                        override fun onResults(results: Bundle?) {
                            val text =
                                results
                                    ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                                    ?.firstOrNull()
                                    ?.trim()
                                    .orEmpty()
                            if (text.isNotEmpty()) {
                                committed = TranscriptBuffer.merge(committed, text)
                                partial = ""
                                onPartial(committed)
                            }
                            if (stopping || !armed) {
                                finishWithTranscript()
                            } else {
                                listen()
                            }
                        }

                        override fun onPartialResults(partialResults: Bundle?) {
                            val text =
                                partialResults
                                    ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                                    ?.firstOrNull()
                                    ?.trim()
                                    .orEmpty()
                            if (text.isNotEmpty()) {
                                partial = text
                                onPartial(TranscriptBuffer.merge(committed, text))
                            }
                        }

                        override fun onEvent(eventType: Int, params: Bundle?) {}
                    },
                )
            }
        recognizer = speech
        speech.startListening(recognizeIntent())
    }

    private fun finishWithTranscript() {
        val text = TranscriptBuffer.merge(committed, partial).trim()
        destroy()
        if (text.isEmpty()) {
            onFailure("No speech was captured")
        } else {
            onStopped(text)
        }
    }

    private fun destroyRecognizerOnly() {
        try {
            recognizer?.destroy()
        } catch (_: Exception) {
            // ignore
        }
        recognizer = null
    }

    companion object {
        const val TIMEOUT_MS = 30_000L

        fun recognizeIntent(): Intent =
            Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(
                    RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                    RecognizerIntent.LANGUAGE_MODEL_FREE_FORM,
                )
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, TIMEOUT_MS)
                putExtra(
                    RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS,
                    TIMEOUT_MS,
                )
                putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, TIMEOUT_MS)
            }
    }
}

fun speechErrorLabel(code: Int): String =
    when (code) {
        SpeechRecognizer.ERROR_AUDIO -> "Audio recording error"
        SpeechRecognizer.ERROR_CLIENT -> "Speech service unavailable"
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Microphone permission denied"
        SpeechRecognizer.ERROR_NETWORK -> "Network error"
        SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Network timeout"
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Recognizer busy"
        SpeechRecognizer.ERROR_SERVER -> "Recognition server error"
        else -> "Speech error ($code)"
    }
