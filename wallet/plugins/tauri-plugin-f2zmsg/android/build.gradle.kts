plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "cash.free2z.f2zmsg"
    compileSdk = 36

    defaultConfig {
        minSdk = 29
        consumerProguardFiles("consumer-rules.pro")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    // Deliberately NOT androidx.biometric, which tauri-plugin-zcash does need:
    // this plugin's key is used from background delivery and must never
    // prompt. See F2zMsgPlugin.kt.
    implementation("com.fasterxml.jackson.core:jackson-databind:2.17.2")
    implementation(project(":tauri-android"))
    testImplementation("junit:junit:4.13.2")
}
