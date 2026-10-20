package st.tk.magi;

import java.io.BufferedReader;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;

/** 分割UTF-8・CRLF・複数data行を読む。期限と取消はHTTP接続が担当する。 */
final class MagiSseReader {
    static final int MAX_BYTES = 2 * 1024 * 1024;
    interface EventSink { boolean accept(String event, String data) throws Exception; }
    static void read(InputStream input, EventSink sink) throws Exception {
        InputStream limited = new FilterInputStream(input) {
            int count;
            private void count(int n) throws IOException { if (n > 0 && (count += n) > MAX_BYTES) throw new IOException("response_too_large"); }
            @Override public int read() throws IOException { int value = super.read(); if (value >= 0) count(1); return value; }
            @Override public int read(byte[] bytes, int start, int length) throws IOException {
                int n = in.read(bytes, start, Math.min(length, MAX_BYTES - count + 1)); count(n); return n;
            }
        };
        BufferedReader reader = new BufferedReader(new InputStreamReader(limited,
            StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)));
        String event = "", line; StringBuilder data = new StringBuilder(); boolean first = true;
        while ((line = reader.readLine()) != null) {
            if (first) { first = false; if (line.startsWith("\ufeff")) line = line.substring(1); }
            if (line.isEmpty()) {
                if (data.length() > 0 && sink.accept(event, data.substring(0, data.length() - 1))) return;
                event = ""; data.setLength(0); continue;
            }
            if (line.startsWith(":")) continue;
            int colon = line.indexOf(':');
            String key = colon < 0 ? line : line.substring(0, colon);
            String value = colon < 0 ? "" : line.substring(colon + 1);
            if (value.startsWith(" ")) value = value.substring(1);
            if (key.equals("event")) event = value;
            else if (key.equals("data")) data.append(value).append('\n');
        }
        // 空行の無い末尾の断片はdispatchしない。正常なdoneは必ず空行で終わる。
        throw new IOException("incomplete_reply");
    }
}
