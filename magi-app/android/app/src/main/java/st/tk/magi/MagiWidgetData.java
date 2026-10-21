package st.tk.magi;

/** ウィジェット用の小さい表示情報。会話ファイルの正本は持たない。 */
final class MagiWidgetData {
    final String sessionId, title, summary, verdict;
    MagiWidgetData(String id, String title, String summary, String verdict) {
        sessionId = validId(id) ? id : "";
        this.title = sessionId.isEmpty() ? "" : text(title, 200);
        this.summary = sessionId.isEmpty() ? "" : text(summary, 120);
        this.verdict = !sessionId.isEmpty() && ("approve".equals(verdict) || "reject".equals(verdict) || "hold".equals(verdict)) ? verdict : "";
    }
    static boolean validId(String id) { return id != null && id.matches("[a-zA-Z0-9_-]{1,160}"); }
    static String verdict(String result, Object approve, Object reject, Object none) {
        Object[] values = { approve, reject, none }; int[] counts = new int[3];
        for (int n = 0; n < 3; n++) {
            if (!(values[n] instanceof Number)) return "";
            double value = ((Number) values[n]).doubleValue();
            if (value < 0 || value > 3 || value != Math.floor(value)) return "";
            counts[n] = (int) value;
        }
        if (counts[0] + counts[1] + counts[2] != 3) return "";
        String expected = counts[0] >= 2 ? "approve" : counts[1] >= 2 ? "reject" : "hold";
        return expected.equals(result) ? expected : "";
    }
    static String text(String raw, int limit) {
        if (raw == null) return "";
        String value = raw.replaceAll("[\\p{Cntrl}\\p{Cf}\\p{Z}\\s]+", " ").trim();
        return value.substring(0, value.offsetByCodePoints(0, Math.min(limit, value.codePointCount(0, value.length()))));
    }
}
