package st.tk.magi;

import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MagiSharePlugin.class);
        registerPlugin(MagiConversationPlugin.class);
        registerPlugin(MagiWidgetPlugin.class);
        super.onCreate(savedInstanceState);
        // Android 7以降で共通に画面端まで描き、SystemBarsが余白を画面へ伝える。
        EdgeToEdge.enable(this);
    }
    @Override public void onStart() { super.onStart(); MagiConversationService.foreground = true; }
    @Override public void onStop() { MagiConversationService.foreground = false; super.onStop(); }
}
