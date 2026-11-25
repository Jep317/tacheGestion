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

    // Clé de signature secrète : l'action GitHub la reçoit du secret ANDROID_SIGNATURE et l'écrit
    // dans signature/taches.p12 (jamais dans le dépôt). Le mot de passe arrive par ANDROID_SIGNATURE_MDP.
    // Sans ces deux éléments (construction d'essai), l'APK est signé avec la clé de débogage et n'est pas publié.
    val cle = file("../signature/taches.p12")
    val mdp = System.getenv("ANDROID_SIGNATURE_MDP")
    val signee = cle.exists() && !mdp.isNullOrEmpty()
    if (signee) {
        signingConfigs {
            create("taches") {
                storeFile = cle
                storeType = "PKCS12"
                storePassword = mdp
                keyAlias = "taches"
                keyPassword = mdp
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName(if (signee) "taches" else "debug")
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
