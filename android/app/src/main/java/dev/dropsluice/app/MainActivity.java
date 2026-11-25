package dev.dropsluice.app;

import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.text.InputType;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;

/**
 * DropSluice 的手机端外壳。
 *
 * 它本身不实现任何文件协议：真正的文件服务跑在电脑上（默认 18888 端口），
 * 这个 App 只做三件事——
 *   1. 用相机扫码，拿到电脑上的配对地址（二维码里就是 http://<电脑IP>:<端口>/pair?c=<6位码>）；
 *   2. 用 WebView 打开那个地址，配对成功后电脑会种一个 HttpOnly cookie，之后就一直用它；
 *   3. 接管文件下载（交给系统下载管理器，带 cookie，原始字节不经过二次编码）和上传（文件选择器）。
 */
public class MainActivity extends AppCompatActivity {

    private static final int REQ_SCAN = 1001;
    private static final int REQ_FILE = 1002;
    private static final String PREFS = "phone_drop";
    private static final String KEY_ORIGIN = "origin";

    private WebView web;
    private View emptyState;
    private View webContainer;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webContainer = findViewById(R.id.webContainer);
        emptyState = findViewById(R.id.emptyState);
        web = findViewById(R.id.web);

        findViewById(R.id.btnScan).setOnClickListener(v -> startScan());
        findViewById(R.id.btnManual).setOnClickListener(v -> promptManualUrl());

        configureWebView();

