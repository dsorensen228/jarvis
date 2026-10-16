package com.jarvis.wearfactory

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.requestFocusOnHierarchyActive
import androidx.wear.compose.foundation.rotary.RotaryScrollableDefaults
import androidx.wear.compose.foundation.rotary.rotaryScrollable
import androidx.wear.compose.material3.MaterialTheme
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.Text
import com.jarvis.wearfactory.task.ReportBlock
import com.jarvis.wearfactory.task.ReportBlockKind
import kotlinx.coroutines.launch

/** Native, unscaled reading surface: Wear OS does not provide a WebView implementation. */
@Composable
internal fun ResearchReportScreen(
    modifier: Modifier,
    blocks: List<ReportBlock>,
    loading: Boolean,
    error: String?,
    onRetry: () -> Unit,
    onBack: () -> Unit,
) {
    val readingState = rememberLazyListState()
    val contentsState = rememberLazyListState()
    val focusRequester = remember { FocusRequester() }
    val scope = rememberCoroutineScope()
    var sections by remember { mutableStateOf(false) }
    var largerText by remember { mutableStateOf(false) }
    val headings = remember(blocks) { blocks.withIndex().filter { it.value.kind == ReportBlockKind.HEADING } }
    val state = if (sections) contentsState else readingState
    ScreenScaffold(
        scrollState = state, modifier = modifier,
        contentPadding = PaddingValues(horizontal = 24.dp, vertical = 40.dp),
        // Keep the dense reading surface clear of the app scaffold's time overlay.
        timeText = {},
    ) { contentPadding ->
        LazyColumn(
            state = state,
            // A fixed reading width and generous end padding keep prose inside the round display.
            contentPadding = contentPadding,
            verticalArrangement = Arrangement.spacedBy(10.dp),
            modifier = Modifier.fillMaxSize().requestFocusOnHierarchyActive()
                .rotaryScrollable(RotaryScrollableDefaults.behavior(state), focusRequester),
        ) {
            item {
                Text(if (sections) "Sections" else "Report", style = MaterialTheme.typography.titleSmall,
                    textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
            }
            if (loading) {
                item { Text("Loading report…", style = MaterialTheme.typography.bodySmall) }
            } else if (error != null) {
                item { Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                item { TextAction("Retry report", onRetry) }
            } else if (sections) {
                itemsIndexed(headings) { _, heading ->
                    TextAction(heading.value.text, {
                        sections = false
                        scope.launch { readingState.scrollToItem(heading.index + 3) }
                    })
                }
                item { TextAction("Resume reading", { sections = false }) }
            } else {
                // These two fixed controls make section offsets stable for every report.
                item { TextAction("Sections", { sections = true }, headings.isNotEmpty()) }
                item { TextAction(if (largerText) "Compact text" else "Larger text", { largerText = !largerText }) }
                if (blocks.isEmpty()) {
                    item { Text("No readable report content", style = MaterialTheme.typography.bodySmall) }
                }
                itemsIndexed(blocks) { _, block ->
                    val isHeading = block.kind == ReportBlockKind.HEADING
                    Text(
                        text = block.text,
                        fontSize = (if (isHeading) 15 else if (largerText) 14 else 12).sp,
                        lineHeight = (if (isHeading) 20 else if (largerText) 20 else 17).sp,
                        fontWeight = if (isHeading) FontWeight.SemiBold else FontWeight.Normal,
                        fontFamily = if (block.kind == ReportBlockKind.CODE) FontFamily.Monospace else FontFamily.SansSerif,
                        color = if (isHeading) Color(0xFFD6A8FF) else Color(0xFFF2EEF5),
                        modifier = Modifier.fillMaxWidth().padding(vertical = if (isHeading) 4.dp else 0.dp)
                            .then(if (isHeading) Modifier.semantics { heading() } else Modifier),
                    )
                }
                item { TextAction("Back to top", { scope.launch { readingState.scrollToItem(0) } }) }
            }
            item { TextAction("Back to task", onBack) }
        }
    }
}
