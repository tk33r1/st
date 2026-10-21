package st.tk.magi;

import android.app.Activity;
import android.appwidget.AppWidgetHostView;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProviderInfo;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/** 別IDのdebug専用。実際のRemoteViewsをAndroidのHostViewで表示する検証画面。 */
public class MagiWidgetProbeActivity extends Activity {
    @Override public void onCreate(Bundle state) { super.onCreate(state); show(); }
    @Override public void onNewIntent(Intent intent) { super.onNewIntent(intent); setIntent(intent); show(); }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private void show() {
        if (!BuildConfig.MAGI_B3_PROBE || !getPackageName().equals("st.tk.magi.b3probe")) { finish(); return; }
        String size = getIntent().getStringExtra("size"); if (size == null) size = "2x1";
        int width = size.equals("4x3") ? 320 : size.equals("3x2") ? 230 : 150;
        int height = size.equals("4x3") ? 240 : size.equals("3x2") ? 160 : 80;
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setPadding(dp(12), dp(36), dp(12), dp(12)); root.setBackgroundColor(Color.rgb(25, 25, 25));
        TextView title = new TextView(this); title.setText("B4 RemoteViews / " + size); title.setTextColor(Color.WHITE); root.addView(title);
        LinearLayout row = new LinearLayout(this);
        for (String option : new String[] { "2x1", "3x2", "4x3" }) {
            Button button = new Button(this); button.setText(option); button.setOnClickListener(v -> { getIntent().putExtra("size", option); show(); }); row.addView(button);
        }
        root.addView(row);
        AppWidgetProviderInfo info = null;
        for (AppWidgetProviderInfo item : AppWidgetManager.getInstance(this).getInstalledProviders()) if (item.provider.equals(MagiWidgetProvider.component(this))) info = item;
        if (info == null) { finish(); return; }
        AppWidgetHostView host = new AppWidgetHostView(this); host.setAppWidget(0, info); host.setPadding(0, 0, 0, 0);
        FrameLayout box = new FrameLayout(this); box.addView(host, new FrameLayout.LayoutParams(dp(width), dp(height))); root.addView(box);
        setContentView(root);
        host.updateAppWidget(MagiWidgetProvider.responsive(this, new Bundle()));
    }
}