        String origin = prefs().getString(KEY_ORIGIN, null);
        if (origin == null) {
            showEmpty(true);
        } else {
            showEmpty(false);
            web.loadUrl(origin + "/");
        }
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private void configureWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);
        // 让我们自己在电脑端的面板上认得出这是官方 App
        s.setUserAgentString(s.getUserAgentString() + " " + BuildConfig.UA_TAG);

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(web, false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // 一切都在 WebView 里走；只有非 http(s) 的交给系统
                Uri u = request.getUrl();
                String scheme = u.getScheme() == null ? "" : u.getScheme();
                if (!scheme.startsWith("http")) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, u));
                    } catch (ActivityNotFoundException ignored) {
                    }
                    return true;
                }
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                CookieManager.getInstance().flush();
                showEmpty(false);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    toast(getString(R.string.err_load, String.valueOf(error.getDescription())));
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null);
                }
                fileCallback = callback;
                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(Intent.createChooser(intent, getString(R.string.choose_file)), REQ_FILE);
                    return true;
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    return false;
                }
            }
        });

        // 点「下载」时把字节原样交给系统下载管理器（带上配对 cookie）
        web.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            try {
                enqueueDownload(url, userAgent, contentDisposition, mimeType);
            } catch (Exception e) {
                toast(getString(R.string.err_download, String.valueOf(e.getMessage())));
            }
        });
    }

    private void enqueueDownload(String url, String userAgent, String contentDisposition, String mimeType) {
        String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
        DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
        req.setMimeType(mimeType);
        req.setTitle(name);
        req.setDescription(getString(R.string.downloading));
        req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
        if (userAgent != null) {
            req.addRequestHeader("User-Agent", userAgent);
        }
        String cookie = CookieManager.getInstance().getCookie(url);
        if (cookie != null) {
            req.addRequestHeader("Cookie", cookie);
        }
        DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
        dm.enqueue(req);
        toast(getString(R.string.download_started, name));
    }

    private void startScan() {
        Intent i = new Intent(this, ScanActivity.class);
        try {
            startActivityForResult(i, REQ_SCAN);
        } catch (ActivityNotFoundException e) {
            promptManualUrl();
        }
    }

    private void promptManualUrl() {
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint("http://192.168.1.10:18888");
        String saved = prefs().getString(KEY_ORIGIN, "");
        input.setText(saved);

        FrameLayout wrap = new FrameLayout(this);
        int pad = Math.round(getResources().getDisplayMetrics().density * 20);
        wrap.setPadding(pad, pad / 2, pad, 0);
        wrap.addView(input);

        new AlertDialog.Builder(this)
                .setTitle(R.string.manual_title)
                .setMessage(R.string.manual_hint)
                .setView(wrap)
                .setPositiveButton(R.string.connect, (d, w) -> {
                    String origin = normalizeOrigin(input.getText().toString().trim());
                    if (origin == null) {
                        toast(getString(R.string.err_bad_url));
                        return;
                    }
                    rememberOrigin(origin);
                    showEmpty(false);
                    web.loadUrl(origin + "/");
                })
                .setNegativeButton(android.R.string.cancel, null)
                .show();
    }

    /** 把用户填/扫到的任意 URL 收敛成 scheme://host:port，非 http(s) 返回 null */
    @Nullable
    static String normalizeOrigin(String text) {
        if (text == null) return null;
        String t = text.trim();
        if (t.isEmpty()) return null;
        if (!t.startsWith("http://") && !t.startsWith("https://")) {
            if (t.matches("^\\d{1,3}(\\.\\d{1,3}){3}(:\\d+)?(/.*)?$")) {
                t = "http://" + t;
            } else if (t.matches("^[\\w.-]+(:\\d+)?(/.*)?$") && t.contains(".")) {
                t = "http://" + t;
            } else {
                return null;
            }
        }
        try {
            Uri u = Uri.parse(t);
            String host = u.getHost();
            if (host == null || host.isEmpty()) return null;
            int port = u.getPort();
            String scheme = u.getScheme();
            if (port <= 0) {
                port = "https".equals(scheme) ? 443 : 18888;
            }
            return scheme + "://" + host + ":" + port;
        } catch (Exception e) {
            return null;
        }
    }

    private void rememberOrigin(String origin) {
        prefs().edit().putString(KEY_ORIGIN, origin).apply();
    }

    private void showEmpty(boolean show) {
        emptyState.setVisibility(show ? View.VISIBLE : View.GONE);
        webContainer.setVisibility(show ? View.GONE : View.VISIBLE);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, @Nullable Intent data) {
        super.onActivityResult(requestCode, resultCode, data);

        if (requestCode == REQ_SCAN) {
            if (resultCode == RESULT_OK && data != null) {
                String scanned = data.getStringExtra(ScanActivity.EXTRA_RESULT);
                String origin = normalizeOrigin(scanned);
                if (origin != null) {
                    rememberOrigin(origin);
                    showEmpty(false);
                    // 用扫到的完整 URL（带着 ?c=配对码），配对成功后电脑会重定向回列表
                    web.loadUrl(scanned.trim());
                } else {
                    toast(getString(R.string.err_bad_url));
                }
            }
            return;
        }

        if (requestCode == REQ_FILE) {
            if (fileCallback == null) return;
            Uri[] uris = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int n = data.getClipData().getItemCount();
                    uris = new Uri[n];
                    for (int i = 0; i < n; i++) {
                        uris[i] = data.getClipData().getItemAt(i).getUri();
                    }
                } else if (data.getData() != null) {
                    uris = new Uri[]{data.getData()};
                }
            }
            fileCallback.onReceiveValue(uris);
            fileCallback = null;
        }
    }

    /** 返回键：能回退就回退，退到头弹菜单（换电脑 / 清配对 / 退出） */
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()
                && webContainer.getVisibility() == View.VISIBLE) {
            web.goBack();
            return true;
        }
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            showExitSheet();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    private void showExitSheet() {
        String[] items = new String[]{
                getString(R.string.action_rescan),
                getString(R.string.action_manual),
                getString(R.string.action_forget),
                getString(R.string.action_exit)
        };
        new AlertDialog.Builder(this)
                .setTitle(R.string.action_more)
                .setItems(items, (d, which) -> {
                    switch (which) {
                        case 0:
                            startScan();
                            break;
                        case 1:
                            promptManualUrl();
                            break;
                        case 2:
                            forgetComputer();
                            break;
                        default:
                            finish();
                    }
                })
                .show();
    }

    private void forgetComputer() {
        prefs().edit().clear().apply();
        CookieManager.getInstance().removeAllCookies(null);
        CookieManager.getInstance().flush();
        web.loadUrl("about:blank");
        web.clearHistory();
        showEmpty(true);
        toast(getString(R.string.forgotten));
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
        }
        super.onDestroy();
    }
}
