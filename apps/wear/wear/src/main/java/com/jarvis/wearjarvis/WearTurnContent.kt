package com.jarvis.wearjarvis

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.Text

private val JarvisAccentPurple = Color(0xFFBF5AF2)

@Composable
internal fun WearTurnContent(
    listening: Boolean,
    sending: Boolean,
    reply: String,
    onTap: () -> Unit,
    onSignOut: () -> Unit,
) {
    if (reply.isNotBlank()) {
        Text(
            reply,
            textAlign = TextAlign.Center,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.verticalScroll(rememberScrollState())
                .combinedClickable(onClick = onTap, onLongClick = onSignOut).padding(8.dp),
        )
        return
    }
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier.size(108.dp)
            .semantics {
                contentDescription = when {
                    listening -> "Listening"
                    sending -> "Thinking"
                    else -> "Jarvis — tap to speak, long press to sign out"
                }
            }
            .combinedClickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onTap,
                onLongClick = onSignOut,
            ),
    ) {
        Image(
            painter = painterResource(R.drawable.jarvis_avatar),
            contentDescription = null,
            contentScale = ContentScale.Crop,
            modifier = Modifier.size(96.dp).clip(CircleShape),
        )
        if (listening || sending) {
            val rotation = if (sending && !listening) {
                val transition = rememberInfiniteTransition(label = "thinking")
                val angle by transition.animateFloat(
                    initialValue = 0f,
                    targetValue = 360f,
                    animationSpec = infiniteRepeatable(tween(3200, easing = LinearEasing), RepeatMode.Restart),
                    label = "thinking orbit",
                )
                angle
            } else 0f
            Canvas(Modifier.fillMaxSize().padding(2.dp)) {
                val rim = Stroke(width = 4.dp.toPx())
                drawCircle(if (listening) JarvisAccentPurple else Color(0x59A67CDB), style = rim)
                if (sending && !listening) {
                    // Same two tapered purple arcs and 3.2-second orbit as the voice device.
                    val orbit = Brush.sweepGradient(
                        0f to Color.Transparent,
                        45f / 360f to Color(0xFFAE7CE8),
                        115f / 360f to Color(0xFFF0DBFF),
                        118f / 360f to Color.Transparent,
                        180f / 360f to Color.Transparent,
                        225f / 360f to Color(0xFFAE7CE8),
                        295f / 360f to Color(0xFFF0DBFF),
                        298f / 360f to Color.Transparent,
                        1f to Color.Transparent,
                    )
                    rotate(rotation) { drawCircle(orbit, style = rim) }
                }
            }
        }
    }
}
