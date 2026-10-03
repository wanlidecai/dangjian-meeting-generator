package cn.wanlidecai.dangjian;

import io.netty.channel.ChannelOption;
import java.net.InetAddress;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.http.client.reactive.ReactorClientHttpConnector;
import org.springframework.stereotype.Service;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.netty.http.client.HttpClient;

/** Public reference lookup. This client never carries API keys or login cookies. */
@Service
public class SourceSearchService implements org.springframework.beans.factory.DisposableBean {
    private static final Set<String> HOSTS = Set.of("sogou.com", "so.com", "bing.com",
        "people.com.cn", "xinhuanet.com", "news.cn", "12371.cn", "qstheory.cn",
        "gov.cn", "dangjian.cn", "ccdi.gov.cn", "cctv.com", "gmw.cn", "china.com.cn");
    private static final Pattern H3 = Pattern.compile("<h3[^>]*>(.*?)</h3>", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Pattern LINK = Pattern.compile("<a[^>]*href=[\"']([^\"']+)[\"'][^>]*>", Pattern.CASE_INSENSITIVE);
    private static final Pattern ITEM = Pattern.compile("<item>(.*?)</item>", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    private static final Pattern REDIRECT = Pattern.compile("window\\.location(?:\\.replace|\\.href)\\s*[=(]\\s*[\"']([^\"']+)[\"']", Pattern.CASE_INSENSITIVE);
    private final WebClient client;
    private final PublicAddressResolverGroup resolver;

    public SourceSearchService() {
        this(new PublicAddressResolverGroup());
    }

    private SourceSearchService(PublicAddressResolverGroup resolver) {
        this.resolver = resolver;
        this.client = WebClient.builder()
            .clientConnector(new ReactorClientHttpConnector(HttpClient.create()
                .resolver(resolver)
                .followRedirect(false)
                .option(ChannelOption.CONNECT_TIMEOUT_MILLIS, 4000)
                .responseTimeout(Duration.ofSeconds(6))))
            .codecs(codec -> codec.defaultCodecs().maxInMemorySize(1024 * 1024))
            .build();
    }

    SourceSearchService(WebClient client) {
        this.client = client;
        this.resolver = null;
    }

    @Override
    public void destroy() {
        if (resolver != null) {
            resolver.close();
        }
    }

    public Mono<List<SourceMaterial>> search(List<String> topics, boolean enabled) {
        if (!enabled) {
            return Mono.just(topics.stream().map(topic -> fallback(topic, "检索已关闭，按议题生成")).toList());
        }
        return Flux.range(0, topics.size())
            .flatMapSequential(index -> searchTopic(topics.get(index), index == 0)
                .timeout(Duration.ofSeconds(25))
                .onErrorReturn(fallback(topics.get(index), "未取得公开参考材料，按议题生成")), 3)
            .collectList()
            .timeout(Duration.ofSeconds(35))
            .onErrorReturn(topics.stream().map(topic -> fallback(topic, "检索超时，按议题生成")).toList());
    }

    private Mono<SourceMaterial> searchTopic(String topic, boolean first) {
        String query = URLEncoder.encode(topic + " 原文", StandardCharsets.UTF_8);
        var engines = List.of(
            new Engine("搜狗搜索", "https://www.sogou.com/web?query=" + query, false),
            new Engine("360搜索", "https://www.so.com/s?q=" + query, false),
            new Engine("必应搜索", "https://cn.bing.com/search?q=" + query + "&format=rss&count=8&mkt=zh-CN", true));
        return Flux.fromIterable(engines)
            .concatMap(engine -> fetch(engine.url(), 0)
                .map(text -> engine.rss() ? parseRss(text) : parseHtml(text))
                .filter(results -> !results.isEmpty())
                .flatMap(results -> selectSource(topic, first ? 320 : 180, engine.name(), results)))
            .next().defaultIfEmpty(fallback(topic, "未取得公开参考材料，按议题生成"));
    }

    private Mono<SourceMaterial> selectSource(String topic, int maxChars, String engine,
                                             List<SearchResult> results) {
        var sorted = results.stream().sorted(Comparator.comparingInt(
            (SearchResult result) -> hits(result.title() + " " + result.snippet(), topic)).reversed()).limit(4).toList();
        return Flux.fromIterable(sorted)
            .concatMap(result -> resolve(result.url())
                .flatMap(url -> fetch(url, 0).map(html ->
                    new SourceMaterial(topic, engine, url, excerpt(stripHtml(html), maxChars, topic))))
                .filter(material -> material.excerpt().length() >= 50 && hits(material.excerpt(), topic) > 0))
            .next()
            .switchIfEmpty(Mono.fromSupplier(() -> {
                String snippet = excerpt(String.join(" ", sorted.stream().map(SearchResult::snippet).toList()), maxChars, topic);
                if (snippet.isBlank()) {
                    return fallback(topic, "检索未取得可用正文，按议题生成");
                }
                String link = sorted.stream().map(SearchResult::url).filter(SourceSearchService::allowedUrl).findFirst().orElse("");
                return new SourceMaterial(topic, engine + "（搜索摘要）", link, snippet);
            }));
    }

    private Mono<String> resolve(String raw) {
        String url = raw.startsWith("/link?") ? "https://www.sogou.com" + raw : raw;
        if (!allowedUrl(url)) {
            return Mono.empty();
        }
        if (url.contains("sogou.com/link?") || url.contains("so.com/link?")) {
            return fetch(url, 0).flatMap(html -> {
                var match = REDIRECT.matcher(html);
                return match.find() && allowedUrl(decode(match.group(1)))
                    ? Mono.just(decode(match.group(1))) : Mono.empty();
            });
        }
        return Mono.just(url);
    }

    private Mono<String> fetch(String raw, int redirects) {
        if (!allowedUrl(raw) || redirects > 3) {
            return Mono.empty();
        }
        URI uri = URI.create(raw);
        return client.get().uri(uri)
                .header("User-Agent", "Mozilla/5.0 Halo-Dangjian/1.0")
                .header("Accept-Language", "zh-CN,zh;q=0.9")
                .exchangeToMono(response -> {
                    if (response.statusCode().is3xxRedirection()) {
                        URI location = response.headers().asHttpHeaders().getLocation();
                        return response.releaseBody().then(location == null ? Mono.empty()
                            : fetch(uri.resolve(location).toString(), redirects + 1));
                    }
                    if (!response.statusCode().is2xxSuccessful()) {
                        return response.releaseBody().then(Mono.empty());
                    }
                    return response.bodyToMono(String.class);
                })
            .timeout(Duration.ofSeconds(7))
            .onErrorResume(error -> Mono.empty());
    }

    static boolean allowedUrl(String raw) {
        if (raw == null || raw.isBlank()) {
            return false;
        }
        try {
            URI uri = URI.create(raw);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getUserInfo() != null
                || uri.getHost() == null || (uri.getPort() != -1 && uri.getPort() != 443)) {
                return false;
            }
            String host = uri.getHost().toLowerCase(Locale.ROOT);
            return HOSTS.stream().anyMatch(domain -> host.equals(domain) || host.endsWith("." + domain));
        } catch (IllegalArgumentException error) {
            return false;
        }
    }

    static boolean privateAddress(InetAddress address) {
        return PublicAddressResolverGroup.blockedAddress(address);
    }

    static List<SearchResult> parseHtml(String html) {
        var results = new ArrayList<SearchResult>();
        var headings = H3.matcher(html);
        while (headings.find() && results.size() < 8) {
            var link = LINK.matcher(headings.group(1));
            if (!link.find()) {
                continue;
            }
            String title = stripHtml(headings.group(1));
            String rest = html.substring(headings.end(), Math.min(html.length(), headings.end() + 1600));
            var nextHeading = H3.matcher(rest);
            if (nextHeading.find()) {
                rest = rest.substring(0, nextHeading.start());
            }
            String snippet = stripHtml(rest);
            results.add(new SearchResult(title, decode(link.group(1)), snippet.substring(0, Math.min(260, snippet.length()))));
        }
        return results;
    }

    static List<SearchResult> parseRss(String xml) {
        var results = new ArrayList<SearchResult>();
        var items = ITEM.matcher(xml);
        while (items.find() && results.size() < 8) {
            String block = items.group(1);
            String title = decode(tag(block, "title"));
            String link = decode(tag(block, "link"));
            if (!title.isBlank() && !link.isBlank()) {
                results.add(new SearchResult(title, link, stripHtml(decode(tag(block, "description")))));
            }
        }
        return results;
    }

    private static String tag(String text, String name) {
        var match = Pattern.compile("<" + name + "[^>]*>(.*?)</" + name + ">", Pattern.DOTALL).matcher(text);
        return match.find() ? match.group(1) : "";
    }

    static String stripHtml(String value) {
        return decode(value.replaceAll("(?is)<(script|style)\\b[^>]*>.*?</\\1>", " ")
            .replaceAll("(?s)<!--.*?-->", " ").replaceAll("<[^>]+>", " "))
            .replaceAll("\\s+", " ").trim();
    }

    private static String decode(String value) {
        String text = value.replaceAll("(?s)<!\\[CDATA\\[(.*?)]]>", "$1")
            .replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">")
            .replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&");
        var entities = Pattern.compile("&#(x[0-9a-fA-F]+|[0-9]+);").matcher(text);
        var decoded = new StringBuilder();
        while (entities.find()) {
            String valueCode = entities.group(1);
            try {
                int code = valueCode.startsWith("x") ? Integer.parseInt(valueCode.substring(1), 16) : Integer.parseInt(valueCode);
                entities.appendReplacement(decoded, java.util.regex.Matcher.quoteReplacement(new String(Character.toChars(code))));
            } catch (IllegalArgumentException invalid) {
                entities.appendReplacement(decoded, " ");
            }
        }
        return entities.appendTail(decoded).toString();
    }

    static String excerpt(String text, int maxChars, String topic) {
        String cleaned = stripHtml(text).replaceAll("https?://\\S+", "").trim();
        if (cleaned.length() <= maxChars) {
            return cleaned;
        }
        int best = 0;
        int score = -1;
        for (int offset = 0; offset < cleaned.length(); offset += 30) {
            String window = cleaned.substring(offset, Math.min(cleaned.length(), offset + maxChars));
            int current = hits(window, topic);
            if (current > score) {
                best = offset;
                score = current;
            }
        }
        return cleaned.substring(best, Math.min(cleaned.length(), best + maxChars));
    }

    static int hits(String text, String topic) {
        String compact = topic.replaceAll("[\\p{Punct}\\p{P}\\s]", "");
        int count = 0;
        for (int offset = 0; offset + 2 <= compact.length(); offset++) {
            if (text.contains(compact.substring(offset, offset + 2))) {
                count++;
            }
        }
        return count;
    }

    private static SourceMaterial fallback(String topic, String reason) {
        return new SourceMaterial(topic, reason, "", "");
    }

    record SearchResult(String title, String url, String snippet) { }
    private record Engine(String name, String url, boolean rss) { }
}
