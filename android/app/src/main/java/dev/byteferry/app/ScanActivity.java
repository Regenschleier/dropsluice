package dev.byteferry.app;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Size;
import android.view.View;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.google.common.util.concurrent.ListenableFuture;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;

import java.nio.ByteBuffer;
import java.util.EnumMap;
import java.util.EnumSet;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 扫码页：CameraX 取帧 → zxing（纯 Java）解二维码 → 把文本交回 MainActivity。
 * 不用 Google Play 服务（ML Kit），所以在没有 GMS 的手机上也能用。
 */
public class ScanActivity extends AppCompatActivity implements ImageAnalysis.Analyzer {

    public static final String EXTRA_RESULT = "scan_result";

    private static final int REQ_CAMERA = 2001;

    private PreviewView previewView;
    private TextView hint;
    private ExecutorService analysisExecutor;
    private ProcessCameraProvider cameraProvider;
    private final MultiFormatReader reader = new MultiFormatReader();
    private final AtomicBoolean decoding = new AtomicBoolean(false);
    private final Handler main = new Handler(Looper.getMainLooper());
    private boolean delivered = false;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_scan);

        previewView = findViewById(R.id.preview);
        hint = findViewById(R.id.scanHint);

        Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
        hints.put(DecodeHintType.POSSIBLE_FORMATS, EnumSet.of(BarcodeFormat.QR_CODE));
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        hints.put(DecodeHintType.CHARACTER_SET, "UTF-8");
        reader.setHints(hints);
        reader.reset();

        analysisExecutor = Executors.newSingleThreadExecutor();

        findViewById(R.id.btnScanManual).setOnClickListener(v -> {
            setResult(RESULT_CANCELED);
            finish();
        });

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                == PackageManager.PERMISSION_GRANTED) {
            startCamera();
        } else {
            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.CAMERA}, REQ_CAMERA);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions,
                                           @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_CAMERA) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                startCamera();
            } else {
                Toast.makeText(this, R.string.need_camera, Toast.LENGTH_LONG).show();
                finish();
            }
        }
    }

    private void startCamera() {
        hint.setText(R.string.scan_hint);
        ListenableFuture<ProcessCameraProvider> future = ProcessCameraProvider.getInstance(this);
        future.addListener(() -> {
            try {
                cameraProvider = future.get();

                Preview preview = new Preview.Builder().build();
                preview.setSurfaceProvider(previewView.getSurfaceProvider());

                ImageAnalysis analysis = new ImageAnalysis.Builder()
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .setTargetResolution(new Size(1280, 720))
                        .build();
                analysis.setAnalyzer(analysisExecutor, this);

                cameraProvider.unbindAll();
                cameraProvider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis);
            } catch (Exception e) {
                Toast.makeText(this, getString(R.string.err_camera, String.valueOf(e.getMessage())),
                        Toast.LENGTH_LONG).show();
                finish();
            }
        }, ContextCompat.getMainExecutor(this));
    }

    @Override
    public void analyze(@NonNull ImageProxy image) {
        if (delivered || !decoding.compareAndSet(false, true)) {
            image.close();
            return;
        }
        try {
            String text = decodeFrame(image);
            if (text != null && !text.isEmpty()) {
                deliver(text);
                return;
            }
        } catch (Exception ignored) {
            // 单帧解不出来是常态，继续下一帧
        } finally {
            decoding.set(false);
            image.close();
        }
    }

    /** 把 YUV 帧的 Y 平面喂给 zxing；不裁切、不缩放，够用且快 */
    @Nullable
    private String decodeFrame(ImageProxy image) {
        ImageProxy.PlaneProxy plane = image.getPlanes()[0];
        ByteBuffer buffer = plane.getBuffer();
        int width = image.getWidth();
        int height = image.getHeight();
        int rowStride = plane.getRowStride();
        int pixelStride = plane.getPixelStride();

        byte[] data;
        int dataWidth;
        if (pixelStride == 1 && rowStride == width) {
            data = new byte[buffer.remaining()];
            buffer.get(data);
            dataWidth = width;
        } else {
            // 有些机型 Y 平面带 padding，按行拷成紧凑数组
            data = new byte[width * height];
            for (int y = 0; y < height; y++) {
                int base = y * rowStride;
                for (int x = 0; x < width; x++) {
                    int idx = base + x * pixelStride;
                    if (idx >= buffer.limit()) break;
                    data[y * width + x] = buffer.get(idx);
                }
            }
            dataWidth = width;
        }

        PlanarYUVLuminanceSource source = new PlanarYUVLuminanceSource(
                data, dataWidth, height, 0, 0, dataWidth, height, false);
        BinaryBitmap bitmap = new BinaryBitmap(new HybridBinarizer(source));
        try {
            Result r = reader.decodeWithState(bitmap);
            return r == null ? null : r.getText();
        } catch (Exception e) {
            return null;
        } finally {
            reader.reset();
        }
    }

    private void deliver(String text) {
        if (delivered) return;
        delivered = true;
        main.post(() -> {
            Intent out = new Intent();
            out.putExtra(EXTRA_RESULT, text);
            setResult(RESULT_OK, out);
            finish();
        });
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (cameraProvider != null) {
            cameraProvider.unbindAll();
        }
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (analysisExecutor != null) {
            analysisExecutor.shutdown();
        }
        if (cameraProvider != null) {
            cameraProvider.unbindAll();
        }
    }
}
