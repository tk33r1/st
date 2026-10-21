package st.tk.magi;

import android.appwidget.AppWidgetManager;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** 設定画面の「ホーム画面に追加」だけを受け持つ。ウィジェットへ会話の内容は渡さない。 */
@CapacitorPlugin(name = "MagiWidget")
public class MagiWidgetPlugin extends Plugin {
    @Override public void load() { MagiWidgetProvider.preview(getContext()); }
    @PluginMethod public void information(PluginCall call) {
        JSObject data = new JSObject();
        data.put("canPin", Build.VERSION.SDK_INT >= 26 && AppWidgetManager.getInstance(getContext()).isRequestPinAppWidgetSupported()); call.resolve(data);
    }
    @PluginMethod public void pin(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSObject value = new JSObject();
            value.put("requested", Build.VERSION.SDK_INT >= 26 && AppWidgetManager.getInstance(getContext())
                .requestPinAppWidget(MagiWidgetProvider.component(getContext()), null, null)); call.resolve(value);
        });
    }
}
