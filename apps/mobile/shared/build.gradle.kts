plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.android.kmp.library)
    alias(libs.plugins.kotlin.serialization)
}

kotlin {
    android {
        namespace = "com.ag2dev.ag2cli.mobile.shared"
        compileSdk = 37
        minSdk = 28
        withHostTest {}
    }

    sourceSets {
        commonMain.dependencies {
            implementation(libs.kotlinx.serialization.json)
            implementation(libs.kotlinx.coroutines.core)
            implementation(libs.kotlinx.collections.immutable)
            implementation(libs.ktor.client.core)
            implementation(libs.ktor.client.websockets)
        }
        commonTest.dependencies {
            implementation(kotlin("test"))
        }
        getByName("androidHostTest").dependencies {
            implementation(kotlin("test-junit"))
            implementation(libs.ktor.client.cio)
            implementation(libs.ktor.client.mock)
            implementation(libs.ktor.server.netty)
            implementation(libs.ktor.server.core)
            implementation(libs.ktor.server.websockets)
            implementation(libs.ktor.network.tls.certificates)
        }
    }
}
