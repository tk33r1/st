package st.tk.magi;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;

/** 通知とウィジェットの画面起動。用途ごとのrequestCodeは呼出側で保持する。 */
final class MagiAppLink {
    static PendingIntent create(Context context, String action, String id, int requestCode) {
        Uri.Builder uri = new Uri.Builder().scheme("magi").authority(action);
        if ("open".equals(action)) uri.appendQueryParameter("id", id);
        Intent intent = new Intent(context, MainActivity.class).setAction(Intent.ACTION_VIEW).setData(uri.build())
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(context, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
