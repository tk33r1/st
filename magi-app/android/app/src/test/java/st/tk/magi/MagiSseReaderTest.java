package st.tk.magi;

import org.junit.Test;
import static org.junit.Assert.*;
import java.io.ByteArrayInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

public class MagiSseReaderTest {
    @Test public void splitUtf8CrLfCommentsAndMultilineData() throws Exception {
        byte[] bytes = ("\ufeff: ping\r\nevent: integrated\r\ndata: 日本語\r\ndata: 次の行\r\n\r\nevent: done\ndata: {}\n\n").getBytes(StandardCharsets.UTF_8);
        List<String> events = new ArrayList<>();
        MagiSseReader.read(new FilterInputStream(new ByteArrayInputStream(bytes)) {
            @Override public int read(byte[] out, int offset, int length) throws IOException { return super.read(out, offset, Math.min(1, length)); }
        }, (event, data) -> { events.add(event + ":" + data); return event.equals("done"); });
        assertEquals("integrated:日本語\n次の行", events.get(0)); assertEquals("done:{}", events.get(1));
    }
    @Test public void missingTerminalAndIncompleteEventFail() throws Exception {
        for (String text : new String[] { "", "event: done\ndata: {}", "event: integrated\ndata: {}\n\n" }) {
            try { MagiSseReader.read(new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8)), (event, data) -> event.equals("done")); fail(); }
            catch (IOException expected) { assertEquals("incomplete_reply", expected.getMessage()); }
        }
    }
    @Test public void overLimitAndMalformedUtf8Fail() throws Exception {
        for (byte[] bytes : new byte[][] { new byte[MagiSseReader.MAX_BYTES + 1], { (byte) 0xc0, (byte) 0xaf } }) {
            try { MagiSseReader.read(new ByteArrayInputStream(bytes), (event, data) -> false); fail(); }
            catch (IOException expected) { }
        }
    }
    @Test public void terminalDoesNotWaitForAnotherRead() throws Exception {
        MagiSseReader.read(new ByteArrayInputStream("event: done\ndata: {}\n\nnever read".getBytes(StandardCharsets.UTF_8)), (event, data) -> true);
    }
}
