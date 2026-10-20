package st.tk.magi;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.ArrayList;
import okhttp3.Call;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/** HTTP・受信の永続化・期限・通知は、画面のJavaScriptが止まってもここで完結する。 */
public class MagiConversationService extends Service {
    static final String ACTIVE_CHANNEL = "magi-debate", DONE_CHANNEL = "magi-replies";
    static final int ACTIVE_NOTIFICATION = 5301, DONE_NOTIFICATION = 5302;
    static final Handler MAIN = new Handler(Looper.getMainLooper());
    static volatile boolean foreground;
    private int latestStartId;
    private static volatile Run current;
    private static final OkHttpClient CLIENT = new OkHttpClient.Builder()
        .followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(0, TimeUnit.SECONDS).callTimeout(300, TimeUnit.SECONDS).build();

    static final class Run {
        final JSObject meta; volatile String body; final boolean test; volatile PluginCall startCall;
        final AtomicBoolean ended = new AtomicBoolean();
        final AtomicBoolean released = new AtomicBoolean();
        final ArrayList<PluginCall> waiters = new ArrayList<>();
        volatile Call call; volatile MagiConversationService service; volatile String title;
        PowerManager.WakeLock wake; Runnable deadline;
        Run(JSObject meta, String body, boolean test, PluginCall startCall) {
            this.meta = meta; this.body = body; this.test = test; this.startCall = startCall; title = meta.getString("title", "");
        }
        String id() { return meta.getString("id"); }
    }
    static String activeId() { Run run = current; return run == null ? null : run.id(); }
    static void begin(Context context, JSObject meta, String body, boolean test, PluginCall call) {
        // start/cancel/finishの所有権はmainで直列に更新する。
        MAIN.post(() -> {
            if (current != null) { call.reject("conversation_busy"); return; }
            Run run = new Run(meta, body, test, call);
            boolean created = false;
            try {
                MagiStreamStore store = new MagiStreamStore(context);
                store.create(meta); created = true; current = run;
                ContextCompat.startForegroundService(context, new Intent(context, MagiConversationService.class).putExtra("id", run.id()));
            } catch (Exception ignored) {
                current = null;
                if (created) try { new MagiStreamStore(context).finish(run.id(), "failed", "service_unavailable", run.title); } catch (Exception ignoredAgain) {}
                call.reject("service_unavailable");
            }
        });
    }
    static void cancel(Context context, String id, PluginCall call) {
        MAIN.post(() -> {
            Run run = current;
            if (run != null && run.id().equals(id)) {
                if (call != null) run.waiters.add(call);
                finish(context, run, "stopped", "stopped");
            } else if (call != null) call.resolve();
        });
    }
    static void channels(Context context) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(ACTIVE_CHANNEL, "討議中", NotificationManager.IMPORTANCE_LOW));
        manager.createNotificationChannel(new NotificationChannel(DONE_CHANNEL, "回答の到着", NotificationManager.IMPORTANCE_DEFAULT));
    }
    private static PendingIntent open(Context context, Run run) {
        Uri link = new Uri.Builder().scheme("magi").authority("open").appendQueryParameter("id", run.meta.getString("sessionId")).build();
        Intent intent = new Intent(context, MainActivity.class).setAction(Intent.ACTION_VIEW).setData(link)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(context, 5302, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
    private Notification ongoing(Run run) {
        PendingIntent stop = PendingIntent.getService(this, 5301,
            new Intent(this, MagiConversationService.class).setAction("stop").setData(Uri.parse("magi-stop:" + run.id())).putExtra("id", run.id()),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, ACTIVE_CHANNEL).setSmallIcon(R.drawable.ic_stat_magi)
            .setContentTitle("MAGI が討議中…").setContentText("完了したらお知らせします")
            .setContentIntent(open(this, run)).setOngoing(true).setSilent(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .addAction(0, "停止", stop).build();
    }
    private static void release(Run run) {
        if (!run.released.compareAndSet(false, true)) return;
        if (run.deadline != null) MAIN.removeCallbacks(run.deadline);
        if (run.wake != null && run.wake.isHeld()) run.wake.release();
        if (run.service != null) { run.service.stopForeground(STOP_FOREGROUND_REMOVE); run.service.stopSelfResult(run.service.latestStartId); }
        if (current == run) current = null;
        for (PluginCall waiter : run.waiters) waiter.resolve();
        run.waiters.clear();
    }
    private static void finish(Context context, Run run, String status, String error) {
        if (!run.ended.compareAndSet(false, true)) return;
        if (run.call != null) run.call.cancel();
        if (run.service == null && run.startCall != null) { run.startCall.reject("stopped"); run.startCall = null; }
        // fsyncが遅れてもOSの期限処理を塞がない。保存の後だけ完了通知を出す。
        new Thread(() -> persistFinish(context, run, status, error), "magi-conversation-save").start();
    }
    private static void persistFinish(Context context, Run run, String status, String error) {
        String finalStatus = status;
        try { new MagiStreamStore(context).finish(run.id(), status, error, run.title); }
        catch (Exception ignored) { finalStatus = "failed"; }
        final String savedStatus = finalStatus;
        MAIN.post(() -> {
            release(run);
            // 保存済み状態を確定してから通知し、未保存の回答へ利用者を誘導しない。
            boolean allowed = Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
            boolean notificationRequested = false;
            if (!foreground && !status.equals("stopped") && allowed) {
                channels(context);
                String title = savedStatus.equals("complete") ? "回答が届きました" : "回答を受け取れませんでした";
                Bundle extras = new Bundle(); extras.putString("magi_request_id", run.id());
                Notification note = new NotificationCompat.Builder(context, DONE_CHANNEL).setSmallIcon(R.drawable.ic_stat_magi)
                    .setContentTitle(title).setContentText(run.title).setContentIntent(open(context, run)).setAutoCancel(true)
                    .setExtras(extras).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build();
                try {
                    NotificationManager manager = context.getSystemService(NotificationManager.class); manager.notify(DONE_NOTIFICATION, note);
                    notificationRequested = true;
                } catch (Exception ignored) {}
            }
            try { new MagiStreamStore(context).released(run.id(), false); } catch (Exception ignored) {}
            if (notificationRequested) {
                // notifyの反映は非同期。古い通知を今回の到着と取り違えず、資源解放後に確認する。
                MAIN.postDelayed(() -> {
                    boolean posted = false;
                    try {
                        for (android.service.notification.StatusBarNotification row : context.getSystemService(NotificationManager.class).getActiveNotifications()) {
                            if (row.getId() == DONE_NOTIFICATION && run.id().equals(row.getNotification().extras.getString("magi_request_id"))) posted = true;
                        }
                        new MagiStreamStore(context).released(run.id(), posted);
                    } catch (Exception ignored) {}
                }, 500L);
            }
        });
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        latestStartId = startId;
        Run run = current;
        if (intent != null && "stop".equals(intent.getAction())) {
            if (run != null && run.id().equals(intent.getStringExtra("id"))) finish(this, run, "stopped", "stopped");
            else if (run == null) stopSelf(startId);
            return START_NOT_STICKY;
        }
        if (run == null || intent == null || !run.id().equals(intent.getStringExtra("id"))) { stopSelf(startId); return START_NOT_STICKY; }
        if (run.service != null) return START_NOT_STICKY;
        run.service = this;
        try {
            channels(this);
            if (Build.VERSION.SDK_INT >= 29) startForeground(ACTIVE_NOTIFICATION, ongoing(run), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            else startForeground(ACTIVE_NOTIFICATION, ongoing(run));
            if (run.ended.get()) { stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(); return START_NOT_STICKY; }
            PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
            run.wake = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, getPackageName() + ":magi-conversation"); run.wake.acquire(305000L);
            run.deadline = () -> { finish(this, run, "failed", "timeout"); release(run); }; MAIN.postDelayed(run.deadline, 300000L);
            JSObject accepted = new JSObject(); accepted.put("id", run.id()); run.startCall.resolve(accepted); run.startCall = null;
            new Thread(() -> receive(run), "magi-conversation").start();
        } catch (Exception ignored) { if (run.startCall != null) { run.startCall.reject("service_unavailable"); run.startCall = null; } finish(this, run, "failed", "service_unavailable"); }
        return START_NOT_STICKY;
    }
    private void receive(Run run) {
        try {
            String endpoint = run.test ? "http://127.0.0.1:18765/magi2/chat" : "https://workers.tk.st/magi2/chat";
            Request request = new Request.Builder().url(endpoint).header("Origin", "https://localhost").header("Accept", "text/event-stream")
                .post(RequestBody.create(run.body, MediaType.get("application/json; charset=utf-8"))).build();
            run.call = CLIENT.newCall(request);
            run.body = null;
            if (run.ended.get()) { run.call.cancel(); return; }
            try (Response response = run.call.execute()) {
                if (!response.isSuccessful() || response.body() == null) {
                    JSObject error = new JSObject(); error.put("message", "HTTP " + response.code()); error.put("code", "http_" + response.code()); error.put("stage", "request");
                    new MagiStreamStore(this).append(run.id(), "error", error); finish(this, run, "failed", "http_" + response.code()); return;
                }
                if (!response.header("Content-Type", "").toLowerCase().startsWith("text/event-stream")) throw new IOException("invalid_content_type");
                MagiStreamStore store = new MagiStreamStore(this); boolean[] answer = { false };
                MagiSseReader.read(response.body().byteStream(), (event, text) -> {
                    if (run.ended.get()) throw new IOException("stopped");
                    // 未知のイベントは画面と同様に無視する。既知の本文はobjectのJSONだけ。
                    if (!event.matches("classification|title|motion|persona|ask|judge|verdict|integrated|integrated_end|clarify|closed|pages|sources|suggest|error|done")) return false;
                    JSObject data = new JSObject(text);
                    if (event.equals("title") && data.opt("text") instanceof String) {
                        run.title = data.getString("text").replaceAll("[\\p{Cntrl}\\p{Cf}]", " ");
                        if (run.title.length() > 200) run.title = run.title.substring(0, 200);
                    }
                    if (event.equals("integrated") && data.opt("delta") instanceof String && !data.getString("delta").trim().isEmpty()) answer[0] = true;
                    if (event.equals("clarify") && data.opt("questions") instanceof org.json.JSONArray && data.getJSONArray("questions").length() > 0) answer[0] = true;
                    if (event.equals("done") && !answer[0]) throw new IOException("incomplete_reply");
                    store.append(run.id(), event, data);
                    if (event.equals("error")) { finish(this, run, "failed", "upstream_error"); return true; }
                    if (event.equals("done")) { finish(this, run, "complete", ""); return true; }
                    return false;
                });
            }
        } catch (Exception error) {
            if (!run.ended.get()) finish(this, run, "failed", error instanceof IOException && "timeout".equals(error.getMessage()) ? "timeout" : "incomplete_reply");
        }
    }
    @Override public void onTimeout(int startId, int fgsType) {
        Run run = current;
        if (run != null && run.service == this && startId == latestStartId) { finish(this, run, "failed", "timeout"); release(run); }
        else stopSelf(startId);
    }
    @Override public void onDestroy() {
        Run run = current;
        if (run != null && run.service == this && !run.ended.get()) finish(this, run, "failed", "interrupted");
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
