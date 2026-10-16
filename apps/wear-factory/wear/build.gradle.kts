import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.jarvis.wearfactory"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.jarvis.wearfactory"
        minSdk = 30
        targetSdk = 35
        versionCode = 6
        versionName = "1.4.1"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        val localProps = Properties()
        rootProject.file("local.properties").takeIf { it.exists() }?.reader()?.use {
            localProps.load(it)
        }
        fun prop(key: String): String {
            var value = localProps.getProperty(key)?.trim().orEmpty()
            if (value.isEmpty()) {
                value = (project.findProperty(key) as String?)?.trim().orEmpty()
            }
            return value
        }
        val googleWebClientId = prop("WEAR_GOOGLE_WEB_CLIENT_ID")
        val escapedGoogleClientId =
            googleWebClientId.replace("\\", "\\\\").replace("\"", "\\\"")
        buildConfigField(
            "String",
            "WEAR_GOOGLE_SIGN_IN_CLIENT_ID",
            "\"$escapedGoogleClientId\"",
        )
        var apiBaseUrl =
            localProps.getProperty("WEAR_API_BASE_URL")?.trim().orEmpty()
        if (apiBaseUrl.isEmpty()) {
            apiBaseUrl =
                (project.findProperty("WEAR_API_BASE_URL") as String?)?.trim().orEmpty()
        }
        // Same reserved Jetson ngrok host as the Expo mobile app (works off LAN).
        if (apiBaseUrl.isEmpty()) {
            apiBaseUrl = "https://jarvis-api.example.com"
        }
        val escapedApiBaseUrl = apiBaseUrl.replace("\\", "\\\\").replace("\"", "\\\"")
        buildConfigField("String", "WEAR_API_BASE_URL", "\"$escapedApiBaseUrl\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    implementation(platform("androidx.compose:compose-bom:2024.12.01"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    debugImplementation("androidx.compose.ui:ui-tooling")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")

    implementation("androidx.wear.compose:compose-material3:1.5.0")
    implementation("androidx.wear.compose:compose-foundation:1.5.0")

    implementation("androidx.datastore:datastore-preferences:1.1.1")
    implementation("androidx.security:security-crypto:1.0.0")
    implementation("com.google.android.gms:play-services-auth:21.3.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jsoup:jsoup:1.18.3")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.9.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")

    androidTestImplementation(platform("androidx.compose:compose-bom:2024.12.01"))
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    // Espresso 3.6 injects input via a reflection call removed in newer Android; 3.7 fixes it.
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}
