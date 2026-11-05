package com.dayleestatcardz.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Iterator;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * DayleeStatCardz — shows the bundled app (assets/index.html) full screen and
 * gives it a safe "NativeHttp" bridge so it can talk to the data servers
 * directly from the phone. Only the two data-server hosts are allowed.
 */
public class MainActivity extends Activity {

    private static final String[] ALLOWED_HOSTS = { "api.pitchapi.dev", "api.football-data.org" };

    private WebView web;
    private final ExecutorService pool = Executors.newFixedThreadPool(6);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#050706"));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setTextZoom(100);

        web.addJavascriptInterface(new Bridge(), "NativeHttp");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                String scheme = u.getScheme();
                if ("http".equals(scheme) || "https".equals(scheme)) {
                    // Open web links (e.g. "get a free key") in the phone's browser.
                    try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                    return true;
                }
                return false;
            }
        });

        web.loadUrl("file:///android_asset/index.html");
        setContentView(web);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        pool.shutdownNow();
        if (web != null) { web.destroy(); web = null; }
        super.onDestroy();
    }

    /** Called from JavaScript: NativeHttp.request(id, url, headersJson). Answer comes back via window.__nativeHttpDone. */
    public class Bridge {
        @JavascriptInterface
        public void request(final String id, final String url, final String headersJson) {
            pool.execute(new Runnable() {
                @Override
                public void run() {
                    final String result = fetch(url, headersJson);
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            if (web != null) {
                                web.evaluateJavascript("window.__nativeHttpDone(" + JSONObject.quote(id) + "," + JSONObject.quote(result) + ")", null);
                            }
                        }
                    });
                }
            });
        }
    }

    private static boolean allowed(String host) {
        for (String h : ALLOWED_HOSTS) if (h.equalsIgnoreCase(host)) return true;
        return false;
    }

    private static String fetch(String url, String headersJson) {
        JSONObject out = new JSONObject();
        HttpURLConnection c = null;
        try {
            URL u = new URL(url);
            if (!"https".equals(u.getProtocol()) || !allowed(u.getHost())) {
                out.put("status", 0);
                out.put("error", "Blocked: not a data server");
                return out.toString();
            }
            c = (HttpURLConnection) u.openConnection();
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            c.setRequestProperty("Accept", "application/json");
            c.setRequestProperty("User-Agent", "DayleeStatCardz-Android/1.0");
            JSONObject h = new JSONObject(headersJson == null || headersJson.isEmpty() ? "{}" : headersJson);
            Iterator<String> keys = h.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                c.setRequestProperty(k, h.getString(k));
            }
            int code = c.getResponseCode();
            InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
            String body = "";
            if (in != null) {
                ByteArrayOutputStream bo = new ByteArrayOutputStream();
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) != -1) bo.write(buf, 0, n);
                in.close();
                body = bo.toString("UTF-8");
            }
            out.put("status", code);
            out.put("body", body);
            String ra = c.getHeaderField("Retry-After");
            if (ra == null) ra = c.getHeaderField("X-RequestCounter-Reset");
            if (ra != null) out.put("retryAfter", ra);
        } catch (Exception e) {
            try {
                out.put("status", 0);
                out.put("error", String.valueOf(e.getMessage()));
            } catch (JSONException ignored) { }
        } finally {
            if (c != null) c.disconnect();
        }
        return out.toString();
    }
}
