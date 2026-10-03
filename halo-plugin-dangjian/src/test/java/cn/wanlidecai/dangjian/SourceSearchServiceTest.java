package cn.wanlidecai.dangjian;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.InetAddress;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;

class SourceSearchServiceTest {
    @Test
    void officialDomainsAndTheirActualSubdomainsAreAllowedOverHttps() {
        for (String host : List.of("sogou.com", "so.com", "bing.com", "people.com.cn", "xinhuanet.com",
            "news.cn", "12371.cn", "qstheory.cn", "gov.cn", "dangjian.cn", "ccdi.gov.cn",
            "cctv.com", "gmw.cn", "china.com.cn")) {
            assertTrue(SourceSearchService.allowedUrl("https://" + host + "/article"), host);
            assertTrue(SourceSearchService.allowedUrl("https://www." + host + ":443/article?q=党建"), host);
        }
        assertTrue(SourceSearchService.allowedUrl("HTTPS://WWW.GOV.CN/article"));
        assertTrue(SourceSearchService.allowedUrl("https://news.people.com.cn/articles?id=1&sort=recent"));
    }

    @Test
    void lookalikeDomainsCredentialsPortsAndNonHttpsSchemesAreRejected() {
        for (String raw : List.of("https://evilgov.cn/article", "https://not-gov.cn/article",
            "https://gov.cn.attacker.invalid/", "https://www.gov.cn.attacker.invalid/",
            "https://attacker.invalid/gov.cn", "https://gov.cn@attacker.invalid/",
            "https://attacker.invalid@gov.cn/", "https://user:password@gov.cn/",
            "https://gov.cn:80/", "https://gov.cn:444/", "http://gov.cn/", "ftp://gov.cn/",
            "file:///etc/passwd", "javascript:alert(1)", "//gov.cn/article", "/article",
            "https:///gov.cn", "https://gov%2ecn/", "https://gov.cn\\@127.0.0.1/", "")) {
            assertFalse(SourceSearchService.allowedUrl(raw), raw);
        }
    }

    @Test
    void literalIpAddressesCannotBypassTheDomainAllowlist() {
        for (String host : List.of("127.0.0.1", "10.0.0.1", "169.254.169.254", "8.8.8.8",
            "2130706433", "0x7f000001", "[::1]", "[fc00::1]", "[2606:4700:4700::1111]")) {
            assertFalse(SourceSearchService.allowedUrl("https://" + host + "/"), host);
        }
    }

    @Test
    void absentUrlIsRejectedWithoutThrowing() {
        assertFalse(SourceSearchService.allowedUrl(null));
    }

    @Test
    void ipv4PrivateLocalMulticastSharedAndBenchmarkAddressesAreBlocked() throws Exception {
        for (String raw : List.of("0.0.0.0", "127.0.0.1", "127.255.255.254", "10.0.0.1",
            "10.255.255.254", "172.16.0.1", "172.31.255.254", "192.168.0.1", "192.168.255.254",
            "169.254.0.1", "169.254.169.254", "224.0.0.1", "239.255.255.254",
            "100.64.0.1", "100.127.255.254", "198.18.0.1", "198.19.255.254")) {
            assertTrue(SourceSearchService.privateAddress(InetAddress.getByName(raw)), raw);
        }
    }

    @Test
    void ipv4SpecialLocalAndReservedNetworksAreNotPublicDestinations() throws Exception {
        for (String raw : List.of("0.0.0.1", "0.255.255.254", "240.0.0.1", "254.255.255.254", "255.255.255.255")) {
            assertTrue(SourceSearchService.privateAddress(InetAddress.getByName(raw)), raw);
        }
    }

    @Test
    void ipv6LocalUniqueLocalMulticastAndMappedPrivateAddressesAreBlocked() throws Exception {
        for (String raw : List.of("::", "::1", "fe80::1", "fec0::1", "fc00::1", "fdff:ffff::1",
            "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:192.168.1.1")) {
            assertTrue(SourceSearchService.privateAddress(InetAddress.getByName(raw)), raw);
        }
    }

    @Test
    void deprecatedIpv4CompatibleIpv6AddressesCannotReachLocalServices() throws Exception {
        for (String raw : List.of("::127.0.0.1", "::10.0.0.1", "::192.168.1.1")) {
            assertTrue(SourceSearchService.privateAddress(InetAddress.getByName(raw)), raw);
        }
    }

    @Test
    void publicAddressesAndAddressesOutsidePrivateRangeBoundariesRemainUsable() throws Exception {
        for (String raw : List.of("8.8.8.8", "1.1.1.1", "172.15.255.254", "172.32.0.1",
            "100.63.255.254", "100.128.0.1", "198.17.255.254", "198.20.0.1",
            "2606:4700:4700::1111", "2001:4860:4860::8888")) {
            assertFalse(SourceSearchService.privateAddress(InetAddress.getByName(raw)), raw);
        }
    }

    @Test
    void htmlResultsDecodeLinksAndKeepEachSnippetWithItsHeading() {
        var results = SourceSearchService.parseHtml("""
            <h3>没有链接的标题</h3><p>忽略此项</p>
            <H3 class="result"><a href="https://www.gov.cn/article?a=1&amp;b=2"><em>基层</em>党建&#x5DE5;作</a></H3>
            <p>第一项&nbsp;公开材料。</p><script>doNotIncludeScript()</script><!-- 隐藏注释 -->
            <h3><a href='/link?url=article'>第二项</a></h3><div>第二项摘要。</div>
            """);
        assertEquals(2, results.size());
        assertEquals("基层 党建工作", results.getFirst().title());
        assertEquals("https://www.gov.cn/article?a=1&b=2", results.getFirst().url());
        assertEquals("第一项 公开材料。", results.getFirst().snippet());
        assertEquals("/link?url=article", results.getLast().url());
        assertEquals("第二项摘要。", results.getLast().snippet());
    }

