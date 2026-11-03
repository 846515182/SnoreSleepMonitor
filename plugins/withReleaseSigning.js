// 发布签名护栏：prebuild 生成的 android/app/build.gradle 默认让 release 复用 debug 签名。
// android/ 目录是生成物，所以护栏必须放在 config plugin 里，避免被下次 prebuild 覆盖。
// 效果：assembleRelease / bundleRelease 若缺少正式签名材料，直接在 Gradle 配置阶段失败，
// 不再静默产出 debug 签名的“release”包。

const { withAppBuildGradle } = require('@expo/config-plugins');

const MARKER = '// SNORE_RELEASE_SIGNING_GUARD';

const GUARD_BLOCK = `
${MARKER}
// release 必须使用正式签名；缺少材料时任务直接失败，禁止回退到 debug 签名。
android {
    signingConfigs {
        release {
            def envStoreFile = System.getenv("RELEASE_STORE_FILE") ?: System.getenv("STORE_FILE")
            storeFile file(envStoreFile ?: "release.keystore")
            storePassword System.getenv("RELEASE_STORE_PASSWORD") ?: System.getenv("STORE_PASSWORD")
            keyAlias System.getenv("RELEASE_KEY_ALIAS") ?: System.getenv("KEY_ALIAS")
            keyPassword System.getenv("RELEASE_KEY_PASSWORD") ?: System.getenv("KEY_PASSWORD")
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
        }
    }
}

gradle.taskGraph.whenReady { graph ->
    def wantsRelease = graph.allTasks.any {
        it.path == ':app:assembleRelease' || it.path == ':app:bundleRelease'
    }
    if (wantsRelease) {
        def storeFileEnv = System.getenv("RELEASE_STORE_FILE") ?: System.getenv("STORE_FILE")
        def keystore = file(storeFileEnv ?: "release.keystore")
        def missing = []
        if (!keystore.exists()) missing << "keystore(" + keystore + ")"
        if (!(System.getenv("RELEASE_STORE_PASSWORD") ?: System.getenv("STORE_PASSWORD"))) missing << "STORE_PASSWORD"
        if (!(System.getenv("RELEASE_KEY_ALIAS") ?: System.getenv("KEY_ALIAS"))) missing << "KEY_ALIAS"
        if (!(System.getenv("RELEASE_KEY_PASSWORD") ?: System.getenv("KEY_PASSWORD"))) missing << "KEY_PASSWORD"
        if (!missing.isEmpty()) {
            throw new GradleException(
                "Release 构建缺少正式签名材料：" + missing.join(", ") +
                "。本地 assembleRelease 不允许使用 debug 签名，产物不可直接分发。" +
                "请设置 RELEASE_STORE_FILE/RELEASE_STORE_PASSWORD/RELEASE_KEY_ALIAS/RELEASE_KEY_PASSWORD" +
                "（CI 使用 STORE_PASSWORD/KEY_ALIAS/KEY_PASSWORD），并将 keystore 放到 android/app/release.keystore。"
            )
        }
    }
}
`;

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      throw new Error('withReleaseSigning 仅支持 Groovy 版 build.gradle');
    }
    const contents = cfg.modResults.contents;
    if (!contents.includes(MARKER)) {
      cfg.modResults.contents = `${contents.trimEnd()}\n${GUARD_BLOCK}`;
    }
    return cfg;
  });
};
