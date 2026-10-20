package st.tk.magi;

import android.content.Context;
import android.util.AtomicFile;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;

/** B1の会話JSONと書き手を分け、受信列は画面への取り込みが確定するまで保持する。 */
final class MagiStreamStore {
    private static final Object LOCK = new Object();
    private final File root;
    MagiStreamStore(Context context) { root = new File(context.getFilesDir(), "magi/pending"); }
    private File folder(String id) throws IOException {
        if (id == null || !id.matches("[a-zA-Z0-9_-]{1,160}")) throw new IOException("invalid_request_id");
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
    void create(JSObject value) throws Exception {
        synchronized (LOCK) {
            File folder = folder(value.getString("id"));
            if (folder.exists()) throw new IOException("request_exists");
            try {
                write(folder, value);
                try (FileOutputStream out = new FileOutputStream(new File(folder, "events.sse"))) { out.getFD().sync(); }
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
    void finish(String id, String status, String error, String title) throws Exception {
        synchronized (LOCK) {
            File folder = folder(id);
            try (RandomAccessFile file = new RandomAccessFile(new File(folder, "events.sse"), "rw")) { file.getFD().sync(); }
            JSObject value = metadata(folder); value.put("status", status); value.put("error", error);
            value.put("title", title); value.put("finishedAt", System.currentTimeMillis()); write(folder, value);
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
    JSArray list(String activeId) throws Exception {
        synchronized (LOCK) {
            JSArray values = new JSArray(); File[] folders = root.listFiles();
            if (folders == null) return values;
            for (File folder : folders) {
                if (!folder.isDirectory()) continue;
                JSObject value = metadata(folder);
                if ("receiving".equals(value.getString("status")) && !folder.getName().equals(activeId)) {
                    finish(folder.getName(), "failed", "interrupted", value.getString("title", "")); value = metadata(folder);
                }
                values.put(value);
            }
            return values;
        }
    }
    void remove(String id) throws Exception {
        synchronized (LOCK) {
            File folder = folder(id); if (!folder.exists()) return;
            File[] files = folder.listFiles();
            if (files != null) for (File file : files) {
                if (!file.isFile() || !file.delete()) throw new IOException("storage_unavailable");
            }
            if (!folder.delete()) throw new IOException("storage_unavailable");
        }
    }
}
