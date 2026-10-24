package st.tk.magi;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import androidx.core.content.pm.PackageInfoCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Pattern;
import okhttp3.CookieJar;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/**
 * ☰の「アップデートの確認…」から、公開ReleaseのAPKを落としてAndroidのインストーラーへ渡す。
 * 取得先はこのリポジトリのRelease固定で、画面から受け取るのは版とSHA-256だけ（URLは受け取らない）。
 * SHA-256・パッケージ名・署名・versionCodeがすべて合ったときだけインストーラーを開く。
 */
@CapacitorPlugin(name = "MagiUpdate")
public class MagiUpdatePlugin extends Plugin {
    static final long LIMIT = 64L * 1024 * 1024;
    private static final String RELEASES = "https://github.com/tk33r1/st/releases/download/";
    private static final Pattern VERSION = Pattern.compile("\\d{1,2}\\.\\d");
    private static final Pattern SHA256 = Pattern.compile("[0-9a-f]{64}");
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final AtomicBoolean busy = new AtomicBoolean();
    private final OkHttpClient http = new OkHttpClient.Builder().cookieJar(CookieJar.NO_COOKIES).followRedirects(false).followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).callTimeout(5, TimeUnit.MINUTES).build();

    // 入れ終わった版・壊れた分は起動時に消す。許可の画面から戻る間にアプリが落ちた分は、新しい版なら残して次の押下で使い回す。
    @Override public void load() {
        io.execute(() -> {
            File apk = file();
            try { if (apk.exists() && verify(apk) != null) apk.delete(); } catch (Exception e) { apk.delete(); }
            new File(apk.getPath() + ".part").delete();
        });
    }

    @PluginMethod public void install(PluginCall call) {
        String version = call.getString("version", ""), sha256 = call.getString("sha256", "");
        if (!VERSION.matcher(version).matches() || !SHA256.matcher(sha256).matches()) { call.reject("invalid_release"); return; }
        if (!busy.compareAndSet(false, true)) { call.reject("busy"); return; }
        io.execute(() -> {
            File apk = file();
            try {
                if (!sha256.equals(digest(apk))) download(HttpUrl.get(RELEASES + "v" + version + "/magi-android.apk"), apk, sha256);
                String problem = verify(apk);
                if (problem != null) { apk.delete(); fail(call, problem); return; }
                getActivity().runOnUiThread(() -> open(call, apk));
            } catch (Exception e) { apk.delete(); fail(call, "download_failed"); }
        });
    }

    private File file() {
        File dir = new File(getContext().getCacheDir(), "update");
        dir.mkdirs();
        return new File(dir, "magi-update.apk");
    }

    // GitHubの配布URLは1〜2回リダイレクトする。https のまま github.com と *.githubusercontent.com の中だけをたどる。
    private void download(HttpUrl url, File apk, String sha256) throws Exception {
        File part = new File(apk.getPath() + ".part");
        for (int redirects = 0; ; redirects++) {
            if (!url.isHttps() || !(url.host().equals("github.com") || url.host().endsWith(".githubusercontent.com"))) throw new IllegalArgumentException();
            try (Response response = http.newCall(new Request.Builder().url(url).header("Accept", "application/octet-stream").build()).execute()) {
                if (response.isRedirect()) {
                    String location = response.header("Location");
                    HttpUrl next = location == null ? null : url.resolve(location);
                    if (redirects >= 3 || next == null) throw new IllegalArgumentException();
                    url = next; continue;
                }
                long total = response.body() == null ? -1 : response.body().contentLength();
                if (!response.isSuccessful() || response.body() == null || total > LIMIT) throw new IllegalArgumentException();
                MessageDigest hash = MessageDigest.getInstance("SHA-256");
                long received = 0, reported = 0;
                try (InputStream in = response.body().byteStream(); OutputStream out = new FileOutputStream(part)) {
                    byte[] buffer = new byte[65536]; int n;
                    while ((n = in.read(buffer)) != -1) {
                        received += n;
                        if (received > LIMIT) throw new IllegalArgumentException();
                        hash.update(buffer, 0, n); out.write(buffer, 0, n);
                        if (received - reported >= 262144) { reported = received; progress(received, total); }
                    }
                }
                progress(received, total);
                if (!sha256.equals(hex(hash.digest())) || !part.renameTo(apk)) { part.delete(); throw new IllegalArgumentException(); }
                return;
            }
        }
    }

    private String verify(File apk) throws Exception {
        PackageManager pm = getContext().getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo next = pm.getPackageArchiveInfo(apk.getPath(), flags);
        PackageInfo installed = pm.getPackageInfo(getContext().getPackageName(), flags);
        if (next == null || !installed.packageName.equals(next.packageName)) return "package_mismatch";
        if (PackageInfoCompat.getLongVersionCode(next) <= PackageInfoCompat.getLongVersionCode(installed)) return "not_newer";
        Set<String> mine = signers(installed);
        if (mine.isEmpty() || !mine.equals(signers(next))) return "signature_mismatch";
        return null;
    }

    private static Set<String> signers(PackageInfo info) throws Exception {
        Signature[] list = Build.VERSION.SDK_INT >= 28 ? (info.signingInfo == null ? null : info.signingInfo.getApkContentsSigners()) : info.signatures;
        Set<String> out = new HashSet<>();
        if (list != null) for (Signature signature : list) out.add(hex(MessageDigest.getInstance("SHA-256").digest(signature.toByteArray())));
        return out;
    }

    // 初回は「この提供元のアプリを許可」の画面を開く。戻ったときに許可されていれば、そのままインストーラーへ進む。
    private void open(PluginCall call, File apk) {
        if (canInstall()) { launch(call, apk); return; }
        JSObject state = new JSObject(); state.put("phase", "permission");
        notifyListeners("progress", state);
        startActivityForResult(call, new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName())), "permissionResult");
    }
    @ActivityCallback private void permissionResult(PluginCall call, ActivityResult result) {
        if (call == null) { busy.set(false); return; }
        if (canInstall()) launch(call, file()); else finish(call, "denied");
        getBridge().releaseCall(call);
    }
    private boolean canInstall() { return Build.VERSION.SDK_INT < 26 || getContext().getPackageManager().canRequestPackageInstalls(); }

    private void launch(PluginCall call, File apk) {
        if (!apk.exists()) { fail(call, "download_failed"); return; }
        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
        Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try { getContext().startActivity(intent); finish(call, "installer"); }
        catch (ActivityNotFoundException e) { fail(call, "installer_unavailable"); }
    }

    private void progress(long received, long total) {
        JSObject data = new JSObject();
        data.put("phase", "download"); data.put("received", received); data.put("total", total);
        notifyListeners("progress", data);
    }
    private void finish(PluginCall call, String state) {
        busy.set(false);
        JSObject data = new JSObject(); data.put("state", state); call.resolve(data);
    }
    private void fail(PluginCall call, String code) { busy.set(false); call.reject(code, code); }

    private static String digest(File file) {
        if (!file.isFile()) return "";
        try (InputStream in = new FileInputStream(file)) {
            MessageDigest hash = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[65536]; int n;
            while ((n = in.read(buffer)) != -1) hash.update(buffer, 0, n);
            return hex(hash.digest());
        } catch (Exception e) { return ""; }
    }
    private static String hex(byte[] bytes) {
        StringBuilder out = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) out.append(String.format(Locale.ROOT, "%02x", b & 255));
        return out.toString();
    }
}
