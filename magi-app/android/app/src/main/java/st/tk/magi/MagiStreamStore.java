package st.tk.magi;

import android.content.Context;
import android.util.AtomicFile;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.function.Supplier;

/** B1の会話JSONと書き手を分け、受信列は画面への取り込みが確定するまで保持する。 */
final class MagiStreamStore {
    private static final Object LOCK = new Object();
    private final File root;
    MagiStreamStore(Context context) { root = new File(context.getFilesDir(), "magi/pending"); }
    static String cleanTitle(String raw) {
        String title = raw.replaceAll("[\\p{Cntrl}\\p{Cf}]", " ");
        return title.substring(0, Math.min(200, title.length()));
    }
    static boolean validId(String id) { return id != null && id.matches("[a-zA-Z0-9_-]{1,160}"); }
    private File folder(String id) throws IOException {
        if (!validId(id)) throw new IOException("invalid_request_id");
        return new File(root, id);
    }
    private JSObject metadata(File folder) throws Exception {
        return new JSObject(new String(new AtomicFile(new File(folder, "meta.json")).readFully(), StandardCharsets.UTF_8));
    }
    private void write(File folder, JSObject value) throws Exception {
        if (!folder.isDirectory() && !folder.mkdirs()) throw new IOException("storage_unavailable");
        AtomicFile file = new AtomicFile(new File(folder, "meta.json")); FileOutputStream out = null;
        try { out = file.startWrite(); out.write(value.toString().getBytes(StandardCharsets.UTF_8)); file.finishWrite(out); }
        catch (Exception error) { if (out != null) file.failWrite(out); throw error; }
    }
    void create(JSObject value, Runnable register) throws Exception {
        synchronized (LOCK) {
            File folder = folder(value.getString("id"));
            if (folder.exists()) throw new IOException("request_exists");
            try {
                write(folder, value);
                try (FileOutputStream out = new FileOutputStream(new File(folder, "events.sse"))) { out.getFD().sync(); }
                // 保留一覧にreceivingが見える時点で、対応する進行中IDも公開する。
                register.run();
            } catch (Exception error) { try { remove(value.getString("id")); } catch (Exception ignored) {} throw error; }
        }
    }
    void append(String id, String event, JSObject data) throws Exception {
        synchronized (LOCK) {
            File file = new File(folder(id), "events.sse");
            byte[] bytes = ("event: " + event + "\ndata: " + data.toString() + "\n\n").getBytes(StandardCharsets.UTF_8);
            if (file.length() + bytes.length > MagiSseReader.MAX_BYTES) throw new IOException("response_too_large");
            try (FileOutputStream out = new FileOutputStream(file, true)) { out.write(bytes); }
        }
    }
    void finish(String id, String status, String error, String title, boolean widgetAnswer) throws Exception {
        synchronized (LOCK) {
            File folder = folder(id);
            try (RandomAccessFile file = new RandomAccessFile(new File(folder, "events.sse"), "rw")) { file.getFD().sync(); }
            JSObject value = metadata(folder); value.put("status", status); value.put("error", error);
            value.put("title", title); value.put("finishedAt", System.currentTimeMillis()); value.put("widgetAnswer", widgetAnswer); write(folder, value);
        }
    }
    void released(String id, boolean notified) throws Exception {
        synchronized (LOCK) {
            File folder = folder(id); JSObject value = metadata(folder);
            value.put("serviceStoppedAt", System.currentTimeMillis()); value.put("notified", notified); write(folder, value);
        }
    }
    JSObject read(String id, long offset) throws Exception {
        synchronized (LOCK) {
            File folder = folder(id); JSObject result = metadata(folder);
            try (RandomAccessFile input = new RandomAccessFile(new File(folder, "events.sse"), "r")) {
                long length = input.length();
                if (offset < 0 || offset > length) throw new IOException("invalid_offset");
                byte[] bytes = new byte[(int) Math.min(48 * 1024, length - offset)];
                input.seek(offset); input.readFully(bytes);
                result.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP));
                result.put("offset", offset + bytes.length); result.put("length", length);
            }
            return result;
        }
    }
    JSArray list(Supplier<String> activeId) throws Exception {
        synchronized (LOCK) {
            String active = activeId.get();
            JSArray values = new JSArray(); File[] folders = root.listFiles();
            if (folders == null) return values;
            for (File folder : folders) {
                if (!folder.isDirectory()) continue;
                JSObject value;
                try { value = metadata(folder); }
                catch (Exception error) {
                    // 作成・削除の途中でプロセスが終わった列は取り込めない。一覧・全削除・ウィジェットを止めないよう片付ける。
                    if (!new File(folder, "meta.json").exists()) try { remove(folder.getName()); } catch (Exception ignored) {}
                    continue;
                }
                if ("receiving".equals(value.getString("status")) && !folder.getName().equals(active)) {
                    finish(folder.getName(), "failed", "interrupted", value.getString("title", ""), false); value = metadata(folder);
                }
                values.put(value);
            }
            return values;
        }
    }
    MagiWidgetData widgetData(String id, String sessionId) throws Exception {
        synchronized (LOCK) {
            File folder = folder(id); JSObject meta = metadata(folder);
            if (!"complete".equals(meta.getString("status")) || !sessionId.equals(meta.getString("sessionId"))) throw new IllegalStateException("widget_state_changed");
            MagiWidgetData.Collector widget = new MagiWidgetData.Collector();
            try (FileInputStream input = new FileInputStream(new File(folder, "events.sse"))) {
                MagiSseReader.read(input, (event, raw) -> {
                    widget.accept(event, new JSObject(raw));
                    if ("error".equals(event)) throw new IOException("incomplete_reply");
                    return "done".equals(event);
                });
            }
            return widget.hasAnswer() ? widget.data(sessionId, meta.getString("title", "")) : null;
        }
    }
    void remove(String id) throws Exception {
        synchronized (LOCK) {
            File folder = folder(id); if (!folder.exists()) return;
            File[] files = folder.listFiles();
            // 途中で終わっても、meta.jsonが残る間は一覧から状態を読めるよう最後に消す。
            if (files != null) java.util.Arrays.sort(files, (a, b) -> Boolean.compare(a.getName().equals("meta.json"), b.getName().equals("meta.json")));
            if (files != null) for (File file : files) {
                if (!file.isFile() || !file.delete()) throw new IOException("storage_unavailable");
            }
            if (!folder.delete()) throw new IOException("storage_unavailable");
        }
    }
}
