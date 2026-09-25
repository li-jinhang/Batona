package com.batona.mobile.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Surface
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import com.batona.mobile.data.Binding
import com.batona.mobile.data.ConnectionParser
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.util.concurrent.Executors

/** 绑定页：扫码或粘贴 batona-gw:// 连接串 */
@Composable
fun BindScreen(onBound: (Binding) -> Unit) {
    val context = LocalContext.current
    var input by remember { mutableStateOf("") }
    var error by remember { mutableStateOf("") }
    var scanning by remember { mutableStateOf(false) }

    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) scanning = true else error = "需要相机权限才能扫码"
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Batona Mobile", style = MaterialTheme.typography.headlineMedium)
        Text("手机远程操控 DSH 与 Codex", color = MaterialTheme.colorScheme.onSurfaceVariant)

        Card(modifier = Modifier.fillMaxWidth().padding(top = 24.dp)) {
            Column(Modifier.padding(16.dp)) {
                Text("添加服务器")
                Text("扫码或粘贴服务器安装时生成的连接串（batona-gw://…）",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                OutlinedTextField(
                    value = input,
                    onValueChange = { input = it },
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    placeholder = { Text("batona-gw://服务器IP?frpToken=…&gwUser=…&gwPass=…") },
                    minLines = 3,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
                    Button(onClick = {
                        val b = ConnectionParser.parse(input)
                        if (b != null) { error = ""; onBound(b) } else error = "连接串格式无效"
                    }) { Text("解析并绑定") }
                    OutlinedButton(onClick = {
                        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                            scanning = true
                        } else cameraPermission.launch(Manifest.permission.CAMERA)
                    }) { Text("扫码") }
                }
                if (error.isNotEmpty()) Text(error, color = MaterialTheme.colorScheme.error)
            }
        }

    }
    if (scanning) {
        FullScreenScanner(
            onDetected = { text ->
                scanning = false
                val b = ConnectionParser.parse(text)
                if (b != null) { error = ""; onBound(b) } else error = "二维码不是有效的 Batona Mobile 连接串"
            },
            onDismiss = { scanning = false },
            title = "扫描服务器连接二维码",
            hint = "将服务器连接二维码放入框内",
        )
    }
}

@Composable
internal fun FullScreenScanner(
    onDetected: (String) -> Unit,
    onDismiss: () -> Unit,
    title: String = "扫描配对二维码",
    hint: String = "将电脑上的配对二维码放入框内",
) {
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Box(Modifier.fillMaxSize().background(Color.Black).testTag("scanner-fullscreen")) {
            CameraScanner(onDetected = onDetected, modifier = Modifier.fillMaxSize())
            Column(Modifier.fillMaxSize().safeDrawingPadding()) {
                Row(Modifier.fillMaxWidth().background(Color.Black.copy(alpha = 0.55f)).padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onDismiss) { Icon(Icons.Outlined.Close, contentDescription = "关闭扫码", tint = Color.White) }
                    Text(title, color = Color.White, style = MaterialTheme.typography.titleMedium)
                }
                Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    Surface(
                        modifier = Modifier.fillMaxWidth(0.72f).aspectRatio(1f),
                        color = Color.Transparent,
                        shape = RoundedCornerShape(24.dp),
                        border = androidx.compose.foundation.BorderStroke(2.dp, Color.White.copy(alpha = 0.9f)),
                    ) {}
                }
                Text(hint, modifier = Modifier.fillMaxWidth().background(Color.Black.copy(alpha = 0.55f)).padding(24.dp),
                    color = Color.White, style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center)
            }
        }
    }
}

/** CameraX + ZXing 二维码扫描器 */
@Composable
internal fun CameraScanner(onDetected: (String) -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val reader = remember {
        MultiFormatReader().apply {
            setHints(mapOf(
                DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE),
                DecodeHintType.TRY_HARDER to true,
            ))
        }
    }
    var analyzing by remember { mutableStateOf(true) }
    val executor = remember { Executors.newSingleThreadExecutor() }
    var cameraProvider by remember { mutableStateOf<ProcessCameraProvider?>(null) }

    DisposableEffect(Unit) {
        onDispose { analyzing = false; cameraProvider?.unbindAll(); executor.shutdownNow() }
    }

    AndroidView(
        factory = { ctx ->
            PreviewView(ctx).apply {
                // 异步初始化 CameraProvider（避免主线程阻塞）
                val providerFuture = ProcessCameraProvider.getInstance(ctx)
                providerFuture.addListener({
                    if (!analyzing) return@addListener
                    try {
                        val provider = providerFuture.get()
                        cameraProvider = provider
                        val preview = Preview.Builder().build().also { it.setSurfaceProvider(surfaceProvider) }
                        val analysis = ImageAnalysis.Builder()
                            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                            .build()
                        analysis.setAnalyzer(executor) { imageProxy: ImageProxy ->
                            if (!analyzing) { imageProxy.close(); return@setAnalyzer }
                            val text = decodeQr(imageProxy)
                            imageProxy.close()
                            if (text != null) {
                                analyzing = false
                                CoroutineScope(Dispatchers.Main).launch { onDetected(text) }
                            }
                        }
                        provider.unbindAll()
                        provider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                    } catch (_: Exception) {
                        // 相机不可用：不崩溃，用户可手动粘贴连接串
                    }
                }, ContextCompat.getMainExecutor(ctx))
            }
        },
        modifier = modifier,
    )
}

/** 从 ImageProxy 解码二维码（YUV → 灰度 → ZXing） */
private fun decodeQr(image: ImageProxy): String? {
    val plane = image.planes[0]
    val buffer = plane.buffer
    val width = image.width
    val height = image.height
    val rowStride = plane.rowStride
    val pixelStride = plane.pixelStride
    val data = ByteArray(buffer.remaining())
    buffer.get(data)

    val yuv = if (pixelStride == 1 && rowStride == width) data else {
        val out = ByteArray(width * height)
        var i = 0
        var row = 0
        while (row < height) {
            var col = 0
            while (col < width) {
                out[i++] = data[row * rowStride + col * pixelStride]
                col++
            }
            row++
        }
        out
    }
    return try {
        val source = PlanarYUVLuminanceSource(yuv, width, height, 0, 0, width, height, false)
        val bitmap = BinaryBitmap(HybridBinarizer(source))
        MultiFormatReader().decodeWithState(bitmap)?.text
    } catch (_: Exception) {
        null
    }
}
