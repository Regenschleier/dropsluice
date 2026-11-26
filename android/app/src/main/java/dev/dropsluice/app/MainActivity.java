package dev.dropsluice.app;

import android.app.Dialog;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.Window;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
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
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;

import org.json.JSONArray;
import org.json.JSONObject;

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

    /** 连接中/连不上时盖在网页上的那层：白屏是最没法交代的状态，宁可多说一句。 */
    private View connOverlay;
    private View connSpinner;
    private View btnRetry;
    private View btnSwitch;
    private TextView connTitle;
    private TextView connBody;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private Runnable connTimeout;
    private boolean pageFailed;
    private static final long CONN_TIMEOUT_MS = 15000L;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webContainer = findViewById(R.id.webContainer);
        emptyState = findViewById(R.id.emptyState);
        web = findViewById(R.id.web);

        connOverlay = findViewById(R.id.connOverlay);
        connSpinner = findViewById(R.id.connSpinner);
        connTitle = findViewById(R.id.connTitle);
        connBody = findViewById(R.id.connBody);
        btnRetry = findViewById(R.id.btnRetry);
        btnSwitch = findViewById(R.id.btnSwitch);
        btnRetry.setOnClickListener(v -> retryLoad());
        btnSwitch.setOnClickListener(v -> promptManualUrl());

        findViewById(R.id.btnScan).setOnClickListener(v -> startScan());
        findViewById(R.id.btnManual).setOnClickListener(v -> promptManualUrl());

        configureWebView();

        String origin = prefs().getString(KEY_ORIGIN, null);
        if (origin == null) {
            showEmpty(true);
        } else {
            showEmpty(false);
            // 先把「正在连」盖上再去加载：WebView 从第一帧到页面真正画出来之间是白的，
            // 用户看到的「白屏」多半就是这一段。
            showConnecting(origin + "/");
            web.loadUrl(origin + "/");
        }
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /**
     * 网页能调的桥。现在只有一个开关：传输期间把屏幕钉住。
     * 手机自动锁屏后系统会掐掉 Wi-Fi，20 GB 传到一半就断了，所以传输时要拦住息屏。
     */
    private class NativeBridge {
        @JavascriptInterface
        public void keepAwake(final boolean on) {
            runOnUiThread(() -> {
                if (web != null) web.setKeepScreenOn(on);
            });
        }

        /** 手机「下载」目录里最近下完的文件（下载页用），JSON 数组字符串。 */
        @JavascriptInterface
        public String listDownloads() {
            JSONArray out = new JSONArray();
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) return out.toString();
            DownloadManager.Query q = new DownloadManager.Query();
            q.setFilterByStatus(DownloadManager.STATUS_SUCCESSFUL);
            Cursor c = null;
            try {
                c = dm.query(q);
                int idCol = c.getColumnIndex(DownloadManager.COLUMN_ID);
                int nameCol = c.getColumnIndex(DownloadManager.COLUMN_TITLE);
                int sizeCol = c.getColumnIndex(DownloadManager.COLUMN_TOTAL_SIZE_BYTES);
                int doneCol = c.getColumnIndex(DownloadManager.COLUMN_LAST_MODIFIED_TIMESTAMP);
                while (c.moveToNext() && out.length() < 100) {
                    JSONObject o = new JSONObject();
                    o.put("id", c.getLong(idCol));
                    o.put("name", c.getString(nameCol));
                    o.put("size", c.getLong(sizeCol));
                    o.put("at", c.getLong(doneCol));
                    out.put(o);
                }
            } catch (Exception ignored) {
                // 拿不到就返回已经凑出来的那部分，页面上显示「没有下载记录」也不影响别的功能
            } finally {
                if (c != null) c.close();
            }
            return out.toString();
        }

        /** 用系统能打开这个类型的应用打开某个已下载的文件。 */
        @JavascriptInterface
        public boolean openDownload(final long id) {
            DownloadManager dm = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) return false;
            Uri uri = dm.getUriForDownloadedFile(id);
            if (uri == null) return false;
            try {
                Intent i = new Intent(Intent.ACTION_VIEW);
                i.setDataAndType(uri, dm.getMimeTypeForDownloadedFile(id));
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(i);
                return true;
            } catch (ActivityNotFoundException e) {
                Toast.makeText(MainActivity.this, R.string.no_app_for_file, Toast.LENGTH_LONG).show();
                return false;
            }
        }

        /** 打开系统的「下载」列表，让用户自己翻。 */
        @JavascriptInterface
        public void openDownloadsFolder() {
            runOnUiThread(() -> {
                try {
                    startActivity(new Intent(DownloadManager.ACTION_VIEW_DOWNLOADS));
                } catch (ActivityNotFoundException e) {
                    Toast.makeText(MainActivity.this, R.string.no_app_for_file, Toast.LENGTH_LONG).show();
                }
            });
        }
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
        // 底色跟界面一致：哪怕页面还没画、或者画到一半，露出来的也是深色而不是白
        web.setBackgroundColor(0xFF0B0D10);
        // 让我们自己在电脑端的面板上认得出这是官方 App
        s.setUserAgentString(s.getUserAgentString() + " " + BuildConfig.UA_TAG);

        // 传输时由网页把屏幕钉住（见 public/app.js 的 setAwake）：锁屏会断网，大文件就白传了
        web.addJavascriptInterface(new NativeBridge(), "DropSluiceNative");

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
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                pageFailed = false;
                showConnecting(url);
            }

            @Override
            public void onPageCommitVisible(WebView view, String url) {
                super.onPageCommitVisible(view, url);
                // 有内容画出来了就别再盖着，免得挡住还能用的页面
                if (!pageFailed) hideConn();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                CookieManager.getInstance().flush();
                showEmpty(false);
                if (pageFailed) return;
                hideConn();
                // 页面加载「成功」但其实一片空白（脚本挂了、服务端回了空壳）也要说话
                if (url == null || !url.startsWith("http")) return;
                view.evaluateJavascript(
                        "(function(){var b=document.body;var t=b?b.innerText:'';return (t&&t.trim().length)?1:0;})()",
                        value -> {
                            if ("0".equals(value)) {
                                pageFailed = true;
                                showConnError(getString(R.string.conn_error_title),
                                        getString(R.string.conn_blank_body, url));
                            }
                        });
            }

            @Override
            public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                pageFailed = true;
                showConnError(getString(R.string.conn_error_title),
                        getString(R.string.conn_error_body, "网页进程被系统回收了",
                                String.valueOf(web.getUrl())));
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                pageFailed = true;
                showConnError(
                        getString(R.string.conn_error_title),
                        getString(R.string.conn_error_body,
                                String.valueOf(error.getDescription()),
                                request.getUrl().toString()));
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                            android.webkit.WebResourceResponse response) {
                super.onReceivedHttpError(view, request, response);
                // 403 是服务端的「请用 App 打开」引导页，它自己有内容，不算白屏
                if (!request.isForMainFrame()) return;
                int code = response == null ? 0 : response.getStatusCode();
                if (code == 0 || code == 403) return;
                pageFailed = true;
                showConnError(
                        getString(R.string.conn_error_title),
                        getString(R.string.conn_error_body, "HTTP " + code,
                                request.getUrl().toString()));
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

    /** 手势返回 / 返回键：先按网页历史回上一层目录，到根了才退出。 */

    private void showEmpty(boolean show) {
        emptyState.setVisibility(show ? View.VISIBLE : View.GONE);
        webContainer.setVisibility(show ? View.GONE : View.VISIBLE);
    }

    /** 盖一层「正在连 xxx」，超过 15 秒没结果就转成「没回应 + 怎么查」。 */
    private void showConnecting(String url) {
        emptyState.setVisibility(View.GONE);
        webContainer.setVisibility(View.VISIBLE);
        connOverlay.setVisibility(View.VISIBLE);
        connSpinner.setVisibility(View.VISIBLE);
        btnRetry.setVisibility(View.GONE);
        btnSwitch.setVisibility(View.GONE);
        connTitle.setText(R.string.conn_connecting);
        connBody.setText(getString(R.string.conn_connecting_body, url));
        cancelConnTimeout();
        connTimeout = () -> {
            if (connOverlay.getVisibility() != View.VISIBLE) return;
            if (connSpinner.getVisibility() != View.VISIBLE) return;
            pageFailed = true;
            showConnError(getString(R.string.conn_timeout_title),
                    getString(R.string.conn_timeout_body, url));
        };
        ui.postDelayed(connTimeout, CONN_TIMEOUT_MS);
    }

    private void hideConn() {
        cancelConnTimeout();
        connOverlay.setVisibility(View.GONE);
    }

    private void showConnError(String title, String body) {
        cancelConnTimeout();
        connOverlay.setVisibility(View.VISIBLE);
        connSpinner.setVisibility(View.GONE);
        btnRetry.setVisibility(View.VISIBLE);
        btnSwitch.setVisibility(View.VISIBLE);
        connTitle.setText(title);
        connBody.setText(body);
    }

    private void cancelConnTimeout() {
        if (connTimeout != null) {
            ui.removeCallbacks(connTimeout);
            connTimeout = null;
        }
    }

    private void retryLoad() {
        String saved = prefs().getString(KEY_ORIGIN, null);
        String cur = web.getUrl();
        pageFailed = false;
        if (cur != null && cur.startsWith("http")) {
            showConnecting(cur);
            web.reload();
        } else if (saved != null) {
            showConnecting(saved + "/");
            web.loadUrl(saved + "/");
        } else {
            showEmpty(true);
            hideConn();
        }
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

    /** 返回键：盖着提示就先收起提示；能回退就回退；退到头弹菜单（换电脑 / 清配对 / 退出） */
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode != KeyEvent.KEYCODE_BACK) return super.onKeyDown(keyCode, event);
        if (connOverlay.getVisibility() == View.VISIBLE && btnRetry.getVisibility() == View.VISIBLE) {
            hideConn();
            return true;
        }
        if (web != null && web.canGoBack() && webContainer.getVisibility() == View.VISIBLE) {
            web.goBack();
            return true;
        }
        showExitSheet();
        return true;
    }

    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    /** 一行：左边图标位 + 右边文字，点完整行都响应 */
    private void addSheetRow(LinearLayout parent, String glyph, int textRes, Runnable action, Dialog dialog) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(14), dp(13), dp(14), dp(13));
        row.setBackgroundColor(Color.TRANSPARENT);

        TextView icon = new TextView(this);
        icon.setText(glyph);
        icon.setTextSize(15f);
        icon.setTextColor(0xFF8B93A1);
        icon.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams iconLp = new LinearLayout.LayoutParams(dp(28), ViewGroup.LayoutParams.WRAP_CONTENT);
        row.addView(icon, iconLp);

        TextView label = new TextView(this);
        label.setText(textRes);
        label.setTextSize(15.5f);
        label.setTextColor(0xFFE8EBF0);
        LinearLayout.LayoutParams labelLp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        labelLp.leftMargin = dp(6);
        row.addView(label, labelLp);

        row.setOnClickListener(v -> {
            dialog.dismiss();
            action.run();
        });
        parent.addView(row);
    }

    private void addSheetDivider(LinearLayout parent) {
        View line = new View(this);
        line.setBackgroundColor(0xFF23272E);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, dp(0.5f)));
        lp.leftMargin = dp(48);
        parent.addView(line, lp);
    }

    private void showExitSheet() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(6), dp(6), dp(6), dp(6));

        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xFF15181D);
        bg.setCornerRadius(dp(18));
        bg.setStroke(Math.max(1, dp(1)), 0xFF262B33);
        box.setBackground(bg);

        TextView head = new TextView(this);
        head.setText(R.string.action_more);
        head.setTextSize(13f);
        head.setTypeface(Typeface.DEFAULT_BOLD);
        head.setTextColor(0xFF7F8794);
        head.setPadding(dp(18), dp(14), dp(18), dp(6));
        box.addView(head);

        final Dialog dialog = new Dialog(this);
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
        dialog.setContentView(box);

        addSheetRow(box, "⟲", R.string.action_rescan, this::startScan, dialog);
        addSheetDivider(box);
        addSheetRow(box, "⌨", R.string.action_manual, this::promptManualUrl, dialog);
        addSheetDivider(box);
        addSheetRow(box, "⌫", R.string.action_forget, this::forgetComputer, dialog);
        addSheetDivider(box);
        addSheetRow(box, "⏻", R.string.action_exit, this::finish, dialog);

        View cancelGap = new View(this);
        box.addView(cancelGap, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(6)));

        Window win = dialog.getWindow();
        if (win != null) {
            win.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            win.setGravity(Gravity.BOTTOM);
            win.getDecorView().setPadding(dp(10), 0, dp(10), dp(12));
        }
        dialog.show();
        if (win != null) {
            win.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        }
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
