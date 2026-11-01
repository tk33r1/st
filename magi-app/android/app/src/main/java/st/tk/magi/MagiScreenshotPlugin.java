package st.tk.magi;

import android.app.Activity;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 画面が前に出ている間に利用者がスクリーンショットを撮ったら、画面へ screenshot を知らせる（共有の提案に使う）。
 * Android 14 以降の Activity.ScreenCaptureCallback だけを使う。撮った画像は読まない（写真の読み取り権限は要らない）。
 * それより前の Android では何もしない。
 */
@CapacitorPlugin(name = "MagiScreenshot")
public class MagiScreenshotPlugin extends Plugin {
    private Object callback; // Activity.ScreenCaptureCallback（古い Android で型を読み込まないよう Object で持つ）
    private boolean registered;

    @Override public void load() { register(); }
    @Override protected void handleOnStart() { register(); }
    @Override protected void handleOnStop() { unregister(); }
    @Override protected void handleOnDestroy() { unregister(); }

    @PluginMethod public void supported(PluginCall call) {
        JSObject result = new JSObject();
        result.put("supported", Build.VERSION.SDK_INT >= 34);
        call.resolve(result);
    }

    private void register() {
        if (Build.VERSION.SDK_INT < 34 || registered) return;
        Activity activity = getActivity();
        if (activity == null) return;
        if (callback == null) callback = (Activity.ScreenCaptureCallback) () -> notifyListeners("screenshot", new JSObject());
        try {
            activity.registerScreenCaptureCallback(activity.getMainExecutor(), (Activity.ScreenCaptureCallback) callback);
            registered = true;
        } catch (RuntimeException ignored) { }
    }

    private void unregister() {
        if (Build.VERSION.SDK_INT < 34 || !registered) return;
        Activity activity = getActivity();
        registered = false;
        if (activity == null || callback == null) return;
        try { activity.unregisterScreenCaptureCallback((Activity.ScreenCaptureCallback) callback); } catch (RuntimeException ignored) { }
    }
}
