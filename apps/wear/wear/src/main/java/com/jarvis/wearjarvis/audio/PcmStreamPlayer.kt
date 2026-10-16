package com.jarvis.wearjarvis.audio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Minimal PCM streaming player for websocket-delivered audio chunks.
 */
class PcmStreamPlayer {
    private val running = AtomicBoolean(false)
    private val queue = LinkedBlockingQueue<ByteArray>()
    private var worker: Thread? = null
    private var audioTrack: AudioTrack? = null
    private var formatKey: String = ""

    fun startIfNeeded(sampleRate: Int, channels: Int, encoding: String): Boolean {
        if (encoding != "pcm_s16le") return false
        val nextKey = "$encoding:$sampleRate:$channels"
        if (running.get() && nextKey == formatKey) return true
        stop()
        return start(sampleRate, channels, encoding)
    }

    private fun start(sampleRate: Int, channels: Int, encoding: String): Boolean {
        if (encoding != "pcm_s16le") return false
        val channelConfig =
            if (channels == 2) {
                AudioFormat.CHANNEL_OUT_STEREO
            } else {
                AudioFormat.CHANNEL_OUT_MONO
            }
        val minBuffer =
            AudioTrack.getMinBufferSize(sampleRate, channelConfig, AudioFormat.ENCODING_PCM_16BIT)
        if (minBuffer <= 0) return false

        val track =
            AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .setLegacyStreamType(AudioManager.STREAM_MUSIC)
                        .build(),
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(sampleRate)
                        .setChannelMask(channelConfig)
                        .build(),
                )
                .setBufferSizeInBytes(minBuffer * 4)
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()

        audioTrack = track
        formatKey = "$encoding:$sampleRate:$channels"
        running.set(true)
        queue.clear()
        worker =
            Thread {
                try {
                    track.play()
                    while (running.get() || queue.isNotEmpty()) {
                        val chunk = queue.poll(250, TimeUnit.MILLISECONDS) ?: continue
                        var offset = 0
                        while (offset < chunk.size && running.get()) {
                            val wrote = track.write(chunk, offset, chunk.size - offset)
                            if (wrote <= 0) break
                            offset += wrote
                        }
                    }
                } catch (_: Exception) {
                    // Swallow playback thread errors; caller handles fallback.
                } finally {
                    try {
                        track.stop()
                    } catch (_: Exception) {
                    }
                    track.release()
                    if (audioTrack === track) {
                        audioTrack = null
                    }
                }
            }.apply {
                isDaemon = true
                start()
            }
        return true
    }

    fun enqueue(bytes: ByteArray) {
        if (!running.get() || bytes.isEmpty()) return
        queue.offer(bytes.copyOf())
    }

    fun stop() {
        running.set(false)
        queue.clear()
        worker?.interrupt()
        worker = null
        val track = audioTrack
        audioTrack = null
        if (track != null) {
            try {
                track.stop()
            } catch (_: Exception) {
            }
            track.release()
        }
    }
}
