import org.jetbrains.compose.ExperimentalComposeLibrary
import org.jetbrains.compose.desktop.application.dsl.TargetFormat
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import java.io.FileInputStream
import java.util.Properties

plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.android.application)
    alias(libs.plugins.compose.multiplatform)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.kover)
}

kotlin {
    androidTarget {
        compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
    }
    jvm("desktop") {
        compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
    }

    sourceSets {
        val desktopMain by getting

        commonMain {
            // Pull the generated LatticeBuild constants into commonMain so the
            // Settings screen can show the version on every target (Android can
            // ask PackageManager, but desktop has no equivalent). The task
            // wiring below makes Kotlin compiles wait on generation.
            kotlin.srcDir(layout.buildDirectory.dir("generated/lattice-build/commonMain/kotlin"))
        }
        commonMain.dependencies {
            implementation(compose.runtime)
            implementation(compose.foundation)
            implementation(compose.material3)
            implementation(compose.materialIconsExtended)
            implementation(compose.ui)
            implementation(compose.components.resources)
            implementation(libs.kotlinx.coroutines.core)
            implementation(libs.kotlinx.serialization.json)
            implementation(libs.okhttp)
            implementation(libs.okhttp.sse)
        }
        androidMain.dependencies {
            implementation(libs.androidx.activity.compose)
            implementation(libs.androidx.core.ktx)
            implementation(libs.kotlinx.coroutines.android)
        }
        desktopMain.dependencies {
            implementation(compose.desktop.currentOs)
            implementation(libs.kotlinx.coroutines.swing)
        }
        commonTest.dependencies {
            implementation(kotlin("test"))
            implementation(libs.kotlinx.coroutines.test)
        }
        val desktopTest by getting {
            dependencies {
                implementation(libs.mockwebserver)
                @OptIn(ExperimentalComposeLibrary::class)
                implementation(compose.uiTest)
                implementation(compose.desktop.currentOs)
            }
        }
    }
}

compose.resources {
    packageOfResClass = "io.nisfeb.lattice.resources"
    generateResClass = always
}

// Coverage gate over the unit-tested logic. UI composables, platform actuals,
// entry points and per-platform IO stores are excluded at the report level
// (Kover 0.8 disallows per-rule filters). Run ./gradlew :composeApp:koverVerifyJvm.
kover {
    reports {
        filters {
            excludes {
                classes(
                    "io.nisfeb.lattice.ui.*",            // Compose screens/components
                    "io.nisfeb.lattice.App*",            // root composable
                    "io.nisfeb.lattice.MainKt*",         // desktop entry point (+ its lambdas)
                    "io.nisfeb.lattice.SchemeRegistration*", // desktop OS scheme registration
                    "io.nisfeb.lattice.Platform*",       // expect/actual flag
                    "io.nisfeb.lattice.LatticeBuild*",   // generated version constants
                    "io.nisfeb.lattice.FilePicker*",     // expect/actual native file dialogs (IO)
                    "io.nisfeb.lattice.SystemBars*",     // expect/actual system-bar icon appearance
                    "io.nisfeb.lattice.bookmarks.*",     // per-platform IO
                    "io.nisfeb.lattice.theme.FileThemeStore*",
                    "io.nisfeb.lattice.theme.AndroidThemeStore*",
                    "io.nisfeb.lattice.urbit.FileSessionStore*",
                    "io.nisfeb.lattice.urbit.AndroidSessionStore*",
                    "io.nisfeb.lattice.urbit.UpdatesChannel*",  // Eyre SSE transport, integration-tested
                    "io.nisfeb.lattice.urbit.AgentInstaller*",  // kiln-install over Eyre (IO)
                    "io.nisfeb.lattice.share.WebClipper*",      // web fetch IO (OkHttp)
                    "io.nisfeb.lattice.share.SharedContent*",   // data holder
                    "io.nisfeb.lattice.resources.*",     // generated
                )
            }
        }
        verify {
            rule("tested logic (parsers, editor engine, urbit clients, theme)") {
                bound { minValue = 80 }
            }
        }
    }
}

// Single source of truth for the app version. The release workflow parses
// these two literals out of this file and checks them against the git tag,
// so keep them as plain `val name = literal` declarations.
val latticeVersionCode = 29
val latticeVersionName = "0.5.1"

