plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

configurations.configureEach {
  exclude(group = "org.jetbrains", module = "annotations-java5")
}

val STATIC_VERSION_CODE = 1
val LOCAL_VERSION_CODE_FILE = "local-version-code.txt"

fun readPersistedLocalVersionCode(counterFile: java.io.File): Int? {
  return counterFile
    .takeIf { it.exists() }
    ?.readText()
    ?.trim()
    ?.toIntOrNull()
    ?.takeIf { it >= STATIC_VERSION_CODE }
}

fun shouldIncrementLocalVersionCode(taskNames: List<String>): Boolean {
  if (taskNames.isEmpty()) {
    return false
  }

  return taskNames.any { taskName ->
    val normalized = taskName.lowercase()
    normalized.contains("installdebug") ||
      normalized.contains("assembledebug") ||
      normalized.contains("bundledebug") ||
      normalized.contains("packagedebug")
  }
}

fun resolveLocalVersionCode(taskNames: List<String>, counterFile: java.io.File): Int {
  val persistedVersionCode = readPersistedLocalVersionCode(counterFile)
  if (!shouldIncrementLocalVersionCode(taskNames)) {
    return persistedVersionCode ?: STATIC_VERSION_CODE
  }

  val nextVersionCode = ((persistedVersionCode ?: 0) + 1).coerceAtLeast(STATIC_VERSION_CODE)
  counterFile.parentFile?.mkdirs()
  counterFile.writeText("$nextVersionCode\n")
  return nextVersionCode
}

val localVersionCode = resolveLocalVersionCode(
  taskNames = gradle.startParameter.taskNames,
  counterFile = rootProject.file(LOCAL_VERSION_CODE_FILE),
)

android {
  namespace = "com.agentvoiceadapter.android"
  compileSdk = 35

  defaultConfig {
    applicationId = "com.agentvoiceadapter.android"
    minSdk = 26
    targetSdk = 35
    versionCode = localVersionCode
    versionName = "0.1.0"

    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
  }

  buildTypes {
    release {
      isMinifyEnabled = false
      proguardFiles(
        getDefaultProguardFile("proguard-android-optimize.txt"),
        "proguard-rules.pro",
      )
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  kotlinOptions {
    jvmTarget = "17"
  }
}

dependencies {
  implementation("androidx.core:core-ktx:1.15.0")
  implementation("androidx.appcompat:appcompat:1.7.0")
  implementation("com.google.android.material:material:1.12.0")
  implementation("androidx.activity:activity-ktx:1.9.3")
  implementation("androidx.lifecycle:lifecycle-service:2.8.7")
  implementation("com.squareup.okhttp3:okhttp:4.12.0")
  implementation("io.noties.markwon:core:4.6.2")
  implementation("io.noties.markwon:ext-tables:4.6.2")
  implementation("io.noties.markwon:syntax-highlight:4.6.2")
  implementation("io.noties:prism4j:2.0.0") {
    exclude(group = "org.jetbrains", module = "annotations-java5")
  }
  annotationProcessor("io.noties:prism4j-bundler:2.0.0")

  testImplementation("junit:junit:4.13.2")
  androidTestImplementation("androidx.test.ext:junit:1.2.1")
  androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
}
