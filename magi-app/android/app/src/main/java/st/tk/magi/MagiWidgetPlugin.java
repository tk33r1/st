package st.tk.magi;

import android.appwidget.AppWidgetManager;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "MagiWidget")
public class MagiWidgetPlugin extends Plugin {
    @Override public void load() { MagiWidgetProvider.preview(getContext()); }
    @PluginMethod public void information(PluginCall call) {
        JSObject data = new JSObject(); data.put("masked", MagiWidgetStore.masked(getContext()));
        data.put("revision", MagiWidgetStore.revision(getContext()));
        data.put("canPin", Build.VERSION.SDK_INT >= 26 && AppWidgetManager.getInstance(getContext()).isRequestPinAppWidgetSupported()); call.resolve(data);
    }
    @PluginMethod public void setMasked(PluginCall call) {
        Boolean value = call.getBoolean("masked"); if (value == null) { call.reject("invalid_mask"); return; }
        try { MagiWidgetStore.mask(getContext(), value); MagiWidgetProvider.updateAll(getContext()); call.resolve(); }
        catch (Exception ignored) { call.reject("widget_storage_unavailable"); }
    }
    @PluginMethod public void update(PluginCall call) {
        String id = call.getString("sessionId", ""), title = call.getString("title", ""), summary = call.getString("summary", ""), verdict = call.getString("verdict", "");
        String pendingId = call.getString("pendingId", ""), pendingSessionId = call.getString("pendingSessionId", "");
        Object revision = call.getData().opt("revision");
        if ((!id.isEmpty() && !MagiWidgetData.validId(id)) || (!pendingId.isEmpty() && (!MagiWidgetData.validId(pendingId) || !MagiWidgetData.validId(pendingSessionId))) || title.length() > 1000 || summary.length() > 1000
            || !(revision instanceof Number) || ((Number) revision).longValue() < 0 || ((Number) revision).doubleValue() != ((Number) revision).longValue()) { call.reject("invalid_widget_data"); return; }
        try {
            MagiWidgetData display = new MagiWidgetData(id, title, summary, verdict);
            if (!pendingId.isEmpty()) {
                // B1への取込とは別に、保存済みSSEから小さい表示情報だけを復元する。
                MagiWidgetData pending = new MagiStreamStore(getContext()).widgetData(pendingId, pendingSessionId);
                if (pending != null) display = pending;
            }
            // SSEを読む間に受信・設定が変わった場合も、古い表示を採用しない。
            MagiWidgetStore.updateFromScreen(getContext(), display, call.getBoolean("masked", true), ((Number) revision).longValue());
            MagiWidgetProvider.updateAll(getContext()); call.resolve();
        } catch (IllegalStateException | java.io.FileNotFoundException changed) { call.reject("widget_state_changed");
        } catch (Exception ignored) { call.reject("widget_storage_unavailable"); }
    }
    @PluginMethod public void pin(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSObject value = new JSObject();
            value.put("requested", Build.VERSION.SDK_INT >= 26 && AppWidgetManager.getInstance(getContext())
                .requestPinAppWidget(MagiWidgetProvider.component(getContext()), null, null)); call.resolve(value);
        });
    }
}
