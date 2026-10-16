package com.jarvis.wearjarvis

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.wear.compose.material3.MaterialTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContent {
            WearJarvisTheme {
                WearJarvisScreen(modifier = Modifier.fillMaxSize())
            }
        }
    }
}

@Composable
fun WearJarvisTheme(content: @Composable () -> Unit) {
    MaterialTheme(content = content)
}
