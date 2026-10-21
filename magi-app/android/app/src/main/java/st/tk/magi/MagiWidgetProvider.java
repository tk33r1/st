package st.tk.magi;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.appwidget.AppWidgetProviderInfo;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.util.SizeF;
import android.view.View;
import android.widget.RemoteViews;
import java.util.LinkedHashMap;
import java.util.Map;

/** 表示と明示的なActivity起動だけを行い、ネットワーク・会話の生成・音声録音は行わない。 */
public class MagiWidgetProvider extends AppWidgetProvider {
    static ComponentName component(Context c) { return new ComponentName(c, MagiWidgetProvider.class); }
    static void updateAll(Context c) {
        AppWidgetManager manager = AppWidgetManager.getInstance(c);
        for (int id : manager.getAppWidgetIds(component(c))) update(c, manager, id);
    }
    static void preview(Context c) {
        if (Build.VERSION.SDK_INT < 35) return;
        android.content.SharedPreferences p = c.getSharedPreferences("magi-widget-preview", Context.MODE_PRIVATE);
        if (p.getInt("version", 0) == BuildConfig.VERSION_CODE) return;
        try {
            // 一覧のプレビューに本人の会話を載せない。
            if (AppWidgetManager.getInstance(c).setWidgetPreview(component(c), AppWidgetProviderInfo.WIDGET_CATEGORY_HOME_SCREEN,
                new RemoteViews(c.getPackageName(), R.layout.magi_widget_small))) p.edit().putInt("version", BuildConfig.VERSION_CODE).apply();
        } catch (RuntimeException ignored) { /* 非対応のランチャーではXMLのプレビューを使う。 */ }
    }
    private static RemoteViews view(Context c, boolean large) {
        MagiWidgetData data = MagiWidgetStore.read(c); boolean masked = MagiWidgetStore.masked(c);
        RemoteViews views = new RemoteViews(c.getPackageName(), large ? R.layout.magi_widget_large : R.layout.magi_widget_small);
        PendingIntent next = MagiAppLink.create(c, "new", "", 5701), voice = MagiAppLink.create(c, "voice", "", 5702);
        PendingIntent resume = data.sessionId.isEmpty() ? next : MagiAppLink.create(c, "open", data.sessionId, 5703);
        views.setOnClickPendingIntent(R.id.widget_new, next); views.setOnClickPendingIntent(R.id.widget_voice, voice);
        views.setOnClickPendingIntent(R.id.widget_resume, resume);
        if (large) {
            views.setTextViewText(R.id.widget_title, data.sessionId.isEmpty() ? c.getString(R.string.widget_empty)
                : masked ? c.getString(R.string.widget_masked) : data.title);
            views.setTextViewText(R.id.widget_summary, masked ? "" : data.summary);
            String verdict = "approve".equals(data.verdict) ? c.getString(R.string.widget_approve)
                : "reject".equals(data.verdict) ? c.getString(R.string.widget_reject) : "hold".equals(data.verdict) ? c.getString(R.string.widget_hold) : "";
            views.setTextViewText(R.id.widget_verdict, masked ? "" : verdict);
            views.setViewVisibility(R.id.widget_verdict, masked || verdict.isEmpty() ? View.GONE : View.VISIBLE);
            views.setOnClickPendingIntent(R.id.widget_title, resume); views.setOnClickPendingIntent(R.id.widget_summary, resume);
        }
        return views;
    }
    private static void update(Context c, AppWidgetManager manager, int id) {
        // 伏せる設定の確定後に、別スレッドが作った古い表示を配り直さない。
        synchronized (MagiWidgetStore.class) {
            manager.updateAppWidget(id, responsive(c, manager.getAppWidgetOptions(id)));
        }
    }
    static RemoteViews responsive(Context c, Bundle options) {
        synchronized (MagiWidgetStore.class) {
            if (Build.VERSION.SDK_INT < 31) {
                return view(c, options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH) >= 180 && options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT) >= 110);
            }
            Map<SizeF, RemoteViews> sizes = new LinkedHashMap<>();
            sizes.put(new SizeF(110, 40), view(c, false)); sizes.put(new SizeF(180, 110), view(c, true));
            return new RemoteViews(sizes);
        }
    }
    @Override public void onUpdate(Context c, AppWidgetManager manager, int[] ids) { for (int id : ids) update(c, manager, id); }
    @Override public void onAppWidgetOptionsChanged(Context c, AppWidgetManager manager, int id, Bundle options) { update(c, manager, id); }
    @Override public void onEnabled(Context c) { preview(c); }
    @Override public void onReceive(Context c, Intent intent) {
        if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction()) || Intent.ACTION_LOCALE_CHANGED.equals(intent.getAction())) { preview(c); updateAll(c); }
        else super.onReceive(c, intent);
    }
}
