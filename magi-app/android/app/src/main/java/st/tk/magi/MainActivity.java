package st.tk.magi;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // プロセスの終了後に復元されると、最初に起動したときのウィジェット・通知のリンクがもう一度渡る。
        // 古いリンクでカメラ・アルバム・音声入力を開き直したり会話を切り替えたりしないよう、ここで捨てる。
        Uri link = getIntent() == null ? null : getIntent().getData();
        if (savedInstanceState != null && link != null && "magi".equals(link.getScheme())) setIntent(new Intent(Intent.ACTION_MAIN));
        registerPlugin(MagiSharePlugin.class);
        registerPlugin(MagiConversationPlugin.class);
        registerPlugin(MagiWidgetPlugin.class);
        registerPlugin(MagiUpdatePlugin.class);
        super.onCreate(savedInstanceState);
        // Android 7以降で共通に画面端まで描き、SystemBarsが余白を画面へ伝える。
        EdgeToEdge.enable(this);
    }
    @Override public void onStart() { super.onStart(); MagiConversationService.foreground = true; }
    @Override public void onStop() { MagiConversationService.foreground = false; super.onStop(); }
}
