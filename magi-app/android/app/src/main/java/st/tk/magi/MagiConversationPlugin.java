package st.tk.magi;

import android.Manifest;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.app.NotificationManager;
import android.app.PendingIntent;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.nio.charset.StandardCharsets;

@CapacitorPlugin(name = "MagiConversation", permissions = @Permission(strings = Manifest.permission.POST_NOTIFICATIONS, alias = "display"))
public class MagiConversationPlugin extends Plugin {
    @Override public void load() { MagiConversationService.channels(getContext()); }
    private boolean testBuild() { return BuildConfig.DEBUG && BuildConfig.MAGI_B3_PROBE && getContext().getPackageName().equals("st.tk.magi.b3probe"); }
    @PluginMethod public void begin(PluginCall call) {
        String id = call.getString("id", ""), session = call.getString("sessionId", ""), mid = call.getString("mid", ""), body = call.getString("body", "");
        if (!id.matches("[a-zA-Z0-9_-]{1,160}") || !session.matches("[a-zA-Z0-9_-]{1,160}") || !mid.matches("[a-zA-Z0-9_-]{1,160}")
            || body.getBytes(StandardCharsets.UTF_8).length > 12 * 1024 * 1024 || body.isEmpty() || call.getBoolean("test", false) != testBuild()) {
            call.reject("invalid_request"); return;
        }
        try { new JSObject(body); } catch (Exception ignored) { call.reject("invalid_request"); return; }
        JSObject meta = new JSObject(); meta.put("id", id); meta.put("sessionId", session); meta.put("mid", mid);
        meta.put("title", MagiStreamStore.cleanTitle(call.getString("title", "MAGI"))); meta.put("status", "receiving"); meta.put("startedAt", System.currentTimeMillis());
        MagiConversationService.begin(getContext(), meta, body, testBuild(), call);
    }
    @PluginMethod public void read(PluginCall call) {
        try {
            // 2MiB以内のJSON整数はCapacitorでIntegerになる。getLongは既定値へ戻るため使わない。
            Integer offset = call.getInt("offset");
            if (offset == null) throw new IllegalArgumentException("invalid_offset");
            JSObject result = new MagiStreamStore(getContext()).read(call.getString("id"), offset.longValue());
            if ("receiving".equals(result.getString("status")) && !call.getString("id", "").equals(MagiConversationService.activeId())) {
                result.put("status", "failed"); result.put("error", "interrupted");
            }
            call.resolve(result);
        }
        catch (Exception ignored) { call.reject("stream_storage_unavailable"); }
    }
    @PluginMethod public void pending(PluginCall call) {
        try {
            JSObject result = new JSObject(); result.put("runs", new MagiStreamStore(getContext()).list(MagiConversationService::activeId)); call.resolve(result);
        } catch (Exception ignored) { call.reject("stream_storage_unavailable"); }
    }
    @PluginMethod public void cancel(PluginCall call) { MagiConversationService.cancel(getContext(), call.getString("id", ""), call); }
    @PluginMethod public void acknowledge(PluginCall call) {
        String id = call.getString("id", "");
        if (id.equals(MagiConversationService.activeId())) { call.reject("conversation_busy"); return; }
        try { new MagiStreamStore(getContext()).remove(id); call.resolve(); }
        catch (Exception ignored) { call.reject("stream_storage_unavailable"); }
    }
    @Override @PluginMethod public void checkPermissions(PluginCall call) {
        if (!NotificationManagerCompat.from(getContext()).areNotificationsEnabled() && (Build.VERSION.SDK_INT < 33 || getPermissionState("display") != PermissionState.PROMPT)) {
            JSObject value = new JSObject(); value.put("display", "denied"); call.resolve(value);
        }
        else if (Build.VERSION.SDK_INT < 33) { JSObject value = new JSObject(); value.put("display", "granted"); call.resolve(value); }
        else super.checkPermissions(call);
    }
    @Override @PluginMethod public void requestPermissions(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("display") == PermissionState.GRANTED) checkPermissions(call);
        else requestPermissionForAlias("display", call, "permissionResult");
    }
    @PermissionCallback private void permissionResult(PluginCall call) { checkPermissions(call); }
    @PluginMethod public void information(PluginCall call) {
        JSObject value = new JSObject(); value.put("test", testBuild()); call.resolve(value);
    }
    // 別IDのdebugで、OSに登録された実際のPendingIntentだけを検証する。
    @PluginMethod public void testNotificationAction(PluginCall call) {
        if (!testBuild()) { call.reject("test_only"); return; }
        String kind = call.getString("kind", "");
        int wanted = kind.equals("stop") ? MagiConversationService.ACTIVE_NOTIFICATION : kind.equals("open") ? MagiConversationService.DONE_NOTIFICATION : -1;
        for (android.service.notification.StatusBarNotification row : getContext().getSystemService(NotificationManager.class).getActiveNotifications()) {
            if (row.getId() != wanted) continue;
            try {
                PendingIntent intent = kind.equals("open") ? row.getNotification().contentIntent : row.getNotification().actions[0].actionIntent;
                intent.send(); call.resolve(); return;
            } catch (Exception ignored) { call.reject("notification_action_failed"); return; }
        }
        call.reject("notification_unavailable");
    }
    @PluginMethod public void openNotificationSettings(PluginCall call) {
        Intent intent = Build.VERSION.SDK_INT >= 26 ? new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName())
            : new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
        getActivity().startActivity(intent); call.resolve();
    }
}
