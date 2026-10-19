package st.tk.magi;

import static org.junit.Assert.*;
import java.net.InetAddress;
import java.util.Collections;
import java.util.concurrent.TimeUnit;
import okhttp3.Cookie;
import okhttp3.CookieJar;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okio.Buffer;
import okio.GzipSink;
import org.junit.Test;

public class MagiArticleReaderTest {
    private MagiArticleReader reader(MockWebServer server) {
        return new MagiArticleReader(new OkHttpClient.Builder().dns(host -> Collections.singletonList(InetAddress.getByName("127.0.0.1"))).build());
    }
    private String url(MockWebServer server) { return "http://article.test:" + server.getPort() + "/"; }
    @Test public void rejectsPrivateAndNonHttpUrls() throws Exception {
        for (String url : new String[] { "http://127.0.0.1/", "http://127.1/", "http://2130706433/", "http://0x7f000001/", "http://10.1.2.3/", "http://172.16.1.1/", "http://192.168.1.2/", "http://169.254.1.1/", "http://localhost/", "http://a.localhost./", "http://[::1]/", "http://[fc00::1]/", "http://[fe80::1]/", "http://[::ffff:127.0.0.1]/", "file:///x", "https://u:p@example.com/" }) {
            try { MagiArticleReader.publicUrl(url); fail(url); } catch (Exception expected) { }
        }
        assertNotNull(MagiArticleReader.publicUrl("https://[2606:4700:4700::1111]/"));
    }
    @Test public void noCookiesEvenWhenBaseClientHasJarAndRedirectSetsCookie() throws Exception {
        try (MockWebServer server = new MockWebServer()) {
            server.start(); server.enqueue(new MockResponse().setResponseCode(302).addHeader("Location", "/article").addHeader("Set-Cookie", "secret=1"));
            server.enqueue(new MockResponse().addHeader("Content-Type", "text/html; charset=Shift_JIS").setBody(new Buffer().write(new byte[] { (byte)0x93, (byte)0xfa })));
            OkHttpClient base = new OkHttpClient.Builder().dns(host -> Collections.singletonList(InetAddress.getByName("127.0.0.1")))
                .cookieJar(new CookieJar() {
                    public java.util.List<Cookie> loadForRequest(HttpUrl url) { return Collections.singletonList(new Cookie.Builder().name("old").value("secret").domain("article.test").build()); }
                    public void saveFromResponse(HttpUrl url, java.util.List<Cookie> cookies) { }
                }).build();
            MagiArticleReader reader = new MagiArticleReader(base);
            try {
                MagiArticleReader.Document doc = reader.read(url(server)); assertEquals(2, doc.bytes.length); assertTrue(doc.url.endsWith("/article"));
                assertNull(server.takeRequest().getHeader("Cookie")); assertNull(server.takeRequest().getHeader("Cookie"));
            } finally { reader.close(); }
        }
    }
    @Test public void redirectsAreValidatedAndFourthHopIsNeverSent() throws Exception {
        try (MockWebServer server = new MockWebServer()) {
            server.start(); server.enqueue(new MockResponse().setResponseCode(302).addHeader("Location", "http://127.0.0.1/secret"));
            MagiArticleReader reader = reader(server);
            try { try { reader.read(url(server)); fail(); } catch (Exception expected) { } assertEquals(1, server.getRequestCount()); }
            finally { reader.close(); }
        }
        try (MockWebServer server = new MockWebServer()) {
            server.start(); for (int i = 0; i < 5; i++) server.enqueue(new MockResponse().setResponseCode(302).addHeader("Location", "/hop" + i));
            MagiArticleReader reader = reader(server);
            try { try { reader.read(url(server)); fail(); } catch (Exception expected) { } assertEquals(4, server.getRequestCount()); }
            finally { reader.close(); }
        }
    }
    @Test public void rejectsNonHtmlAndOversizedChunkedOrGzipBody() throws Exception {
        for (int kind = 0; kind < 3; kind++) try (MockWebServer server = new MockWebServer()) {
            server.start(); MockResponse response = new MockResponse();
            if (kind == 0) response.addHeader("Content-Type", "application/pdf").setBody("pdf");
            else {
                Buffer body = new Buffer().write(new byte[MagiArticleReader.LIMIT + 1]);
                response.addHeader("Content-Type", "text/html");
                if (kind == 1) response.setChunkedBody(body, 8192);
                else {
                    Buffer compressed = new Buffer(); try (GzipSink gzip = new GzipSink(compressed)) { gzip.write(body, body.size()); }
                    response.addHeader("Content-Encoding", "gzip").setBody(compressed);
                }
            }
            server.enqueue(response); MagiArticleReader reader = reader(server);
            try { try { reader.read(url(server)); fail(); } catch (Exception expected) { } } finally { reader.close(); }
        }
    }
    @Test public void delayedBodyIsCutOffWithinEightSeconds() throws Exception {
        try (MockWebServer server = new MockWebServer()) {
            server.start(); server.enqueue(new MockResponse().addHeader("Content-Type", "text/html").setBody("slow").setBodyDelay(12, TimeUnit.SECONDS));
            MagiArticleReader reader = reader(server); long start = System.nanoTime();
            try { try { reader.read(url(server)); fail(); } catch (Exception expected) { } assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start) < 10000); }
            finally { reader.close(); }
        }
    }
}
