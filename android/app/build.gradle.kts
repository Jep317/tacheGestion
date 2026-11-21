plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.github.jep317.taches"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.jep317.taches"
        minSdk = 26
        targetSdk = 35
        // Numéro croissant fourni par l'action GitHub, pour que chaque APK s'installe par-dessus le précédent.
        versionCode = (System.getenv("VERSION_CODE") ?: "1").toInt()
        versionName = "1.0.0"
    }

    // Clé de signature fixe, rangée dans le dépôt : chaque nouvelle version s'installe par-dessus l'ancienne
    // sans perdre la connexion ni le widget. Appli personnelle installée hors Play Store.
    signingConfigs {
        create("taches") {
            storeFile = file("../signature/taches.jks")
            storePassword = "taches-android"
            keyAlias = "taches"
            keyPassword = "taches-android"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("taches")
        }
        debug {
            signingConfig = signingConfigs.getByName("taches")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    lint {
        checkReleaseBuilds = false
    }
}