    @Test
    void htmlResultAndSnippetLimitsBoundSearchMaterial() {
        StringBuilder html = new StringBuilder();
        for (int index = 0; index < 12; index++) {
            html.append("<h3><a href='https://gov.cn/").append(index).append("'>标题")
                .append(index).append("</a></h3><p>").append("字".repeat(400)).append("</p>");
        }
        var results = SourceSearchService.parseHtml(html.toString());
        assertEquals(8, results.size());
        assertTrue(results.stream().allMatch(result -> result.snippet().length() == 260));
    }

    @Test
    void rssResultsDecodeCdataEntitiesAndSkipIncompleteItemsWithoutResolvingExternalEntities() {
        var results = SourceSearchService.parseRss("""
            <?xml version="1.0"?>
            <!DOCTYPE rss [<!ENTITY local SYSTEM "file:///etc/passwd">]>
            <rss><channel>
              <item><title><![CDATA[基层党建 &amp; 学习]]></title>
                <link>https://www.12371.cn/article?a=1&amp;b=2</link>
                <description><![CDATA[<p>党员&#25945;育</p><script>hiddenScript()</script>]]></description></item>
              <item><title>没有链接</title><description>不应选取</description></item>
              <item><link>https://gov.cn/missing-title</link></item>
              <item><title>第二项</title><link>https://gov.cn/second</link><description>&local;</description></item>
            </channel></rss>
            """);
        assertEquals(2, results.size());
        assertEquals("基层党建 & 学习", results.getFirst().title());
        assertEquals("https://www.12371.cn/article?a=1&b=2", results.getFirst().url());
        assertEquals("党员教育", results.getFirst().snippet());
        assertEquals("&local;", results.getLast().snippet());
    }

    @Test
    void rssResultLimitAndMalformedInputsAreHandledWithoutNetworkAccess() {
        String item = "<item><title>议题</title><link>https://gov.cn/article</link><description>正文</description></item>";
        assertEquals(8, SourceSearchService.parseRss("<rss>" + item.repeat(12) + "</rss>").size());
        assertTrue(SourceSearchService.parseRss("<item><title>未关闭").isEmpty());
        assertTrue(SourceSearchService.parseHtml("<h3><a href='https://gov.cn'>未关闭").isEmpty());
        assertTrue(SourceSearchService.parseHtml("").isEmpty());
    }

    @Test
    void htmlCleanupRemovesActiveContentCommentsAndInvalidNumericEntities() {
        String content = "<style>hiddenStyle</style><script>hiddenScript</script><!-- secret -->"
            + "<p>党员&nbsp;教育&#x3002;</p><p>公开&#25991;字 &amp; 内容 &#1114112;</p>";
        assertEquals("党员 教育。 公开文字 & 内容", SourceSearchService.stripHtml(content));
    }

    @Test
    void excerptsPreferTopicRelevantMaterialAndRespectDifferentMeetingPositionLimits() {
        String topic = "加强基层党组织建设";
        String text = "无关导航内容。".repeat(100) + "<p>" + topic.repeat(40)
            + "</p> https://example.com/ignore";
        for (int maxChars : List.of(320, 180)) {
            String result = SourceSearchService.excerpt(text, maxChars, topic);
            assertTrue(result.length() <= maxChars);
            assertTrue(result.contains(topic));
            assertFalse(result.contains("https://"));
            assertFalse(result.contains("<p>"));
        }
        assertEquals("短参考材料", SourceSearchService.excerpt("<p>短参考材料</p>", 320, topic));
        assertEquals("", SourceSearchService.excerpt("<script>隐藏内容</script>", 180, topic));
    }

    @Test
    void topicScoringIgnoresTopicPunctuationAndWhitespace() {
        assertEquals(SourceSearchService.hits("加强基层党组织建设", "加强基层党组织建设"),
            SourceSearchService.hits("加强基层党组织建设", "加强《基层党组织建设》。"));
        assertTrue(SourceSearchService.hits("党员教育工作", "党员教育") > 0);
        assertEquals(0, SourceSearchService.hits("其他材料", "党员教育"));
    }

    @Test
    void disabledSearchPreservesTopicOrderAndDoesNotCallTheHttpClient() {
        var calls = new AtomicInteger();
        WebClient client = WebClient.builder().exchangeFunction(request -> {
            calls.incrementAndGet();
            return Mono.error(new AssertionError("Disabled lookup must not make HTTP requests"));
        }).build();
        var service = new SourceSearchService(client);
        var topics = List.of("第一议题", "第二议题", "第一议题");
        var materials = service.search(topics, false).block(Duration.ofSeconds(2));
        assertEquals(topics, materials.stream().map(SourceMaterial::topic).toList());
        assertTrue(materials.stream().allMatch(material -> material.source().contains("检索已关闭")));
        assertTrue(materials.stream().allMatch(material -> material.url().isEmpty() && material.excerpt().isEmpty()));
        assertEquals(0, calls.get());
        assertEquals(List.of(), service.search(List.of(), true).block(Duration.ofSeconds(2)));
        assertEquals(0, calls.get());
    }
}
