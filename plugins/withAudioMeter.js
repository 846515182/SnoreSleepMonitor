const { withDangerousMod, withMainApplication } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const AUDIO_METER_MODULE_KT = [
  `package com.snoresleep.monitor`,
  ``,
  `import android.Manifest`,
  `import android.content.pm.PackageManager`,
  `import android.media.AudioFormat`,
  `import android.media.AudioRecord`,
  `import android.media.MediaRecorder`,
  `import android.os.Process`,
  `import android.util.Log`,
  `import androidx.core.app.ActivityCompat`,
  `import com.facebook.react.bridge.*`,
  `import org.tensorflow.lite.Interpreter`,
  `import java.io.*`,
  `import java.nio.ByteBuffer`,
  `import java.nio.ByteOrder`,
  `import kotlin.math.*`,
  ``,
  `class AudioMeterModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {`,
  `    companion object {`,
  `        const val TAG = "AudioMeter"`,
  `        const val SAMPLE_RATE = 16000`,
  `        // YAMNet expects 0.975 s of 16 kHz mono PCM (15 600 samples).`,
  `        const val YAMNET_WINDOW_SAMPLES = 15600`,
  `        const val PCM_MAX = 32768.0f`,
  ``,
  `        // YAMNet class indices mapped to sleep-related categories.`,
  `        val SNORING_INDICES = listOf(38)`,
  `        // Wheeze, Gasp, Pant, Snort — abnormal breathing events that may indicate apnea.`,
  `        val APNEA_INDICES = listOf(37, 39, 40, 41)`,
  `        // Speech, Child speech, Conversation, Narration, Whispering.`,
  `        val TALKING_INDICES = listOf(0, 1, 2, 3, 12)`,
  `        // Chewing, Biting — closest proxies for teeth grinding (bruxism).`,
  `        val GRINDING_INDICES = listOf(49, 50)`,
  `    }`,
  ``,
  `    private var interpreter: Interpreter? = null`,
  `    private var audioRecord: AudioRecord? = null`,
  `    private var recordingThread: Thread? = null`,
  `    @Volatile private var isRecording = false`,
  ``,
  `    private var wavFilePath: String = ""`,
  `    private var wavOut: DataOutputStream? = null`,
  `    private var wavDataBytes: Int = 0`,
  ``,
  `    private val lock = Object()`,
  `    private var labels = listOf<String>()`,
  `    private var latestConfidences = emptyMap<String, Double>()`,
  `    private var latestTopClass = ""`,
  `    private var latestTopConfidence = 0.0`,
  `    private var latestIsSnoring = false`,
  `    private var latestAmplitudeDb = -100.0`,
  ``,
  `    override fun getName(): String = "AudioMeter"`,
  ``,
  `    @ReactMethod`,
  `    fun startRecording(promise: Promise) {`,
  `        try {`,
  `            if (ActivityCompat.checkSelfPermission(reactApplicationContext, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {`,
  `                throw SecurityException("RECORD_AUDIO permission not granted")`,
  `            }`,
  ``,
  `            // Load YAMNet class labels from the bundled CSV.`,
  `            labels = loadLabels()`,
  `            if (labels.isEmpty()) {`,
  `                labels = (0 until 521).map { "class_\$it" }`,
  `            }`,
  ``,
  `            // Copy TFLite model from assets to a regular file for the interpreter.`,
  `            val modelFile = File(reactApplicationContext.filesDir, "yamnet.tflite")`,
  `            if (!modelFile.exists()) {`,
  `                reactApplicationContext.assets.open("yamnet.tflite").use { input ->`,
  `                    FileOutputStream(modelFile).use { output ->`,
  `                        input.copyTo(output)`,
  `                    }`,
  `                }`,
  `            }`,
  `            val opts = Interpreter.Options().setNumThreads(2)`,
  `            interpreter = Interpreter(modelFile, opts)`,
  ``,
  `            // Prepare WAV recording`,
  `            val recordingsDir = File(reactApplicationContext.cacheDir, "recordings").apply { mkdirs() }`,
  `            val file = File(recordingsDir, "recording_\${System.currentTimeMillis()}.wav")`,
  `            wavFilePath = file.absolutePath`,
  `            wavOut = DataOutputStream(BufferedOutputStream(FileOutputStream(file)))`,
  `            writeWavHeader(wavOut!!, 0)`,
  `            wavDataBytes = 0`,
  ``,
  `            // Initialize AudioRecord (16 kHz, mono, 16-bit PCM)`,
  `            val minBufferSize = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)`,
  `            val bufferSize = max(minBufferSize, SAMPLE_RATE * 2)`,
  `            audioRecord = AudioRecord(MediaRecorder.AudioSource.MIC, SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufferSize)`,
  `            if (audioRecord?.state != AudioRecord.STATE_INITIALIZED) {`,
  `                throw IllegalStateException("AudioRecord failed to initialize")`,
  `            }`,
  ``,
  `            audioRecord?.startRecording()`,
  `            isRecording = true`,
  `            startAudioProcessing()`,
  ``,
  `            promise.resolve("file://\$wavFilePath")`,
  `        } catch (e: Exception) {`,
  `            Log.e(TAG, "startRecording failed", e)`,
  `            releaseResources()`,
  `            promise.reject("START_ERROR", e.message ?: "Unknown error")`,
  `        }`,
  `    }`,
  ``,
  `    @ReactMethod`,
  `    fun stopRecording(promise: Promise) {`,
  `        isRecording = false`,
  `        try {`,
  `            recordingThread?.join(1500)`,
  `        } catch (_: InterruptedException) {}`,
  `        recordingThread = null`,
  `        releaseResources()`,
  `        promise.resolve("file://\$wavFilePath")`,
  `    }`,
  ``,
  `    @ReactMethod`,
  `    fun getLatestResult(promise: Promise) {`,
  `        val map = Arguments.createMap()`,
  `        val confidencesMap = Arguments.createMap()`,
  `        synchronized(lock) {`,
  `            for ((name, value) in latestConfidences) {`,
  `                confidencesMap.putDouble(name, value)`,
  `            }`,
  `            map.putMap("confidences", confidencesMap)`,
  `            map.putString("topClass", latestTopClass)`,
  `            map.putDouble("topConfidence", latestTopConfidence)`,
  `            // Backward-compatible fields`,
  `            map.putDouble("snoreConfidence", latestConfidences["snoring"] ?: 0.0)`,
  `            map.putDouble("noiseConfidence", latestConfidences["noise"] ?: 0.0)`,
  `            map.putBoolean("isSnoring", latestIsSnoring)`,
  `            map.putDouble("amplitudeDb", latestAmplitudeDb)`,
  `        }`,
  `        promise.resolve(map)`,
  `    }`,
  ``,
  `    private fun releaseResources() {`,
  `        try { audioRecord?.stop() } catch (_: Exception) {}`,
  `        audioRecord?.release()`,
  `        audioRecord = null`,
  ``,
  `        wavOut?.let {`,
  `            try {`,
  `                it.flush()`,
  `                it.close()`,
  `                updateWavHeader(File(wavFilePath))`,
  `            } catch (_: Exception) {}`,
  `        }`,
  `        wavOut = null`,
  ``,
  `        interpreter?.close()`,
  `        interpreter = null`,
  `    }`,
  ``,
  `    private fun loadLabels(): List<String> {`,
  `        return try {`,
  `            val map = mutableMapOf<Int, String>()`,
  `            reactApplicationContext.assets.open("yamnet_class_map.csv").bufferedReader().useLines { lines ->`,
  `                lines.drop(1).forEach { line ->`,
  `                    val parts = line.split(",")`,
  `                    if (parts.size >= 3) {`,
  `                        val idx = parts[0].toIntOrNull() ?: return@forEach`,
  `                        val name = parts.subList(2, parts.size).joinToString(",").trim('"').trim()`,
  `                        if (name.isNotEmpty()) map[idx] = name`,
  `                    }`,
  `                }`,
  `            }`,
  `            val maxIdx = map.keys.maxOrNull() ?: 0`,
  `            (0..maxIdx).map { map[it] ?: "class_\$it" }`,
  `        } catch (e: Exception) {`,
  `            Log.w(TAG, "Failed to load yamnet_class_map.csv", e)`,
  `            emptyList()`,
  `        }`,
  `    }`,
  ``,
  `    private fun startAudioProcessing() {`,
  `        recordingThread = Thread {`,
  `            Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)`,
  `            val audioBuffer = mutableListOf<Short>()`,
  `            val readBuffer = ShortArray(640)`,
  ``,
  `            while (isRecording) {`,
  `                val read = audioRecord?.read(readBuffer, 0, readBuffer.size) ?: 0`,
  `                if (read > 0) {`,
  `                    // Write PCM samples to WAV file (little endian)`,
  `                    for (i in 0 until read) {`,
  `                        val s = readBuffer[i].toInt()`,
  `                        wavOut?.write(s and 0xFF)`,
  `                        wavOut?.write((s shr 8) and 0xFF)`,
  `                    }`,
  `                    wavDataBytes += read * 2`,
  ``,
  `                    // Accumulate for inference`,
  `                    for (i in 0 until read) audioBuffer.add(readBuffer[i])`,
  ``,
  `                    // Process every complete YAMNet window`,
  `                    while (audioBuffer.size >= YAMNET_WINDOW_SAMPLES) {`,
  `                        val window = ShortArray(YAMNET_WINDOW_SAMPLES) { audioBuffer[it] }`,
  `                        audioBuffer.subList(0, YAMNET_WINDOW_SAMPLES).clear()`,
  `                        processWindow(window)`,
  `                    }`,
  `                } else if (read < 0) {`,
  `                    Log.e(TAG, "AudioRecord read error: \$read")`,
  `                }`,
  `            }`,
  `        }.apply { start() }`,
  `    }`,
  ``,
  `    private fun processWindow(window: ShortArray) {`,
  `        // YAMNet expects normalized float32 waveform in [-1.0, 1.0].`,
  `        val audio = FloatArray(window.size) { window[it] / PCM_MAX }`,
  `        val inputBuffer = createInputBuffer(audio)`,
  ``,
  `        val rms = sqrt(audio.map { it * it }.average())`,
  `        val amplitudeDb = if (rms > 0.0) 20.0 * log10(rms) else -100.0`,
  ``,
  `        val outputShape = interpreter?.getOutputTensor(0)?.shape() ?: intArrayOf(1, labels.size)`,
  `        val outputBuffer: Any = if (outputShape.size == 1) {`,
  `            FloatArray(outputShape[0])`,
  `        } else {`,
  `            Array(outputShape[0]) { FloatArray(outputShape[1]) }`,
  `        }`,
  ``,
  `        interpreter?.runForMultipleInputsOutputs(arrayOf(inputBuffer), mapOf(0 to outputBuffer))`,
  ``,
  `        val scores = when (outputBuffer) {`,
  `            is FloatArray -> outputBuffer.map { it.toDouble() }.toDoubleArray()`,
  `            is Array<*> -> (outputBuffer as Array<FloatArray>)[0].map { it.toDouble() }.toDoubleArray()`,
  `            else -> DoubleArray(labels.size) { 0.0 }`,
  `        }`,
  ``,
  `        val confidences = aggregateScores(scores)`,
  `        val topEntry = confidences.maxByOrNull { it.value }`,
  `        val topClass = topEntry?.key ?: "noise"`,
  `        val topConfidence = topEntry?.value ?: 0.0`,
  `        val isSnoring = topClass == "snoring" && (confidences["snoring"] ?: 0.0) > 0.4`,
  ``,
  `        synchronized(lock) {`,
  `            latestConfidences = confidences`,
  `            latestTopClass = topClass`,
  `            latestTopConfidence = topConfidence`,
  `            latestIsSnoring = isSnoring`,
  `            latestAmplitudeDb = amplitudeDb`,
  `        }`,
  `        Log.d(TAG, "YAMNet top=%s %.3f snoring=%.3f apnea=%.3f talk=%.3f grind=%.3f amp=%.1fdB".format(`,
  `            topClass, topConfidence,`,
  `            confidences["snoring"] ?: 0.0,`,
  `            confidences["apnea"] ?: 0.0,`,
  `            confidences["talking"] ?: 0.0,`,
  `            confidences["grinding"] ?: 0.0,`,
  `            amplitudeDb))`,
  `    }`,
  ``,
  `    private fun createInputBuffer(audio: FloatArray): Any {`,
  `        val shape = interpreter?.getInputTensor(0)?.shape() ?: intArrayOf(1, audio.size)`,
  `        return if (shape.size == 1) {`,
  `            audio.copyOf(shape[0])`,
  `        } else {`,
  `            Array(shape[0]) { i -> if (i == 0) audio.copyOf(shape[1]) else FloatArray(shape[1]) }`,
  `        }`,
  `    }`,
  ``,
  `    private fun aggregateScores(scores: DoubleArray): Map<String, Double> {`,
  `        val snoring = SNORING_INDICES.sumOf { scores.getOrElse(it) { 0.0 } }`,
  `        val apnea = APNEA_INDICES.sumOf { scores.getOrElse(it) { 0.0 } }`,
  `        val talking = TALKING_INDICES.sumOf { scores.getOrElse(it) { 0.0 } }`,
  `        val grinding = GRINDING_INDICES.sumOf { scores.getOrElse(it) { 0.0 } }`,
  `        val noise = (1.0 - snoring - apnea - talking - grinding).coerceAtLeast(0.0)`,
  `        return mapOf(`,
  `            "snoring" to snoring,`,
  `            "apnea" to apnea,`,
  `            "talking" to talking,`,
  `            "grinding" to grinding,`,
  `            "noise" to noise`,
  `        )`,
  `    }`,
  ``,
  `    private fun DoubleArray.getOrElse(index: Int, default: Double): Double {`,
  `        return if (index in indices) this[index] else default`,
  `    }`,
  ``,
  `    private fun writeWavHeader(out: DataOutputStream, dataSize: Int) {`,
  `        val totalSize = 36 + dataSize`,
  `        out.writeBytes("RIFF")`,
  `        writeIntLe(out, totalSize)`,
  `        out.writeBytes("WAVE")`,
  `        out.writeBytes("fmt ")`,
  `        writeIntLe(out, 16)`,
  `        writeShortLe(out, 1)`,
  `        writeShortLe(out, 1)`,
  `        writeIntLe(out, SAMPLE_RATE)`,
  `        writeIntLe(out, SAMPLE_RATE * 2)`,
  `        writeShortLe(out, 2)`,
  `        writeShortLe(out, 16)`,
  `        out.writeBytes("data")`,
  `        writeIntLe(out, dataSize)`,
  `    }`,
  ``,
  `    private fun updateWavHeader(file: File) {`,
  `        val dataSize = wavDataBytes`,
  `        val totalSize = 36 + dataSize`,
  `        RandomAccessFile(file, "rw").use { raf ->`,
  `            raf.seek(4)`,
  `            raf.writeIntLe(totalSize)`,
  `            raf.seek(40)`,
  `            raf.writeIntLe(dataSize)`,
  `        }`,
  `    }`,
  ``,
  `    private fun RandomAccessFile.writeIntLe(v: Int) {`,
  `        write(v and 0xFF)`,
  `        write((v shr 8) and 0xFF)`,
  `        write((v shr 16) and 0xFF)`,
  `        write((v shr 24) and 0xFF)`,
  `    }`,
  ``,
  `    private fun writeIntLe(out: DataOutputStream, v: Int) {`,
  `        out.write(v and 0xFF)`,
  `        out.write((v shr 8) and 0xFF)`,
  `        out.write((v shr 16) and 0xFF)`,
  `        out.write((v shr 24) and 0xFF)`,
  `    }`,
  ``,
  `    private fun writeShortLe(out: DataOutputStream, v: Int) {`,
  `        out.write(v and 0xFF)`,
  `        out.write((v shr 8) and 0xFF)`,
  `    }`,
  `}`,
  ``,
].join('\n');

