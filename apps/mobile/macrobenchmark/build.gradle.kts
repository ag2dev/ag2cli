plugins {
    alias(libs.plugins.android.test)
}

android {
    namespace = "com.ag2dev.ag2cli.mobile.benchmark"
    compileSdk = 37
    targetProjectPath = ":androidApp"

    defaultConfig {
        minSdk = 28
        targetSdk = 37
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        create("benchmark") {
            isDebuggable = true
            isMinifyEnabled = true
            signingConfig = signingConfigs.getByName("debug")
            matchingFallbacks += listOf("release")
        }
    }
}

dependencies {
    implementation(libs.androidx.benchmark.macro.junit4)
    implementation(libs.androidx.arch.core.runtime)
    implementation(libs.androidx.profileinstaller)
    implementation(libs.androidx.test.junit)
    implementation(libs.androidx.test.uiautomator)
    implementation(libs.androidx.tracing)
    compileOnly(libs.errorprone.annotations)
}
