const { withDangerousMod, withMainApplication } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const AUDIO_METER_MODULE_KT = [
  'package com.snoresleep.monitor',
  '',
  'import android.media.MediaRecorder',
  'import android.os.Build',
  'import com.facebook.react.bridge.*',
  'import java.io.File',
  '',
  'class AudioMeterModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {',
  '    private var recorder: MediaRecorder? = null',
  '    private var filePath: String = ""',
  '',
  '    override fun getName(): String = "AudioMeter"',
  '',
  '    @ReactMethod',
  '    fun startRecording(promise: Promise) {',
  '        try {',
  '            val dir = File(reactApplicationContext.cacheDir, "recordings")',
  '            if (!dir.exists()) dir.mkdirs()',
  '            val file = File(dir, "recording_${System.currentTimeMillis()}.m4a")',
  '            filePath = file.absolutePath',
  '',
  '            recorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {',
  '                MediaRecorder(reactApplicationContext)',
  '            } else {',
  '                @Suppress("DEPRECATION")',
  '                MediaRecorder()',
  '            }',
  '',
  '            recorder?.apply {',
  '                setAudioSource(MediaRecorder.AudioSource.MIC)',
  '                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)',
  '                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)',
  '                setAudioSamplingRate(44100)',
  '                setAudioChannels(1)',
  '                setAudioEncodingBitRate(64000)',
  '                setOutputFile(filePath)',
  '                prepare()',
  '                start()',
  '            }',
  '',
  '            promise.resolve("file://$filePath")',
  '        } catch (e: Exception) {',
  '            promise.reject("START_ERROR", e.message ?: "Unknown error")',
  '        }',
  '    }',
  '',
  '    @ReactMethod',
  '    fun getMaxAmplitude(promise: Promise) {',
  '        try {',
  '            val amplitude = recorder?.maxAmplitude ?: 0',
  '            promise.resolve(amplitude)',
  '        } catch (e: Exception) {',
  '            promise.reject("AMP_ERROR", e.message ?: "Unknown error")',
  '        }',
  '    }',
  '',
  '    @ReactMethod',
  '    fun stopRecording(promise: Promise) {',
  '        try {',
  '            recorder?.stop()',
  '            recorder?.release()',
  '            recorder = null',
  '            promise.resolve("file://$filePath")',
  '        } catch (e: Exception) {',
  '            recorder?.release()',
  '            recorder = null',
  '            promise.resolve("file://$filePath")',
  '        }',
  '    }',
  '}',
  '',
].join('\n');

const AUDIO_METER_PACKAGE_KT = [
  'package com.snoresleep.monitor',
  '',
  'import com.facebook.react.ReactPackage',
  'import com.facebook.react.ReactApplicationContext',
  'import com.facebook.react.bridge.NativeModule',
  'import com.facebook.react.uimanager.ViewManager',
  '',
  'class AudioMeterPackage : ReactPackage {',
  '    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {',
  '        return listOf(AudioMeterModule(reactContext))',
  '    }',
  '',
  '    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {',
  '        return emptyList()',
  '    }',
  '}',
  '',
].join('\n');

function withAudioMeter(config) {
  // 1. 写入原生模块 Kotlin 文件
  config = withDangerousMod(config, [
    'android',
    async (config) => {
      const root = config.modRequest.platformProjectRoot;
      const javaDir = path.join(root, 'app/src/main/java/com/snoresleep/monitor');
      fs.mkdirSync(javaDir, { recursive: true });
      fs.writeFileSync(path.join(javaDir, 'AudioMeterModule.kt'), AUDIO_METER_MODULE_KT);
      fs.writeFileSync(path.join(javaDir, 'AudioMeterPackage.kt'), AUDIO_METER_PACKAGE_KT);
      return config;
    },
  ]);

  // 2. 修改 MainApplication.kt 注册 AudioMeterPackage
  config = withMainApplication(config, (config) => {
    const contents = config.modResults.contents;

    // 在 getPackages() 中添加 AudioMeterPackage（同 package 无需 import）
    if (!contents.includes('packages.add(AudioMeterPackage())')) {
      config.modResults.contents = contents.replace(
        /val packages = PackageList\(this\)\.packages\.toMutableList\(\)/,
        'val packages = PackageList(this).packages.toMutableList()\n            packages.add(AudioMeterPackage())'
      );
    }

    return config;
  });

  return config;
}

module.exports = withAudioMeter;
