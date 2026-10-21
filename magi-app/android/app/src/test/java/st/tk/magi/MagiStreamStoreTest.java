package st.tk.magi;

import org.junit.Test;
import static org.junit.Assert.*;

public class MagiStreamStoreTest {
    @Test public void titleKeepsWhitespaceAndReplacesControlCharacters() {
        assertEquals("", MagiStreamStore.cleanTitle(""));
        assertEquals("  題名  続き ", MagiStreamStore.cleanTitle("  題名  続き "));
        assertEquals("題名   続き", MagiStreamStore.cleanTitle("題名\n\t\u200b続き"));
    }
    @Test public void titleKeepsTheExistingUtf16Boundary() {
        String prefix = new String(new char[199]).replace('\0', 'あ');
        assertEquals(prefix, MagiStreamStore.cleanTitle(prefix));
        assertEquals(prefix + "い", MagiStreamStore.cleanTitle(prefix + "いう"));
        // 既存の通知題名の切り方を維持し、ウィジェットのコードポイント単位へ寄せない。
        String result = MagiStreamStore.cleanTitle(prefix + "😀");
        assertEquals(200, result.length());
        assertTrue(Character.isHighSurrogate(result.charAt(199)));
    }
}
