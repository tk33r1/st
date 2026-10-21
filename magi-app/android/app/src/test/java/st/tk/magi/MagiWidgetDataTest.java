package st.tk.magi;

import org.junit.Test;
import static org.junit.Assert.*;

public class MagiWidgetDataTest {
    @Test public void summaryUsesCodePointsAndNoLineBreaks() {
        String emoji = new String(Character.toChars(0x1f600));
        MagiWidgetData data = new MagiWidgetData("session_1", "題名\n続き", emoji.repeat(121), "approve");
        assertEquals("題名 続き", data.title); assertEquals(120, data.summary.codePointCount(0, data.summary.length()));
        assertEquals(emoji.repeat(120), data.summary); assertEquals("approve", data.verdict);
    }
    @Test public void invalidIdCannotKeepContents() {
        MagiWidgetData data = new MagiWidgetData("../other", "private", "private", "reject");
        assertEquals("", data.sessionId); assertEquals("", data.title); assertEquals("", data.summary); assertEquals("", data.verdict);
    }
    @Test public void stripsControlsAndUnknownVerdict() {
        MagiWidgetData data = new MagiWidgetData("s", "a\u202eb\t c", "x\r\n y", "invalid");
        assertEquals("a b c", data.title); assertEquals("x y", data.summary); assertEquals("", data.verdict);
    }
    @Test public void contradictoryOrMalformedResolutionCannotBeShown() {
        assertEquals("approve", MagiWidgetData.verdict("approve", 2, 1, 0));
        assertEquals("hold", MagiWidgetData.verdict("hold", 1, 1, 1));
        assertEquals("", MagiWidgetData.verdict("approve", 0, 3, 0));
        assertEquals("", MagiWidgetData.verdict("approve", "2", 1, 0));
        assertEquals("", MagiWidgetData.verdict("approve", 2.5, 0.5, 0));
        assertEquals("", MagiWidgetData.verdict("approve", Double.NaN, 1, 0));
    }
}
