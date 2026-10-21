package st.tk.magi;

import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.PickVisualMediaRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** 共有intentとウィジェットのカメラ・アルバムの受取、上限付き・Cookieなしの資料取得。本文をログへ書かない。 */
@CapacitorPlugin(name = "MagiShare")
public class MagiSharePlugin extends Plugin {
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final ArrayDeque<JSObject> pending = new ArrayDeque<>();
    private final MagiArticleReader articles = new MagiArticleReader();
    private static final int IMAGE_LIMIT = 20 * 1024 * 1024;
    private ActivityResultLauncher<Uri> camera;
    private ActivityResultLauncher<PickVisualMediaRequest> album;
    private File photo;

    @Override public void load() {
        File folder = new File(getContext().getCacheDir(), "magi-incoming");
        File[] old = folder.listFiles();
        if (old != null) for (File file : old) if (file.getName().startsWith("shared-") && System.currentTimeMillis() - file.lastModified() > 86400000L) file.delete();
        // Capacitor 8のBridgeActivity.loadが初回intentもonNewIntentへ渡す。
        // ここでも受けると、起動時だけ同じ共有を2回取り込んでしまう。
        // 画面のJavaScriptは利用者の操作なしにファイル選択を開けないので、ウィジェットのカメラ・アルバムはここで開く。
        // 結果は共有された画像と同じ経路で画面へ渡し、新しい会話に添付する（送信はしない）。
        camera = getActivity().registerForActivityResult(new ActivityResultContracts.TakePicture(), saved -> {
            File file = photo; photo = null;
            if (file == null) return;
            if (!Boolean.TRUE.equals(saved) || file.length() == 0) { file.delete(); return; }
            JSObject payload = new JSObject(); JSArray images = new JSArray(); JSObject image = new JSObject();
            image.put("path", file.getAbsolutePath()); image.put("type", "image/jpeg"); images.put(image);
            payload.put("text", ""); payload.put("images", images); payload.put("truncated", false);
            offer(payload);
        });
        album = getActivity().registerForActivityResult(new ActivityResultContracts.PickMultipleVisualMedia(4), uris -> {
            if (uris != null && !uris.isEmpty()) io.execute(() -> copy("", new ArrayList<>(uris)));
        });
    }
    @Override protected void handleOnNewIntent(Intent intent) {
        Uri link = intent == null ? null : intent.getData();
        if (Intent.ACTION_VIEW.equals(intent == null ? null : intent.getAction()) && link != null && "magi".equals(link.getScheme())) pick(link.getHost());
        else receive(intent);
    }

    private void pick(String source) {
        try {
            if ("camera".equals(source)) {
                File folder = new File(getContext().getCacheDir(), "magi-incoming"); folder.mkdirs();
                if (photo != null) photo.delete();
                photo = File.createTempFile("shared-", ".jpg", folder);
                camera.launch(FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", photo));
            } else if ("album".equals(source)) {
                album.launch(new PickVisualMediaRequest.Builder().setMediaType(ActivityResultContracts.PickVisualMedia.ImageOnly.INSTANCE).build());
            }
        } catch (Exception ignored) { if (photo != null) { photo.delete(); photo = null; } }
    }

    @SuppressWarnings("deprecation")
    private void receive(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction(), type = intent.getType();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return;
        if (type == null || !(type.equals("text/plain") || type.startsWith("image/"))) return;
        // URIの読取許可がある間にキャッシュへ写す。準備前の画面にはqueueをtakeShareで渡す。
        io.execute(() -> {
            CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
            ArrayList<Uri> uris = new ArrayList<>();
            if (type.startsWith("image/")) {
                if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
                    ArrayList<Uri> supplied = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                    if (supplied != null) uris.addAll(supplied);
                } else {
                    Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                    if (uri != null) uris.add(uri);
                }
                if (uris.isEmpty() && intent.getClipData() != null) {
                    for (int i = 0; i < intent.getClipData().getItemCount(); i++) {
                        Uri uri = intent.getClipData().getItemAt(i).getUri(); if (uri != null) uris.add(uri);
                    }
                }
            }
            copy(text == null ? "" : text.toString().substring(0, Math.min(text.length(), 12000)), uris);
        });
    }

    // URIの読取許可がある間にキャッシュへ写し、画面へ渡す列に加える。
    private void copy(String text, List<Uri> uris) {
        JSObject payload = new JSObject(); payload.put("text", text);
        JSArray images = new JSArray();
        File folder = new File(getContext().getCacheDir(), "magi-incoming");
        folder.mkdirs();
        for (int i = 0; i < Math.min(4, uris.size()); i++) {
            Uri uri = uris.get(i);
            if (!"content".equals(uri.getScheme())) continue;
            File target = null;
            try {
                String mime = getContext().getContentResolver().getType(uri);
                if (mime == null || !mime.startsWith("image/")) continue;
                target = File.createTempFile("shared-", ".image", folder);
                try (InputStream input = getContext().getContentResolver().openInputStream(uri);
                     FileOutputStream output = new FileOutputStream(target)) {
                    byte[] buffer = new byte[8192]; int total = 0, n;
                    while ((n = input.read(buffer)) != -1) {
                        total += n; if (total > IMAGE_LIMIT) throw new IllegalArgumentException("image_too_large");
                        output.write(buffer, 0, n);
                    }
                }
                JSObject image = new JSObject(); image.put("path", target.getAbsolutePath()); image.put("type", mime); images.put(image);
            } catch (Exception ignored) { if (target != null) target.delete(); payload.put("imageError", true); }
        }
        payload.put("images", images); payload.put("truncated", uris.size() > 4);
        offer(payload);
    }
    private void offer(JSObject payload) {
        synchronized (pending) {
            if (pending.size() >= 8) { discard(payload); return; }
            pending.add(payload);
        }
        notifyListeners("shareAvailable", new JSObject(), true);
    }

    @PluginMethod public void takeShare(PluginCall call) {
        JSObject result = new JSObject();
        synchronized (pending) { result.put("share", pending.poll()); }
        call.resolve(result);
    }

    private void discard(JSObject payload) {
        try {
            org.json.JSONArray images = payload.getJSONArray("images");
            for (int i = 0; i < images.length(); i++) new File(images.getJSONObject(i).getString("path")).delete();
        } catch (Exception ignored) { }
    }
    @PluginMethod public void releaseShare(PluginCall call) {
        // JSへ渡した一時画像だけを消せる。任意のファイルパスは受け付けない。
        try {
            JSArray paths = call.getArray("paths", new JSArray());
            File root = new File(getContext().getCacheDir(), "magi-incoming").getCanonicalFile();
            for (int i = 0; i < paths.length(); i++) {
                File file = new File(paths.getString(i)).getCanonicalFile();
                if (root.equals(file.getParentFile()) && file.getName().startsWith("shared-")) file.delete();
            }
            call.resolve();
        } catch (Exception ignored) { call.reject("share_cleanup_failed"); }
    }

    @PluginMethod public void getArticle(PluginCall call) {
        io.execute(() -> {
            try {
                MagiArticleReader.Document doc = articles.read(call.getString("url", ""));
                JSObject result = new JSObject(); result.put("url", doc.url); result.put("contentType", doc.contentType);
                result.put("base64", Base64.encodeToString(doc.bytes, Base64.NO_WRAP)); call.resolve(result);
            } catch (Exception ignored) { call.reject("article_unavailable"); }
        });
    }
    @Override protected void handleOnDestroy() {
        io.shutdownNow(); articles.close();
        synchronized (pending) { for (JSObject payload : pending) discard(payload); pending.clear(); }
    }
}
