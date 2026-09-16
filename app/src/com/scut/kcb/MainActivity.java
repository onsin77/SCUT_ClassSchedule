package com.scut.kcb;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.pdf.PdfDocument;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.provider.Settings;
import android.util.Base64;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.JsResult;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.util.Iterator;

public class MainActivity extends Activity {

    public static final String PREFS = "kcb";
    public static final String CH_DAILY = "daily";
    public static final String CH_PRECLASS = "preclass";

    private static final int REQ_OPEN = 1001;
    private static final int REQ_CREATE = 1002;
    private static final int REQ_NOTIF = 2001;

    /** 选择文件时一次性读进内存的上限（备注附件用，超过就直接劝退） */
    private static final int MAX_PICK_BYTES = 6 * 1024 * 1024;

    // A4 横向：72dpi 下 842 x 595 pt。
    // 离屏 WebView 按 CSS 像素渲染（1 CSS px = 1/96 inch），
    // 因此宽度取 1123px，再整体缩放 0.75 正好落进 842pt。
    private static final float PT_W = 842f;
    private static final float PT_H = 595f;
    private static final int PX_W = 1123;
    private static final float SCALE = 0.75f;
    private static final int PAGE_H = Math.round(PT_H / SCALE);   // 793px ≈ 595pt

    private FrameLayout root;
    private WebView web;
    private String pickToken = null;
    private String pendingSaveKind = null;   // "json" | "pdf"
    private String pendingSaveB64 = null;
    private String pendingPdfName = null;
    private String pendingPdfHtml = null;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        installCrashHandler();
        createChannels();

        root = new FrameLayout(this);
        root.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.setBackgroundColor(0xFFF4F6F9);