// Surface the version literals above to commonMain via a generated Kotlin file,
// so the Settings screen can show it portably (single source of truth here).
val generateLatticeBuild = tasks.register("generateLatticeBuild") {
    val outputDir = layout.buildDirectory.dir("generated/lattice-build/commonMain/kotlin")
    val capturedVersionName = latticeVersionName
    val capturedVersionCode = latticeVersionCode
    inputs.property("versionName", capturedVersionName)
    inputs.property("versionCode", capturedVersionCode)
    outputs.dir(outputDir)
    doLast {
        val pkgDir = outputDir.get().asFile.resolve("io/nisfeb/lattice")
        pkgDir.mkdirs()
        pkgDir.resolve("LatticeBuild.kt").writeText(
            """
            package io.nisfeb.lattice

            /** Build-time constants generated by composeApp/build.gradle.kts. */
            object LatticeBuild {
                const val versionName: String = "$capturedVersionName"
                const val versionCode: Int = $capturedVersionCode
            }

            """.trimIndent(),
        )
    }
}

tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompilationTask<*>>().configureEach {
    dependsOn(generateLatticeBuild)
}

// jpackage (Dmg/Msi) rejects a MAJOR version of 0, but we're pre-1.0. Map
// "0.MINOR.PATCH" → "1.MINOR.PATCH" so desktop installer versions track the
// release tag; identity once we cross 1.0. Drops any "-rc"/"-beta" suffix
// (jpackage versions must be purely numeric dotted).
fun derivePackageVersion(): String {
    val core = latticeVersionName.substringBefore('-')
    val parts = core.split('.')
    val major = parts.getOrNull(0)?.toIntOrNull() ?: 0
    return if (major == 0) "1." + parts.drop(1).joinToString(".").ifEmpty { "0.0" } else core
}

android {
    namespace = "io.nisfeb.lattice"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.nisfeb.lattice"
        minSdk = 26
        targetSdk = 35
        versionCode = latticeVersionCode
        versionName = latticeVersionName
    }

    signingConfigs {
        create("release") {
            // Keystore lives outside the repo. RELEASE_KEYSTORE_PROPS points at
            // a properties file (storeFile/storePassword/keyAlias/keyPassword),
            // written by the release workflow from repo secrets. When unset,
            // release builds fall back to debug signing so local builds work.
            val propsPath = System.getenv("RELEASE_KEYSTORE_PROPS")
            if (propsPath != null) {
                val props = Properties().apply { FileInputStream(propsPath).use { load(it) } }
                storeFile = file(props.getProperty("storeFile"))
                storePassword = props.getProperty("storePassword")
                keyAlias = props.getProperty("keyAlias")
                keyPassword = props.getProperty("keyPassword")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildTypes {
        getByName("release") {
            val hasReleaseKeys = System.getenv("RELEASE_KEYSTORE_PROPS") != null
            signingConfig = signingConfigs.getByName(if (hasReleaseKeys) "release" else "debug")
            isMinifyEnabled = false
        }
    }
}

compose.desktop {
    application {
        mainClass = "io.nisfeb.lattice.MainKt"

        // Disable the desktop release ProGuard pass. It chokes on OkHttp's
        // optional Android/Conscrypt/BouncyCastle branches (never run on
        // desktop), and the bundled ProGuard can't parse newer JDK classes.
        // Desktop installers aren't download-size constrained, so the savings
        // wouldn't justify maintaining -dontwarn rules.
        buildTypes.release.proguard {
            isEnabled.set(false)
        }

        nativeDistributions {
            // .deb/.dmg/.msi come from jpackage (one per host in CI). The
            // portable Linux .AppImage is built separately by
            // scripts/build-appimage.sh off :createReleaseDistributable.
            targetFormats(TargetFormat.Dmg, TargetFormat.Msi, TargetFormat.Deb)
            packageName = "lattice"
            packageVersion = derivePackageVersion()
            description = "Browse and publish gemtext over Urbit"
            copyright = "© 2026 ~nisfeb"
            vendor = "nisfeb"
            // jpackage builds a trimmed JRE: OkHttp needs java.naming (DNS) and
            // jdk.crypto.ec (EC TLS) or https connections fail in the package.
            modules("java.naming", "jdk.crypto.ec")
            linux { iconFile.set(project.file("icons/lattice.png")) }
            macOS {
                iconFile.set(project.file("icons/lattice.icns"))
                // Register the urb:// scheme on macOS via the .app
                // bundle's Info.plist. Linux/Windows self-register at
                // first run (SchemeRegistration); macOS association
                // must be declared here at packaging time.
                infoPlist {
                    extraKeysRawXml = """
                        <key>CFBundleURLTypes</key>
                        <array>
                          <dict>
                            <key>CFBundleURLName</key>
                            <string>io.nisfeb.lattice.urb</string>
                            <key>CFBundleURLSchemes</key>
                            <array>
                              <string>urb</string>
                            </array>
                          </dict>
                        </array>
                    """.trimIndent()
                }
            }
            windows { iconFile.set(project.file("icons/lattice.ico")) }
        }
    }
}
