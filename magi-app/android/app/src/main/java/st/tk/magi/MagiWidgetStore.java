package st.tk.magi;

import android.content.Context;
import android.content.SharedPreferences;
import java.io.IOException;

/** 伏せる設定はネイティブを正本とし、伏せた時点で題名・結論・決議を消す。 */
final class MagiWidgetStore {
    private static SharedPreferences prefs(Context context) { return context.getSharedPreferences("magi-widget", Context.MODE_PRIVATE); }
    static synchronized boolean masked(Context context) { return prefs(context).getBoolean("masked", true); }
    static synchronized long revision(Context context) { return prefs(context).getLong("revision", 0); }
    static synchronized MagiWidgetData read(Context context) {
        SharedPreferences p = prefs(context); boolean masked = masked(context);
        return new MagiWidgetData(p.getString("sessionId", ""), masked ? "" : p.getString("title", ""),
            masked ? "" : p.getString("summary", ""), masked ? "" : p.getString("verdict", ""));
    }
    static synchronized void mask(Context context, boolean value) throws IOException {
        SharedPreferences.Editor edit = prefs(context).edit().putBoolean("masked", value).putLong("revision", revision(context) + 1);
        if (value) edit.remove("title").remove("summary").remove("verdict");
        if (!edit.commit()) throw new IOException("widget_storage_unavailable");
    }
    static synchronized void update(Context context, MagiWidgetData data) throws IOException {
        SharedPreferences.Editor edit = prefs(context).edit().putString("sessionId", data.sessionId).putLong("revision", revision(context) + 1);
        if (masked(context)) edit.remove("title").remove("summary").remove("verdict");
        else edit.putString("title", data.title).putString("summary", data.summary).putString("verdict", data.verdict);
        if (!edit.commit()) throw new IOException("widget_storage_unavailable");
    }
    static synchronized void updateFromScreen(Context context, MagiWidgetData data, boolean masked, long revision) throws IOException {
        if (masked != masked(context) || revision != revision(context)) throw new IllegalStateException("widget_state_changed");
        update(context, data);
    }
}
