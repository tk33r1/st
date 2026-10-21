package st.tk.magi;

/** ウィジェット用の小さい表示情報。会話ファイルの正本は持たない。 */
final class MagiWidgetData {
    final String sessionId, title, summary, verdict;
    /** 受信中と保存済みSSEの読直しで、統合の本文と決議を同じ規則で集める。 */
    static final class Collector {
        private final StringBuilder answer = new StringBuilder(); private String verdict = "";
        void accept(String event, com.getcapacitor.JSObject data) {
            if ("integrated".equals(event) && data.opt("delta") instanceof String) answer.append(data.getString("delta"));
            if ("verdict".equals(event)) {
                org.json.JSONObject tally = data.optJSONObject("tally");
                verdict = tally == null ? "" : MagiWidgetData.verdict(data.getString("result", ""), tally.opt("approve"), tally.opt("reject"), tally.opt("none"));
            }
        }
        boolean hasText() { return answer.length() > 0; }
        boolean hasAnswer() { return !answer.toString().trim().isEmpty(); }
        MagiWidgetData data(String sessionId, String title) { return new MagiWidgetData(sessionId, title, answer.toString(), verdict); }
    }
    MagiWidgetData(String id, String title, String summary, String verdict) {
        sessionId = MagiStreamStore.validId(id) ? id : "";
        this.title = sessionId.isEmpty() ? "" : text(title, 200);
        this.summary = sessionId.isEmpty() ? "" : text(summary, 120);
        this.verdict = !sessionId.isEmpty() && ("approve".equals(verdict) || "reject".equals(verdict) || "hold".equals(verdict)) ? verdict : "";
    }
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