const AUDIO_METER_PACKAGE_KT = [
  `package com.snoresleep.monitor`,
  ``,
  `import com.facebook.react.ReactPackage`,
  `import com.facebook.react.bridge.ReactApplicationContext`,
  `import com.facebook.react.bridge.NativeModule`,
  `import com.facebook.react.uimanager.ViewManager`,
  ``,
  `class AudioMeterPackage : ReactPackage {`,
  `    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {`,
  `        return listOf(AudioMeterModule(reactContext))`,
  `    }`,
  ``,
  `    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {`,
  `        return emptyList()`,
  `    }`,
  `}`,
  ``,
].join('\n');

function withAudioMeter(config) {
  // 1. Write native module files and copy the YAMNet model + class map into Android assets
  config = withDangerousMod(config, [
    'android',
    async (config) => {
      const root = config.modRequest.platformProjectRoot;
      const projectRoot = config.modRequest.projectRoot;
      const javaDir = path.join(root, 'app/src/main/java/com/snoresleep/monitor');
      fs.mkdirSync(javaDir, { recursive: true });
      fs.writeFileSync(path.join(javaDir, 'AudioMeterModule.kt'), AUDIO_METER_MODULE_KT);
      fs.writeFileSync(path.join(javaDir, 'AudioMeterPackage.kt'), AUDIO_METER_PACKAGE_KT);

      // Copy the YAMNet model and its class map into Android assets.
      const assetsDir = path.join(root, 'app/src/main/assets');
      fs.mkdirSync(assetsDir, { recursive: true });

      const modelSrc = path.join(projectRoot, 'assets/yamnet/yamnet.tflite');
      const modelDst = path.join(assetsDir, 'yamnet.tflite');
      if (fs.existsSync(modelSrc)) {
        fs.copyFileSync(modelSrc, modelDst);
      } else {
        throw new Error(`YAMNet TFLite model not found at ${modelSrc}`);
      }

      const labelsSrc = path.join(projectRoot, 'assets/yamnet/yamnet_class_map.csv');
      const labelsDst = path.join(assetsDir, 'yamnet_class_map.csv');
      if (fs.existsSync(labelsSrc)) {
        fs.copyFileSync(labelsSrc, labelsDst);
      } else {
        throw new Error(`YAMNet class map not found at ${labelsSrc}`);
      }

      return config;
    },
  ]);

  // 2. Add TensorFlow Lite dependency to app/build.gradle
  config = withDangerousMod(config, [
    'android',
    async (config) => {
      const root = config.modRequest.platformProjectRoot;
      const buildGradle = path.join(root, 'app/build.gradle');
      if (fs.existsSync(buildGradle)) {
        let contents = fs.readFileSync(buildGradle, 'utf8');
        const dep = 'implementation("org.tensorflow:tensorflow-lite:2.16.1")';
        if (!contents.includes('tensorflow-lite')) {
          contents = contents.replace(/dependencies\s*\{/, `dependencies {\n    ${dep}`);
          fs.writeFileSync(buildGradle, contents);
        }
      }
      return config;
    },
  ]);

  // 3. Modify MainApplication.kt to register AudioMeterPackage
  config = withMainApplication(config, (config) => {
    const contents = config.modResults.contents;

    if (contents.includes('AudioMeterPackage')) {
      return config;
    }

    if (/PackageList\(this\)\.packages\.apply\s*\{/.test(contents)) {
      config.modResults.contents = contents.replace(
        /PackageList\(this\)\.packages\.apply\s*\{/,
        'PackageList(this).packages.apply {\n              add(AudioMeterPackage())'
      );
      return config;
    }

    if (/val packages = PackageList\(this\)\.packages\.toMutableList\(\)/.test(contents)) {
      config.modResults.contents = contents.replace(
        /val packages = PackageList\(this\)\.packages\.toMutableList\(\)/,
        'val packages = PackageList(this).packages.toMutableList()\n            packages.add(AudioMeterPackage())'
      );
      return config;
    }

    if (/return PackageList\(this\)\.packages/.test(contents)) {
      config.modResults.contents = contents.replace(
        /return PackageList\(this\)\.packages/,
        'val packages = PackageList(this).packages.toMutableList()\n            packages.add(AudioMeterPackage())\n            return packages'
      );
      return config;
    }

    return config;
  });

  return config;
}

module.exports = withAudioMeter;
