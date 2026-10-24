package st.tk.magi;

import android.Manifest;
import android.location.Address;
import android.location.Geocoder;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;

/** 送信時だけ測位する。座標や住所を保存せず、終了・中断・画面を離れたときに購読を外す。 */
@CapacitorPlugin(name = "MagiLocation", permissions = {
    @Permission(strings = Manifest.permission.ACCESS_COARSE_LOCATION, alias = "coarse"),
    @Permission(strings = Manifest.permission.ACCESS_FINE_LOCATION, alias = "fine")
})
public class MagiLocationPlugin extends Plugin {
    private final Handler main = new Handler(Looper.getMainLooper());
    private LocationManager manager;
    private PluginCall pending;
    private LocationListener listener;
    private Location best;
    private Runnable timeout;
    private boolean gps;
    private boolean active = true;

    @Override public void load() { manager = getContext().getSystemService(LocationManager.class); }
    private boolean fine() { return getPermissionState("fine") == PermissionState.GRANTED; }
    private boolean allowed() { return fine() || getPermissionState("coarse") == PermissionState.GRANTED; }
    @PluginMethod public void permission(PluginCall call) {
        if (call.getBoolean("request", false) && !fine())
            requestPermissionForAliases(new String[] { "coarse", "fine" }, call, "permissionResult");
        else permissionResult(call);
    }
    @PermissionCallback private void permissionResult(PluginCall call) {
        JSObject value = new JSObject();
        value.put("precision", fine() ? "precise" : allowed() ? "approximate" : "none");
        // 拒否後は送信のたびに要求しない。再要求は設定をオンにした本人の操作に限る。
        value.put("canAsk", getPermissionState("coarse") == PermissionState.PROMPT);
        call.resolve(value);
    }
    @PluginMethod public void current(PluginCall call) { main.post(() -> start(call)); }
    @PluginMethod public void cancel(PluginCall call) { main.post(() -> { finish(null); call.resolve(); }); }
    private boolean enabled(String provider) {
        try { return manager != null && manager.isProviderEnabled(provider); } catch (Exception ignored) { return false; }
    }
    private boolean fresh(Location value) {
        if (value == null || !value.hasAccuracy() || value.getAccuracy() > 10000 || value.getAccuracy() < 0) return false;
        long age = SystemClock.elapsedRealtimeNanos() - value.getElapsedRealtimeNanos();
        return age >= 0 && age <= 60_000_000_000L;
    }
    private void accept(Location value) {
        if (!fresh(value) || pending == null || listener == null) return;
        if (best == null || value.getAccuracy() < best.getAccuracy()) best = value;
        if (!gps || LocationManager.GPS_PROVIDER.equals(value.getProvider()) && value.getAccuracy() <= 100) finish(best);
    }
    @SuppressWarnings("MissingPermission")
    private void start(PluginCall call) {
        if (pending != null) { call.reject("location_busy"); return; }
        if (!active || !allowed() || manager == null) { call.reject("location_unavailable"); return; }
        pending = call; best = null;
        gps = fine() && enabled(LocationManager.GPS_PROVIDER);
        boolean network = enabled(LocationManager.NETWORK_PROVIDER);
        if (!gps && !network) { finish(null); return; }
        listener = new LocationListener() {
            @Override public void onLocationChanged(Location value) { accept(value); }
            @Override public void onProviderEnabled(String provider) {}
            @Override public void onProviderDisabled(String provider) {}
            @Override public void onStatusChanged(String provider, int status, Bundle extras) {}
        };
        timeout = () -> finish(best);
        main.postDelayed(timeout, 8000);
        for (String provider : new String[] { LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER }) {
            if (pending == null || listener == null) break;
            if (provider.equals(LocationManager.GPS_PROVIDER) ? !gps : !network) continue;
            try {
                accept(manager.getLastKnownLocation(provider));
                if (pending != null && listener != null) manager.requestLocationUpdates(provider, 1000, 0, listener, Looper.getMainLooper());
            } catch (Exception ignored) { /* 別の測位元又は8秒の期限で決着させる。 */ }
        }
    }
    private void finish(Location value) {
        if (listener != null && manager != null) { try { manager.removeUpdates(listener); } catch (Exception ignored) {} }
        listener = null;
        if (timeout != null) main.removeCallbacks(timeout);
        timeout = null; best = null;
        PluginCall call = pending;
        if (call == null) return;
        if (value == null || !allowed()) { pending = null; call.reject("location_unavailable"); return; }
        JSObject result = new JSObject();
        result.put("latitude", value.getLatitude()); result.put("longitude", value.getLongitude());
        result.put("accuracy", value.getAccuracy());
        result.put("timezone", TimeZone.getDefault().getID());
        // 住所の取得が遅くても送信を止めない。番地・建物名は受け口へ渡さない。
        Runnable resolve = () -> {
            if (pending != call) return;
            // GPSの衛星時刻と端末の壁時計を比較しない。住所の待ち時間も含めた経過時間を渡す。
            result.put("age_ms", (SystemClock.elapsedRealtimeNanos() - value.getElapsedRealtimeNanos()) / 1_000_000L);
            pending = null; timeout = null; call.resolve(result);
        };
        timeout = resolve;
        main.postDelayed(resolve, 1500);
        new Thread(() -> {
            Address address = null;
            try {
                List<Address> found = new Geocoder(getContext(), Locale.ENGLISH).getFromLocation(value.getLatitude(), value.getLongitude(), 1);
                if (found != null && !found.isEmpty()) address = found.get(0);
            } catch (Exception ignored) {}
            final Address place = address;
            main.post(() -> {
                // 期限切れなら結果へ触らない（遅れて二重にresolveしない）。
                if (pending != call) return;
                main.removeCallbacks(resolve);
                if (place != null) {
                    result.put("country", place.getCountryCode()); result.put("city", place.getLocality()); result.put("region", place.getAdminArea());
                }
                resolve.run();
            });
        }, "magi-location-name").start();
    }
    @Override protected void handleOnStart() { active = true; }
    @Override protected void handleOnStop() { active = false; main.post(() -> finish(null)); }
    @Override protected void handleOnDestroy() { active = false; main.post(() -> finish(null)); }
}
