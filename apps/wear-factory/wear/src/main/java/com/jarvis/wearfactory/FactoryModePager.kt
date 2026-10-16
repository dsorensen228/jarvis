package com.jarvis.wearfactory

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.movableContentOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.wear.compose.foundation.LocalScreenIsActive
import androidx.wear.compose.foundation.pager.HorizontalPager
import androidx.wear.compose.foundation.pager.rememberPagerState
import androidx.wear.compose.material3.AnimatedPage
import androidx.wear.compose.material3.AppScaffold
import androidx.wear.compose.material3.HorizontalPageIndicator
import androidx.wear.compose.material3.HorizontalPagerScaffold
import androidx.wear.compose.material3.PagerScaffoldDefaults
import com.jarvis.wearfactory.task.FactoryMode

/**
 * Retains each factory's screen and list state while switching between the two task lists.
 * Panels report whether they are at their list from a SideEffect or LaunchedEffect, and use
 * isActive to gate back handlers and background polling. Child screens own swipe-to-dismiss.
 */
@Composable
internal fun FactoryModePager(
    modifier: Modifier = Modifier,
    content: @Composable (mode: FactoryMode, isActive: Boolean, setAtRoot: (Boolean) -> Unit) -> Unit,
) {
    val modes = remember { listOf(FactoryMode.CODE, FactoryMode.RESEARCH) }
    val pagerState = rememberPagerState { modes.size }
    var atRoot by remember { mutableStateOf(List(modes.size) { true }) }
    val pagingEnabled = atRoot[pagerState.currentPage]
    val currentContent by rememberUpdatedState(content)
    val panels = remember {
        modes.map { mode ->
            movableContentOf<Boolean, (Boolean) -> Unit> { isActive, setAtRoot ->
                currentContent(mode, isActive, setAtRoot)
            }
        }
    }
    val reportRoot = remember {
        modes.indices.map { page ->
            { isAtRoot: Boolean ->
                if (atRoot[page] != isAtRoot) {
                    atRoot = atRoot.toMutableList().also { it[page] = isAtRoot }
                }
            }
        }
    }

    AppScaffold(modifier = modifier.fillMaxSize()) {
        HorizontalPagerScaffold(
            pagerState = pagerState,
            pageIndicator = if (pagingEnabled) {
                { HorizontalPageIndicator(pagerState) }
            } else {
                null
            },
        ) {
            // Wear 1.5 retains a disabled gesture flag until the next pointer event. Recreate
            // that gesture container when re-enabling it, while movable panels retain all
            // task/navigation state and the hoisted PagerState retains the selected mode.
            key(pagingEnabled) {
                HorizontalPager(
                    state = pagerState,
                    modifier = Modifier.fillMaxSize(),
                    // Both panels must keep their remembered task, filter, and navigation state.
                    beyondViewportPageCount = 1,
                    key = { modes[it].name },
                    userScrollEnabled = pagingEnabled,
                    flingBehavior = PagerScaffoldDefaults.snapWithSpringFlingBehavior(pagerState),
                    // Crown and bezel input belongs to the active list, never the mode switcher.
                    rotaryScrollableBehavior = null,
                ) { page ->
                    AnimatedPage(pageIndex = page, pagerState = pagerState) {
                        panels[page](LocalScreenIsActive.current, reportRoot[page])
                    }
                }
            }
        }
    }
}