        web = new WebView(this);
        web.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setLoadWithOverviewMode(false);
        s.setUseWideViewPort(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setTextZoom(100);
        web.setBackgroundColor(0xFFF4F6F9);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        // 系统默认的 alert/confirm 标题是「网址为"file://"的网页显示：」，太难看了，
        // 换成 App 自己的标题和按钮文案
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onJsConfirm(WebView v, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle("华工课程表")
                        .setMessage(message)
                        .setNegativeButton("取消", new DialogInterface.OnClickListener() {
                            public void onClick(DialogInterface d, int w) {
                                result.cancel();
                            }
                        })
                        .setPositiveButton("确定", new DialogInterface.OnClickListener() {
                            public void onClick(DialogInterface d, int w) {
                                result.confirm();
                            }
                        })
                        .setOnCancelListener(new DialogInterface.OnCancelListener() {
                            public void onCancel(DialogInterface d) {
                                result.cancel();
                            }
                        })
                        .show();
                return true;
            }

            @Override
            public boolean onJsAlert(WebView v, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setTitle("华工课程表")
                        .setMessage(message)
                        .setPositiveButton("知道了", new DialogInterface.OnClickListener() {
                            public void onClick(DialogInterface d, int w) {
                                result.confirm();
                            }
                        })
                        .show();
                return true;
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView v, String url) {
                // 上次是不是崩过？把栈丢给 JS 展示，方便定位
                String log = readCrashLog();
                if (log != null) {
                    js("HG.onCrashLog('" + b64ForJs(log) + "');");
                }
            }
        });
        web.addJavascriptInterface(new Bridge(), "Android");
        web.loadUrl("file:///android_asset/www/index.html");

        root.addView(web);
        setContentView(root);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.evaluateJavascript("window.HG && HG.onResume && HG.onResume();", null);
    }

    @Override
    public void onBackPressed() {
        if (impOverlay != null && impOverlay.getParent() != null) {
            closeWebImport();
            return;
        }
        if (web == null) { super.onBackPressed(); return; }
        web.evaluateJavascript("window.HG && HG.onBack ? HG.onBack() : 'exit'", new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String value) {
                if (value == null || value.contains("exit")) finish();
            }
        });
    }

    // ------------------------------------------------------------------ 通知

    private void createChannels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel daily = new NotificationChannel(CH_DAILY, "每日课表", NotificationManager.IMPORTANCE_DEFAULT);
        daily.setDescription("每天早上和中午推送当天课表");
        NotificationChannel pre = new NotificationChannel(CH_PRECLASS, "课前提醒", NotificationManager.IMPORTANCE_HIGH);
        pre.setDescription("每堂课开始前提醒");
        nm.createNotificationChannel(daily);
        nm.createNotificationChannel(pre);
    }

    private boolean canExact() {
        if (Build.VERSION.SDK_INT >= 31) {
            AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
            return am.canScheduleExactAlarms();
        }
        return true;
    }

    private PendingIntent alarmIntent(String id, JSONObject o) {
        Intent i = new Intent(this, ReminderReceiver.class);
        i.setAction("com.scut.kcb.ALARM." + id);
        i.putExtra("id", id);
        if (o != null) {
            i.putExtra("title", o.optString("title", "华工课程表"));
            i.putExtra("body", o.optString("body", ""));
            i.putExtra("channel", o.optString("channel", CH_PRECLASS));
            i.putExtra("img", o.optString("img", ""));    // 备注图片的 key，到点再取出来
        }
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(this, id.hashCode(), i, flags);
    }

    private synchronized void applySchedule(String json, String imgsJson) {
        AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
        SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);

        try {
            JSONObject old = new JSONObject(sp.getString("alarms", "{}"));
            for (Iterator<String> it = old.keys(); it.hasNext(); ) {
                am.cancel(alarmIntent(it.next(), null));
            }
        } catch (Exception ignored) { }

        JSONObject keep = new JSONObject();
        JSONObject usedImgs = new JSONObject();       // 只留下这次计划真正用到的图
        JSONObject allImgs;
        try {
            allImgs = new JSONObject(imgsJson == null ? "{}" : imgsJson);
        } catch (Exception e) {
            allImgs = new JSONObject();
        }
        long now = System.currentTimeMillis();
        boolean exact = canExact();
        try {
            JSONObject in = new JSONObject(json);
            for (Iterator<String> it = in.keys(); it.hasNext(); ) {
                String id = it.next();
                JSONObject o = in.optJSONObject(id);
                if (o == null) continue;
                long at = o.optLong("at", 0);
                if (at <= now + 1000) continue;
                String ik = o.optString("img", "");
                if (!ik.isEmpty()) {
                    String data = allImgs.optString(ik, "");
                    if (!data.isEmpty()) {
                        usedImgs.put(ik, data);
                    } else {
                        o.remove("img");
                    }
                }
                PendingIntent pi = alarmIntent(id, o);
                if (exact) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                keep.put(id, o);
            }
        } catch (Exception ignored) { }

        sp.edit().putString("alarms", keep.toString())
                .putString("alarmImgs", usedImgs.toString()).apply();
    }

    static void restoreAlarms(Context ctx) {
        SharedPreferences sp = ctx.getSharedPreferences(PREFS, MODE_PRIVATE);
        String json = sp.getString("alarms", "{}");
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        boolean exact = true;
        if (Build.VERSION.SDK_INT >= 31) exact = am.canScheduleExactAlarms();
        long now = System.currentTimeMillis();
        try {
            JSONObject in = new JSONObject(json);
            for (Iterator<String> it = in.keys(); it.hasNext(); ) {
                String id = it.next();
                JSONObject o = in.optJSONObject(id);
                if (o == null) continue;
                long at = o.optLong("at", 0);
                if (at <= now) continue;
                Intent i = new Intent(ctx, ReminderReceiver.class);
                i.setAction("com.scut.kcb.ALARM." + id);
                i.putExtra("id", id);
                i.putExtra("title", o.optString("title", "华工课程表"));
                i.putExtra("body", o.optString("body", ""));
                i.putExtra("channel", o.optString("channel", CH_PRECLASS));
                i.putExtra("img", o.optString("img", ""));
                int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
                PendingIntent pi = PendingIntent.getBroadcast(ctx, id.hashCode(), i, flags);
                if (exact) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            }
        } catch (Exception ignored) { }
    }

    /** 版本号从清单里读，免得每次发版都要回来改这个字符串 */
    private String appVersion() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "?";
        }
    }

    // ------------------------------------------------------------------ 文件    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (res != RESULT_OK || data == null) {
            if (req == REQ_OPEN) js("HG.onFileData('" + safe(pickToken) + "', null, '已取消');");
            if (req == REQ_CREATE) js("HG.onSaveDone(false, '已取消');");
            pickToken = null;
            pendingSaveKind = null;
            return;
        }
        Uri uri = data.getData();
        if (req == REQ_OPEN) {
            try {
                InputStream in = getContentResolver().openInputStream(uri);
                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
                in.close();
                // 备注附件只收小文件：读之前就把大文件挡掉，免得 base64 之后内存爆掉
                if (bos.size() > MAX_PICK_BYTES) {
                    js("HG.onFileData('" + safe(pickToken) + "', null, "
                            + qs("文件太大了（" + (bos.size() / 1048576 + 1) + " MB，上限 6 MB）") + ");");
                } else {
                    String b64 = Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP);
                    String name = String.valueOf(uri.getLastPathSegment());
                    String mime = getContentResolver().getType(uri);
                    js("HG.onFileData('" + safe(pickToken) + "', '" + b64 + "', "
                            + qs(name) + ", " + qs(mime) + ");");
                }
            } catch (Exception e) {
                js("HG.onFileData('" + safe(pickToken) + "', null, '读取失败');");
            }
            pickToken = null;
        } else if (req == REQ_CREATE) {
            if ("json".equals(pendingSaveKind)) {
                boolean ok = writeBytes(uri, Base64.decode(pendingSaveB64, Base64.DEFAULT));
                js("HG.onSaveDone(" + ok + ", " + qs(ok ? "已保存到所选位置" : "保存失败") + ");");
            } else if ("pdf".equals(pendingSaveKind)) {
                renderPdf(uri, null, null, pendingPdfHtml);
            }
            pendingSaveKind = null;
            pendingSaveB64 = null;
            pendingPdfName = null;
            pendingPdfHtml = null;
        }
    }

    private boolean writeBytes(Uri uri, byte[] bytes) {
        try {
            OutputStream os = getContentResolver().openOutputStream(uri, "w");
            os.write(bytes);
            os.flush();
            os.close();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /** 存到「下载」目录。Android 10+ 走 MediaStore，免存储权限。 */
    private String savePdfToDownloads(byte[] bytes, String name) throws Exception {
        String safe = name.toLowerCase().endsWith(".pdf") ? name : (name + ".pdf");
        if (Build.VERSION.SDK_INT >= 29) {
            android.content.ContentValues v = new android.content.ContentValues();
            v.put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, safe);
            v.put(android.provider.MediaStore.MediaColumns.MIME_TYPE, "application/pdf");
            v.put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH,
                    android.os.Environment.DIRECTORY_DOWNLOADS + "/华工课程表");
            v.put(android.provider.MediaStore.MediaColumns.IS_PENDING, 1);
            Uri uri = getContentResolver().insert(
                    android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (uri == null) throw new Exception("MediaStore 插入失败");
            OutputStream os = getContentResolver().openOutputStream(uri);
            os.write(bytes);
            os.flush();
            os.close();
            v.clear();
            v.put(android.provider.MediaStore.MediaColumns.IS_PENDING, 0);
            getContentResolver().update(uri, v, null, null);
            return "下载/华工课程表/" + safe;
        }
        File dir = new File(getExternalFilesDir(android.os.Environment.DIRECTORY_DOWNLOADS), "华工课程表");
        if (!dir.exists() && !dir.mkdirs()) throw new Exception("目录创建失败");
        File f = new File(dir, safe);
        FileOutputStream fos = new FileOutputStream(f);
        fos.write(bytes);
        fos.flush();
        fos.close();
        return f.getAbsolutePath();
    }

    /**
     * 用离屏 WebView 渲染打印用 HTML，再绘制到 PdfDocument 上，直接写出 PDF。
     * （不弹系统打印对话框；PrintDocumentAdapter 的回调类构造器是包内可见，
     *   无法在本包内继承，因此采用这种方式。）
     *
     * @param uri       SAF 目标（用户选了保存位置）
     * @param file      直接写文件（分享用，落在 cacheDir）
     * @param shareName 非空则写完后调起系统分享面板
     */
    private void renderPdf(final Uri uri, final File file, final String shareName, final String html) {
        if (html == null) {
            if (shareName != null) toast("没有可导出的内容");
            else js("HG.onSaveDone(false, '没有可导出的内容');");
            return;
        }

        final FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(PX_W, PAGE_H);
        final WebView pv = new WebView(this);
        pv.setLayoutParams(lp);
        pv.setBackgroundColor(Color.WHITE);
        WebSettings ps = pv.getSettings();
        ps.setJavaScriptEnabled(true);
        ps.setAllowFileAccess(true);
        ps.setAllowFileAccessFromFileURLs(true);
        ps.setAllowUniversalAccessFromFileURLs(true);
        pv.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(final WebView v, String url) {
                v.postDelayed(new Runnable() {
                    @Override
                    public void run() {
                        v.evaluateJavascript(
                                "(function(){var b=document.body;var h=Math.max(b?b.scrollHeight:0,document.documentElement.scrollHeight);return String(h);})()",
                                new ValueCallback<String>() {
                                    @Override
                                    public void onReceiveValue(String value) {
                                        int h = PAGE_H;
                                        try {
                                            h = (int) Math.ceil(Double.parseDouble(
                                                    value.replace("\"", "").trim()));
                                        } catch (Exception ignored) { }
                                        if (h < 100) h = PAGE_H;
                                        final int fh = h;
                                        lp.height = fh;
                                        v.setLayoutParams(lp);
                                        v.postDelayed(new Runnable() {
                                            @Override
                                            public void run() {
                                                try {
                                                    writePdf(uri, file, shareName, v, fh);
                                                } catch (Exception e) {
                                                    if (shareName != null) toast("分享失败：" + e.getMessage());
                                                    else js("HG.onSaveDone(false, " + qs("导出异常：" + e.getMessage()) + ");");
                                                } finally {
                                                    try { root.removeView(v); v.destroy(); } catch (Exception ignored) { }
                                                }
                                            }
                                        }, 400);
                                    }
                                });
                    }
                }, 350);
            }
        });

        // 放在最底层，被主界面完全遮住，不会影响用户
        root.addView(pv, 0);
        pv.loadDataWithBaseURL("file:///android_asset/www/", html, "text/html", "utf-8", null);
    }

    private void writePdf(Uri uri, File file, String shareName, WebView pv, int contentH) throws Exception {
        int pages = (int) Math.ceil(contentH / (double) PAGE_H);
        if (pages < 1) pages = 1;
        if (pages > 60) pages = 60;

        PdfDocument doc = new PdfDocument();
        for (int i = 0; i < pages; i++) {
            PdfDocument.PageInfo info = new PdfDocument.PageInfo.Builder(
                    Math.round(PT_W), Math.round(PT_H), i + 1).create();
            PdfDocument.Page page = doc.startPage(info);
            Canvas c = page.getCanvas();
            c.save();
            c.scale(SCALE, SCALE);
            c.translate(0, -i * PAGE_H);
            pv.draw(c);
            c.restore();
            doc.finishPage(page);
        }
        OutputStream os = (uri != null)
                ? getContentResolver().openOutputStream(uri, "w")
                : new FileOutputStream(file);
        doc.writeTo(os);
        doc.close();
        os.flush();
        os.close();

        if (file != null && shareName != null) {
            doShare(file, shareName, pages);
        } else {
            js("HG.onSaveDone(true, " + qs("PDF 已导出（共 " + pages + " 页）") + ");");
        }
    }

    /** 调起系统分享面板 */
    private void doShare(File file, String displayName, int pages) {
        try {
            Uri u = PdfProvider.uriFor(file.getName(), displayName);
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType("application/pdf");
            send.putExtra(Intent.EXTRA_STREAM, u);
            send.putExtra(Intent.EXTRA_SUBJECT, displayName);
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(send, "分享课表（共 " + pages + " 页）");
            chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(chooser);
        } catch (Exception e) {
            toast("分享失败：" + e.getMessage());
        }
    }

    // ================================================================== 崩溃日志

    private static final String CRASH_FILE = "last-crash.txt";

    /** 把未捕获异常的栈写进文件；下次启动时读出来给用户看。 */
    private void installCrashHandler() {
        final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            @Override
            public void uncaughtException(Thread t, Throwable e) {
                try {
                    java.io.StringWriter sw = new java.io.StringWriter();
                    e.printStackTrace(new java.io.PrintWriter(sw));
                    String text = "时间：" + new java.util.Date().toString()
                            + "\n线程：" + t.getName()
                            + "\n版本：" + appVersion()
                            + "\n\n" + sw.toString();
                    FileOutputStream fos = new FileOutputStream(new File(getFilesDir(), CRASH_FILE));
                    fos.write(text.getBytes("UTF-8"));
                    fos.close();
                } catch (Throwable ignored) { }
                if (prev != null) prev.uncaughtException(t, e);
            }
        });
    }

    private String readCrashLog() {
        try {
            File f = new File(getFilesDir(), CRASH_FILE);
            if (!f.exists() || f.length() == 0) return null;
            byte[] buf = new byte[(int) f.length()];
            java.io.FileInputStream in = new java.io.FileInputStream(f);
            int n = in.read(buf);
            in.close();
            return n > 0 ? new String(buf, 0, n, "UTF-8") : null;
        } catch (Throwable e) {
            return null;
        }
    }

    private static String b64ForJs(String text) {
        try {
            return Base64.encodeToString(text.getBytes("UTF-8"), Base64.NO_WRAP);
        } catch (Exception e) {
            return "";
        }
    }

    private void toast(final String msg) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show();
            }
        });
    }

    // ================================================================== 网页导入

    /** 未登录时这个地址会自己 302 到 sso.scut.edu.cn 的 CAS 登录页，直接 loadUrl 就是完整登录流程。 */
    private static final String KB_URL =
            "http://xsjw2018.jw.scut.edu.cn/jwglxt/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N2151&layout=default";

    /** 只是用来减少无谓的预取探测，真正的判据永远是响应体是不是以 %PDF- 开头。 */
    private static final java.util.regex.Pattern PDF_HINT = java.util.regex.Pattern.compile(
            "(?i)pdf|print|dayin|export|dcpj|output|download|jsdy|kbdy|xskbcx|\\bdy\\b");

    /** 静态资源直接跳过，不用白跑一趟探测请求。 */
    private static final java.util.regex.Pattern STATIC_ASSET = java.util.regex.Pattern.compile(
            "(?i)\\.(js|css|png|jpe?g|gif|webp|svg|ico|map|woff2?|ttf|eot)(\\?|#|$)");

    private static final String UA_DEFAULT =
            "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) " +
                    "Chrome/120.0.0.0 Mobile Safari/537.36";

    private View impOverlay = null;
    private WebView webImp = null;
    private TextView impLog = null;
    private final java.util.ArrayDeque<String> impLogLines = new java.util.ArrayDeque<String>();
    private boolean jumpedToKb = false;
    private String lastDisposition = null;
    /** WebView 只能在 UI 线程访问，所以 UA 在创建时缓存一份给后台线程用。 */
    private String uaString = UA_DEFAULT;
    /** 最近一次请求的响应信息，抓不到 PDF 时用来告诉用户到底抓到了什么。 */
    private String lastContentType = null;
    private String lastHead = null;

    /** 网页导入界面上那个诊断面板：失败时用户截个图就知道卡在哪一步。 */
    private void logLine(final String s) {
        Log.i("KcbWebImport", s);
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (impLog == null) return;
                impLogLines.addLast(s);
                while (impLogLines.size() > 4) impLogLines.removeFirst();
                StringBuilder sb = new StringBuilder();
                for (String x : impLogLines) {
                    if (sb.length() > 0) sb.append('\n');
                    sb.append(x);
                }
                impLog.setText(sb.toString());
            }
        });
    }

    private void openWebImport() {
        if (impOverlay == null) impOverlay = buildWebImportOverlay();
        if (impOverlay.getParent() == null) root.addView(impOverlay, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        jumpedToKb = false;
        webImp.loadUrl(KB_URL);
    }

    private View buildWebImportOverlay() {
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setBackgroundColor(0xFFFFFFFF);

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(0xFF1F5FD0);
        int pad = (int) (getResources().getDisplayMetrics().density * 10);
        bar.setPadding(pad, pad, pad / 2, pad);

        TextView tv = new TextView(this);
        tv.setText("登录教务系统后，点页面上的「输出PDF」");
        tv.setTextColor(0xFFFFFFFF);
        tv.setTextSize(13f);
        tv.setLineSpacing(0, 1.15f);
        bar.addView(tv, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        Button btnAuto = new Button(this);
        btnAuto.setText("自动导出");
        btnAuto.setTextSize(12f);
        btnAuto.setTextColor(0xFFFFFFFF);
        btnAuto.setBackgroundColor(0x00000000);
        btnAuto.setPadding(pad, 0, pad, 0);
        btnAuto.setAllCaps(false);
        btnAuto.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                clickExportPdf(webImp);
            }
        });
        bar.addView(btnAuto, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        Button btnBack = new Button(this);
        btnBack.setText("返回");
        btnBack.setTextSize(12f);
        btnBack.setTextColor(0xFFFFFFFF);
        btnBack.setBackgroundColor(0x00000000);
        btnBack.setPadding(pad, 0, 0, 0);
        btnBack.setAllCaps(false);
        btnBack.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (webImp.canGoBack()) webImp.goBack();
            }
        });
        bar.addView(btnBack, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        Button btnClose = new Button(this);
        btnClose.setText("关闭");
        btnClose.setTextSize(12f);
        btnClose.setTextColor(0xFFFFFFFF);
        btnClose.setBackgroundColor(0x00000000);
        btnClose.setPadding(pad, 0, 0, 0);
        btnClose.setAllCaps(false);
        btnClose.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                closeWebImport();
            }
        });
        bar.addView(btnClose, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        col.addView(bar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        webImp = new WebView(this);
        WebSettings s = webImp.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowFileAccessFromFileURLs(true);
        s.setUserAgentString((s.getUserAgentString() == null ? UA_DEFAULT : s.getUserAgentString()));
        uaString = s.getUserAgentString() == null ? UA_DEFAULT : s.getUserAgentString();
        if (Build.VERSION.SDK_INT >= 21) {
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
        webImp.setBackgroundColor(Color.WHITE);
        webImp.addJavascriptInterface(new WebBridge(), "KcbBridge");
        // 用基类的 WebChromeClient，让页面里的 alert/confirm（隐私协议之类）能正常弹出来
        webImp.setWebChromeClient(new WebChromeClient());

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= 21) cm.setAcceptThirdPartyCookies(webImp, true);

        webImp.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return false;   // 所有跳转都留在 WebView 里，包括 CAS 那一串
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                boolean onJwglxt = url.contains("jwglxt") && !url.contains("sso.scut.edu.cn");
                logLine(onJwglxt ? ("✔ 已进入教务系统") : ("… 跳转中（登录页/认证）"));
                if (!onJwglxt) return;
                injectHook(view);   // 每次页面加载 JS 上下文都会重置，所以每次都要重新装探针
                if (!url.contains("xskbcx") && !jumpedToKb) {
                    jumpedToKb = true;
                    view.loadUrl(KB_URL);
                }
            }

            /**
             * 直接截获：如果「输出PDF」是请求一个服务端生成的 pdf 地址，
             * 这里自己带 Cookie 拉一遍，确认是 PDF 就交给 App 导入。
             * 只对 GET 预取：POST 重放可能有副作用（重复生成、重复写库）。
             */
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                try {
                    String url = req.getUrl().toString();
                    if (!"GET".equalsIgnoreCase(req.getMethod())) return null;
                    if (STATIC_ASSET.matcher(url).find()) return null;
                    // 主框架导航（输出PDF 常见形态）一律探测；子请求只有命中关键词才探测
                    boolean isMain = req.isForMainFrame();
                    if (!isMain && !PDF_HINT.matcher(url).find()) return null;

                    byte[] bytes = httpGetBytes(url);
                    if (bytes != null && isPdf(bytes)) {
                        logLine("✅ 截获成功 " + bytes.length + " 字节");
                        deliverPdf(bytes, nameFromDisposition(lastDisposition));
                        // 关键：绝不能把 PDF 字节回给 WebView —— Android WebView 不会渲染 PDF，
                        // 主框架拿到 application/pdf 会走系统下载逻辑，实测会直接崩。
                        // 主框架给一个结果页，子请求直接返回 null（数据已经拿到了，不影响导入）。
                        if (isMain) return htmlResponse(importedNotice(bytes.length));
                        return null;
                    }
                    if (isMain) {
                        logLine("· 主页面不是 PDF：" + (lastContentType == null ? "无类型" : lastContentType));
                    }
                } catch (Throwable e) {
                    logLine("⚠ 探测异常 " + e.getClass().getSimpleName());
                    Log.w("KcbWebImport", "intercept probe failed", e);
                }
                return null;
            }
        });

        // 兜底：PDF 以「下载」方式触发时会走这里。
        // 绝不能交给系统下载器——它不带教务的 Cookie，只会下到一个登录页 HTML。
        // 注意：onDownloadStart 是在主线程回调的，这里必须异步抓，
        // 否则 HttpURLConnection 会抛 NetworkOnMainThreadException。
        webImp.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition,
                                        String mimetype, long contentLength) {
                logLine("⤓ 页面触发了下载，后台抓取中");
                fetchAndSave(url);
            }
        });

        col.addView(webImp, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        // 底部诊断条：把探测过程显示出来，失败时截图即可定位
        impLog = new TextView(this);
        impLog.setText("等待登录…抓到 PDF 后会自动导入");
        impLog.setTextColor(0xFFB8C4D8);
        impLog.setTextSize(10.5f);
        impLog.setBackgroundColor(0xFF22262E);
        impLog.setPadding(pad, pad / 2, pad, pad / 2);
        impLog.setMaxLines(4);
        col.addView(impLog, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        return col;
    }

    private void closeWebImport() {
        try {
            if (impOverlay != null && impOverlay.getParent() != null) {
                root.removeView(impOverlay);
            }
            // 不调 webImp.loadUrl("about:blank")：在 WebView 自己的加载流程里再触发一次
            // 导航是重入操作，容易崩。直接 stopLoading 就够了。
            if (webImp != null) webImp.stopLoading();
        } catch (Throwable e) {
            Log.w("KcbWebImport", "closeWebImport failed", e);
        }
    }

    /** 给 WebView 的回一个简单结果页（不要回 PDF 字节）。 */
    private WebResourceResponse htmlResponse(String html) {
        return new WebResourceResponse("text/html", "utf-8", 200, "OK",
                java.util.Collections.<String, String>emptyMap(),
                new java.io.ByteArrayInputStream(html.getBytes(java.nio.charset.Charset.forName("UTF-8"))));
    }

    private String importedNotice(int bytes) {
        return "<!doctype html><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
                "<body style=\"font-family:-apple-system,sans-serif;padding:40px 24px;text-align:center;color:#1B1F26\">" +
                "<div style=\"font-size:44px\">✅</div>" +
                "<h3 style=\"margin:12px 0 6px\">课表 PDF 已抓到</h3>" +
                "<p style=\"color:#6B7280;font-size:14px\">" + (bytes / 1024 + 1) + " KB，正在导入到 App…</p>" +
                "</body>";
    }

    private void injectHook(WebView view) {
        try {
            InputStream in = getAssets().open("capture-hook.js");
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            in.close();
            view.evaluateJavascript(new String(bos.toByteArray(), "UTF-8"), null);
        } catch (Exception e) {
            Log.w("KcbWebImport", "capture-hook.js missing", e);
        }
    }

    /** 自动点页面上的「输出PDF」；页面改版后按钮文字变了就调这里。 */
    private void clickExportPdf(WebView view) {
        if (view == null) return;
        view.evaluateJavascript(
                "(function(){var n=document.querySelectorAll('a,button,input,span,div');" +
                        "for(var i=0;i<n.length;i++){var t=(n[i].textContent||n[i].value||'').trim();" +
                        "if(/输出\\s*PDF|导出\\s*PDF|打印\\s*PDF/i.test(t)){n[i].click();return t;}}" +
                        "return '未找到输出PDF按钮';})()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String r) {
                        if (r != null && r.contains("未找到")) {
                            toast("没找到「输出PDF」按钮，请手动点一下");
                        }
                    }
                });
    }

    /** 带 Cookie 自己把地址拉一遍（GET 或 POST）。shouldInterceptRequest 在后台线程，同步请求是安全的。 */
    private byte[] httpGetBytes(String url) throws Exception {
        return httpFetch(url, "GET", null, null);
    }

    private byte[] httpFetch(String url, String method, String body, String contentType) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new java.net.URL(url).openConnection();
        c.setInstanceFollowRedirects(true);
        c.setConnectTimeout(20000);
        c.setReadTimeout(60000);
        // 注意：不能用 webImp.getSettings()，这个方法可能在后台线程被调用，
        // 而 WebView 的所有方法都必须在 UI 线程上，否则会抛
        // "A WebView method was called on thread ..." 直接崩。所以 UA 提前缓存好。
        c.setRequestProperty("User-Agent", uaString);
        String cookie = CookieManager.getInstance().getCookie(url);
        if (cookie != null) c.setRequestProperty("Cookie", cookie);

        boolean post = method != null && !"GET".equalsIgnoreCase(method)
                && body != null && !body.isEmpty();
        if (post) {
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            if (contentType == null || contentType.isEmpty()) {
                contentType = "application/x-www-form-urlencoded";
            }
            c.setRequestProperty("Content-Type", contentType);
            byte[] bb = body.getBytes("UTF-8");
            c.setRequestProperty("Content-Length", String.valueOf(bb.length));
            OutputStream os = c.getOutputStream();
            os.write(bb);
            os.flush();
            os.close();
        }

        c.connect();
        int code = c.getResponseCode();
        InputStream in = (code >= 200 && code < 300) ? c.getInputStream() : c.getErrorStream();
        lastDisposition = c.getHeaderField("Content-Disposition");
        lastContentType = c.getContentType();
        if (in == null) {
            c.disconnect();
            return null;
        }
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
        in.close();
        c.disconnect();
        byte[] out = bos.toByteArray();
        StringBuilder head = new StringBuilder();
        for (int i = 0; i < Math.min(20, out.length); i++) {
            char ch = (char) (out[i] & 0xff);
            head.append(ch >= 32 && ch < 127 ? ch : '.');
        }
        lastHead = head.toString();
        return out;
    }

    /** 所有 PDF 都以 %PDF- 开头，用这个当唯一判据，别信 Content-Type。 */
    private static boolean isPdf(byte[] b) {
        return b != null && b.length > 5
                && b[0] == 0x25 && b[1] == 0x50 && b[2] == 0x44 && b[3] == 0x46 && b[4] == 0x2D;
    }

    private static String nameFromDisposition(String cd) {
        if (cd != null) {
            java.util.regex.Matcher m1 =
                    java.util.regex.Pattern.compile("filename\\*=UTF-8''([^;]+)").matcher(cd);
            if (m1.find()) return Uri.decode(m1.group(1).trim());
            java.util.regex.Matcher m2 =
                    java.util.regex.Pattern.compile("filename=\"?([^\";]+)\"?").matcher(cd);
            if (m2.find()) return m2.group(1).trim();
        }
        return "教务系统课表.pdf";
    }

    /** 拿到 PDF：交给 App 解析导入，然后关掉网页。 */
    private long lastDeliverAt = 0;

    private void deliverPdf(final byte[] bytes, final String name) {
        long now = System.currentTimeMillis();
        if (now - lastDeliverAt < 3000) return;    // 三条截获路径可能同时命中，去重
        lastDeliverAt = now;

        final String b64 = Base64.encodeToString(bytes, Base64.NO_WRAP);
        logLine("📥 交给 App 解析（" + (bytes.length / 1024 + 1) + " KB）");

        // 先把数据交给 JS；关闭 WebView 一定要延后，
        // 否则可能在 WebView 自己的请求回调栈里把自己销毁掉。
        js("HG.onWebPdf('" + b64 + "', " + qs(name) + ");");
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                toast("已抓到课表 PDF，正在导入…");
                if (root != null) {
                    root.postDelayed(new Runnable() {
                        @Override
                        public void run() {
                            closeWebImport();
                        }
                    }, 600);
                }
            }
        });
    }

    private class WebBridge {
        @JavascriptInterface
        public void onNet(String url, String note) {
            Log.i("KcbWebImport", "net: " + url + "   [" + note + "]");
        }

        /**
         * 页面拿到了 PDF 响应但给不出二进制（responseType 是 text 之类），
         * 由原生按**相同的 method + body** 重放一次。
         * 这条很关键：正方「输出PDF」可能是 POST，用 GET 重放只会拿到错误页。
         */
        @JavascriptInterface
        public void onPdfUrl(String url, String method, String body, String contentType) {
            replayFetch(url, method, body, contentType);
        }

        @JavascriptInterface
        public void onBlob(String base64, int size) {
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                if (isPdf(bytes)) {
                    logLine("✅ 页面本地生成的 PDF " + bytes.length + " 字节");
                    deliverPdf(bytes, "教务系统课表.pdf");
                }
            } catch (Exception e) {
                Log.w("KcbWebImport", "blob decode failed", e);
            }
        }
    }

    /** 按页面原来的 method + body 重放一次，是 PDF 就导入。 */
    private void replayFetch(final String url, final String method, final String body, final String ct) {
        if (url == null || url.isEmpty()) return;
        String low = url.toLowerCase();
        if (low.startsWith("blob:") || low.startsWith("data:") || low.startsWith("javascript:")) return;
        logLine("↘ 重放 " + method + " " + shortUrl(url));
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    byte[] bytes = httpFetch(url, method == null ? "GET" : method, body, ct);
                    if (bytes != null && isPdf(bytes)) {
                        deliverPdf(bytes, nameFromDisposition(lastDisposition));
                    } else {
                        logLine("✗ 重放回来的不是 PDF：" + (lastContentType == null ? "无类型" : lastContentType)
                                + " 开头「" + (lastHead == null ? "" : lastHead) + "」");
                    }
                } catch (Throwable e) {
                    logLine("✗ 重放失败 " + e.getClass().getSimpleName());
                }
            }
        }).start();
    }

    private void fetchAndSave(String url) {
        replayFetch(url, "GET", null, null);
    }

    private static String shortUrl(String u) {
        if (u == null) return "";
        int i = u.indexOf("/jwglxt");
        String s = (i >= 0) ? u.substring(i) : u;
        return s.length() > 58 ? s.substring(0, 58) + "…" : s;
    }

    private void js(final String code) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (web != null) web.evaluateJavascript(code, null);
            }
        });
    }

    private static String safe(String s) {
        if (s == null) return "";
        return s.replace("\\", "").replace("'", "").replace("\n", " ").replace("\r", " ");
    }

    private static String qs(String s) {
        if (s == null) return "''";
        return "'" + s.replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ") + "'";
    }

    // ------------------------------------------------------------------ JS 桥

    public class Bridge {

        @JavascriptInterface
        public String platform() {
            return "android";
        }

        @JavascriptInterface
        public void schedule(String json, String imgs) {
            applySchedule(json, imgs);
        }

        /** 外部链接（GitHub / 网盘 / 邮箱）交给系统里对应的 App 打开 */
        @JavascriptInterface
        public void openUrl(String url) {
            final String u = (url == null) ? "" : url.trim();
            if (u.isEmpty()) return;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(u)));
            } catch (Exception e) {
                toast("没有能打开这个链接的应用");
            }
        }

        @JavascriptInterface
        public void cancelAll() {
            applySchedule("{}", "{}");
        }

        @JavascriptInterface
        public boolean canExactAlarm() {
            return canExact();
        }

        @JavascriptInterface
        public void openExactAlarmSettings() {
            try {
                Intent i;
                if (Build.VERSION.SDK_INT >= 31) {
                    i = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
                            Uri.parse("package:" + getPackageName()));
                } else {
                    i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.parse("package:" + getPackageName()));
                }
                startActivity(i);
            } catch (Exception e) {
                toast("无法打开系统设置，请手动开启");
            }
        }

        @JavascriptInterface
        public boolean hasNotifPermission() {
            if (Build.VERSION.SDK_INT < 33) return true;
            return checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                    == PackageManager.PERMISSION_GRANTED;
        }

        @JavascriptInterface
        public void requestNotifPermission() {
            if (Build.VERSION.SDK_INT >= 33 && !hasNotifPermission()) {
                requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, REQ_NOTIF);
            } else {
                openNotificationSettings();
            }
        }

        @JavascriptInterface
        public void openNotificationSettings() {
            try {
                Intent i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                i.putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
                startActivity(i);
            } catch (Exception e) {
                toast("请到系统设置中开启通知");
            }
        }

        @JavascriptInterface
        public void pickFile(String token, String mime) {
            pickToken = token;
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType(mime == null || mime.isEmpty() ? "*/*" : mime);
            try {
                startActivityForResult(i, REQ_OPEN);
            } catch (Exception e) {
                js("HG.onFileData('" + safe(token) + "', null, '无法打开文件选择器');");
            }
        }

        /** 备注附件：写到缓存目录，再交给系统里能打开它的 App（图片、PDF、Word 各找各的）。 */
        @JavascriptInterface
        public void openFile(String name, String mime, String b64) {
            try {
                File[] old = getCacheDir().listFiles();
                if (old != null) for (File o : old) if (o.getName().startsWith("att_")) o.delete();

                String ext = "";
                int dot = (name == null) ? -1 : name.lastIndexOf('.');
                if (dot > 0) ext = name.substring(dot).replaceAll("[^A-Za-z0-9.]", "");
                File f = new File(getCacheDir(), "att_" + System.currentTimeMillis() + ext);
                FileOutputStream out = new FileOutputStream(f);
                out.write(Base64.decode(b64, Base64.DEFAULT));
                out.flush();
                out.close();

                String type = (mime == null || mime.isEmpty()) ? "*/*" : mime;
                Intent i = new Intent(Intent.ACTION_VIEW);
                i.setDataAndType(PdfProvider.uriFor(f.getName(), name, type), type);
                i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(i);
            } catch (Exception e) {
                toast("没有能打开这个文件的应用");
            }
        }

        @JavascriptInterface
        public void saveBase64(String name, String mime, String b64) {
            pendingSaveKind = "json";
            pendingSaveB64 = b64;
            Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
            i.putExtra(Intent.EXTRA_TITLE, name);
            startActivityForResult(i, REQ_CREATE);
        }

        @JavascriptInterface
        public void exportPdf(String name, String html) {
            pendingSaveKind = "pdf";
            pendingPdfName = name;
            pendingPdfHtml = html;
            Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("application/pdf");
            i.putExtra(Intent.EXTRA_TITLE, name);
            startActivityForResult(i, REQ_CREATE);
        }

        /** 渲染后直接调起系统分享面板，不弹保存对话框 */
        @JavascriptInterface
        public void sharePdf(String displayName, String html) {
            if (html == null || html.isEmpty()) { toast("没有可分享的内容"); return; }
            File f = new File(getCacheDir(), "kcb-share.pdf");
            renderPdf(null, f, displayName == null ? "课表.pdf" : displayName, html);
        }

        /** 打开教务系统课表页，由用户在网页里登录并点「输出PDF」，我们负责截获。 */
        @JavascriptInterface
        public void webImport() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    openWebImport();
                }
            });
        }

        /** 解析失败时把原始 PDF 存到「下载」目录，方便发给开发者排查格式差异。 */
        @JavascriptInterface
        public void saveRawPdf(String name, String b64) {
            final String fn = (name == null || name.isEmpty()) ? "课表原始.pdf" : name;
            try {
                byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
                String where = savePdfToDownloads(bytes, fn);
                toast("原始 PDF 已存到：" + where);
            } catch (Exception e) {
                toast("保存失败：" + e.getMessage());
            }
        }

        /** 把崩溃日志存到「下载」目录，方便发给开发者。 */
        @JavascriptInterface
        public void saveCrashLog() {
            try {
                String log = readCrashLog();
                if (log == null) { toast("没有崩溃日志"); return; }
                String where = savePdfToDownloads(log.getBytes("UTF-8"),
                        "崩溃日志-" + System.currentTimeMillis() + ".txt");
                toast("已存到：" + where);
            } catch (Exception e) {
                toast("保存失败：" + e.getMessage());
            }
        }

        @JavascriptInterface
        public void clearCrashLog() {
            try {
                File f = new File(getFilesDir(), CRASH_FILE);
                if (f.exists()) f.delete();
            } catch (Throwable ignored) { }
        }

        @JavascriptInterface
        public void toast(String msg) {
            MainActivity.this.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public void vibrate(int ms) {
            try {
                Vibrator v = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
                if (v == null || !v.hasVibrator()) return;
                if (Build.VERSION.SDK_INT >= 26) {
                    v.vibrate(VibrationEffect.createOneShot(ms, VibrationEffect.DEFAULT_AMPLITUDE));
                } else {
                    v.vibrate(ms);
                }
            } catch (Exception ignored) { }
        }

        @JavascriptInterface
        public String info() {
            JSONObject o = new JSONObject();
            try {
                o.put("sdk", Build.VERSION.SDK_INT);
                o.put("model", Build.MODEL);
                o.put("ver", "1.0.0");
            } catch (Exception ignored) { }
            return o.toString();
        }
    }
}
