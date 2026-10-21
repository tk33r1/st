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
import android.widget.RemoteViews;
import java.util.LinkedHashMap;
import java.util.Map;

/** チャット・カメラ・アルバム・音声入力の入口だけを持つ。会話の内容は表示せず、ネットワーク・会話の生成・録音は行わない。 */
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
            if (AppWidgetManager.getInstance(c).setWidgetPreview(component(c), AppWidgetProviderInfo.WIDGET_CATEGORY_HOME_SCREEN,
                new RemoteViews(c.getPackageName(), R.layout.magi_widget))) p.edit().putInt("version", BuildConfig.VERSION_CODE).apply();
        } catch (RuntimeException ignored) { /* 非対応のランチャーではXMLのプレビューを使う。 */ }
    }
    private static RemoteViews view(Context c, int layout) {
        RemoteViews views = new RemoteViews(c.getPackageName(), layout);
        views.setOnClickPendingIntent(R.id.widget_chat, MagiAppLink.create(c, "new", "", 5701));
        views.setOnClickPendingIntent(R.id.widget_voice, MagiAppLink.create(c, "voice", "", 5702));
        views.setOnClickPendingIntent(R.id.widget_camera, MagiAppLink.create(c, "camera", "", 5704));
        views.setOnClickPendingIntent(R.id.widget_album, MagiAppLink.create(c, "album", "", 5705));
        return views;
    }
    private static void update(Context c, AppWidgetManager manager, int id) { manager.updateAppWidget(id, responsive(c, manager.getAppWidgetOptions(id))); }
    // 高さ1マスでは1列（狭ければアイコンだけ）、それ以上ではチャットの入口を上に置く。
    static RemoteViews responsive(Context c, Bundle options) {
        if (Build.VERSION.SDK_INT < 31) {
            int width = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH), height = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT);
            return view(c, height >= 100 && width >= 180 ? R.layout.magi_widget : width >= 250 ? R.layout.magi_widget_row : R.layout.magi_widget_compact);
        }
        Map<SizeF, RemoteViews> sizes = new LinkedHashMap<>();
        sizes.put(new SizeF(110, 40), view(c, R.layout.magi_widget_compact)); sizes.put(new SizeF(250, 40), view(c, R.layout.magi_widget_row));
        sizes.put(new SizeF(180, 100), view(c, R.layout.magi_widget));
        return new RemoteViews(sizes);
    }
    @Override public void onUpdate(Context c, AppWidgetManager manager, int[] ids) { for (int id : ids) update(c, manager, id); }
    @Override public void onAppWidgetOptionsChanged(Context c, AppWidgetManager manager, int id, Bundle options) { update(c, manager, id); }
    @Override public void onEnabled(Context c) { preview(c); }
    @Override public void onReceive(Context c, Intent intent) {
        if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) {
            // 5.8までは前回の題名・結論を表示用に保存していた。入口だけになったので端末から消す。
            c.deleteSharedPreferences("magi-widget");
            preview(c); updateAll(c);
        } else if (Intent.ACTION_LOCALE_CHANGED.equals(intent.getAction())) { preview(c); updateAll(c); }
        else super.onReceive(c, intent);
    }
}
