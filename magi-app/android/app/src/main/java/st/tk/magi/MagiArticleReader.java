package st.tk.magi;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.InetAddress;
import java.util.concurrent.TimeUnit;
import okhttp3.CookieJar;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/** 共有されたURLだけを読む。端末のCookie・WebView・認証情報を引き継がない。 */
final class MagiArticleReader {
    static final int LIMIT = 2 * 1024 * 1024;
    private final OkHttpClient http;
    MagiArticleReader() { this(new OkHttpClient()); }
    // 同一の制限を保ったまま、単体検証だけでDNSを模擬へ替える。
    MagiArticleReader(OkHttpClient base) {
        http = base.newBuilder().cookieJar(CookieJar.NO_COOKIES).followRedirects(false).followSslRedirects(false)
            .callTimeout(8, TimeUnit.SECONDS).connectTimeout(8, TimeUnit.SECONDS).readTimeout(8, TimeUnit.SECONDS).build();
    }
    static HttpUrl publicUrl(String input) throws Exception {
        if (input.length() > 2000) throw new IllegalArgumentException();
        HttpUrl url = HttpUrl.get(input);
        String host = url.host().toLowerCase(java.util.Locale.ROOT);
        if (host.endsWith(".")) host = host.substring(0, host.length() - 1);
        if (host.matches("(?i)(0x[0-9a-f]+|[0-9]+)(\\.(0x[0-9a-f]+|[0-9]+))*") && host.contains("0x")) throw new IllegalArgumentException();
        if (!url.username().isEmpty() || !url.password().isEmpty() || host.equals("localhost") || host.endsWith(".localhost")) throw new IllegalArgumentException();
        // DNS名は解決しない。DNSで私用アドレスへ向く名前は識別しない。
        if (host.contains(":") || host.matches("[0-9.]+")) {
            InetAddress address = InetAddress.getByName(host);
            byte[] bytes = address.getAddress();
            if (address.isAnyLocalAddress() || address.isLoopbackAddress() || address.isLinkLocalAddress() || address.isSiteLocalAddress() || address.isMulticastAddress()
                || bytes.length == 16 && (bytes[0] & 0xfe) == 0xfc || bytes.length == 4 && (bytes[0] & 255) == 0) throw new IllegalArgumentException();
        }
        return url;
    }
    static final class Document {
        final String url, contentType;
        final byte[] bytes;
        Document(String url, String type, byte[] bytes) { this.url = url; contentType = type; this.bytes = bytes; }
    }
    Document read(String input) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(8);
        HttpUrl url = publicUrl(input);
        for (int redirects = 0; ; redirects++) {
            long remaining = deadline - System.nanoTime();
            if (remaining <= 0) throw new IllegalArgumentException();
            okhttp3.Call request = http.newCall(new Request.Builder().url(url).header("Accept", "text/html,application/xhtml+xml").build());
            request.timeout().timeout(remaining, TimeUnit.NANOSECONDS);
            try (Response response = request.execute()) {
                int status = response.code();
                if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                    String location = response.header("Location");
                    if (redirects >= 3 || location == null) throw new IllegalArgumentException();
                    HttpUrl next = url.resolve(location); if (next == null) throw new IllegalArgumentException();
                    url = publicUrl(next.toString()); continue;
                }
                String contentType = response.header("Content-Type", "");
                String mime = contentType.split(";", 2)[0].trim().toLowerCase(java.util.Locale.ROOT);
                if (!response.isSuccessful() || !(mime.equals("text/html") || mime.equals("application/xhtml+xml"))
                    || response.body() == null || response.body().contentLength() > LIMIT) throw new IllegalArgumentException();
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                try (InputStream stream = response.body().byteStream()) {
                    byte[] buffer = new byte[8192]; int n;
                    while ((n = stream.read(buffer)) != -1) {
                        if (bytes.size() + n > LIMIT || System.nanoTime() > deadline) throw new IllegalArgumentException();
                        bytes.write(buffer, 0, n);
                    }
                }
                return new Document(url.toString(), contentType, bytes.toByteArray());
            }
        }
    }
    void close() { http.dispatcher().cancelAll(); http.connectionPool().evictAll(); }
}
