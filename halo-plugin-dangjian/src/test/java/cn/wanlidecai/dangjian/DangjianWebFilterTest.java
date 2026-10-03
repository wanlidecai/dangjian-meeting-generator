package cn.wanlidecai.dangjian;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.net.URI;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.mock.http.server.reactive.MockServerHttpRequest;
import org.springframework.mock.web.server.MockServerWebExchange;
import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.AuthorityUtils;
import org.springframework.security.web.server.csrf.CookieServerCsrfTokenRepository;
import org.springframework.security.web.server.csrf.CsrfToken;
import org.springframework.security.web.server.csrf.CsrfWebFilter;
import org.springframework.security.web.server.csrf.DefaultCsrfToken;
import org.springframework.security.web.server.csrf.XorServerCsrfTokenRequestAttributeHandler;
import org.springframework.test.web.reactive.server.WebTestClient;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.Disposable;
import reactor.core.publisher.Mono;

class DangjianWebFilterTest {
    private static final String VALID_BODY =
        "{\"meetingType\":\"theme-day\",\"topics\":[\"作风建设\"]}";
    private PluginSettingsService settingsService;
    private GenerationService generationService;
    private DangjianWebFilter filter;
    private WebTestClient client;
    private PluginSettings settings;

    @BeforeEach
    void setUp() {
        settingsService = mock(PluginSettingsService.class);
        generationService = mock(GenerationService.class);
        settings = settings("/dangjian", false, 3);
        when(settingsService.current()).thenReturn(Mono.just(settings));
        when(settingsService.apiKey(any())).thenReturn(Mono.just("test-only-key"));
        when(generationService.generate(any(), any())).thenReturn(Mono.just(
            new MeetingResponse("会议记录正文", "theme-day", "主题党日", List.of())));
        filter = new DangjianWebFilter(settingsService, generationService);
        var csrf = new CsrfWebFilter();
        csrf.setCsrfTokenRepository(new CookieServerCsrfTokenRepository());
        csrf.setRequestHandler(new XorServerCsrfTokenRequestAttributeHandler());
        client = WebTestClient.bindToWebHandler(exchange -> {
                exchange.getResponse().setStatusCode(HttpStatus.NOT_FOUND);
                return exchange.getResponse().setComplete();
            })
            .webFilter((exchange, chain) -> {
                String user = exchange.getRequest().getHeaders().getFirst("X-Test-User");
                return chain.filter(user == null ? exchange : exchange.mutate().principal(
                    Mono.just(UsernamePasswordAuthenticationToken.authenticated(user, "",
                        AuthorityUtils.createAuthorityList("ROLE_USER")))).build());
            }, csrf, filter)
            .configureClient().baseUrl("http://localhost").build();
    }

    @Test
    void servesIndependentPageBothWithAndWithoutTrailingSlash() {
        for (String path : List.of("/dangjian", "/dangjian/")) {
            client.get().uri(path).exchange().expectStatus().isOk()
                .expectHeader().contentTypeCompatibleWith(MediaType.TEXT_HTML)
                .expectHeader().exists("Content-Security-Policy")
                .expectBody(String.class).value(body -> {
                    assertThat(body).contains("content=\"/dangjian\"",
                        "/dangjian/assets/app.js", "/login?redirect_uri=%2Fdangjian");
                    assertThat(body).doesNotContain("__DJ_BASE_PATH__", "__DJ_LOGIN_URL__");
                });
        }
        client.head().uri("/dangjian").exchange().expectStatus().isOk()
            .expectBody().isEmpty();
    }

    @Test
    void pathChangesTakeEffectImmediatelyAndOldPathReturnsToHalo() {
        client.get().uri("/dangjian").exchange().expectStatus().isOk();
        when(settingsService.current()).thenReturn(Mono.just(settings("/tools/party", false, 3)));
        client.get().uri("/tools/party").exchange().expectStatus().isOk()
            .expectBody(String.class).value(body -> assertThat(body)
                .contains("content=\"/tools/party\"", "/tools/party/assets/app.js"));
        client.get().uri("/tools/party/assets/app.js").exchange().expectStatus().isOk();
        client.get().uri("/dangjian").exchange().expectStatus().isNotFound();
    }

    @Test
    void servesOnlyKnownAssetsAndDoesNotExposeOtherClasspathFiles() {
        client.get().uri("/dangjian/assets/app.js").exchange().expectStatus().isOk()
            .expectHeader().contentTypeCompatibleWith(new MediaType("text", "javascript"));
        client.get().uri("/dangjian/assets/styles.css").exchange().expectStatus().isOk()
            .expectHeader().contentTypeCompatibleWith(new MediaType("text", "css"));
        for (String path : List.of("/dangjian/assets/plugin.yaml", "/dangjian/assets/index.html",
            "/dangjian-other", "/console", "/other-page", "/dangjian/api/unknown")) {
            client.get().uri(path).exchange().expectStatus().isNotFound();
        }
        client.get().uri(URI.create("http://localhost/dangjian/assets/%2e%2e/plugin.yaml"))
            .exchange().expectStatus().isNotFound();
    }

    @Test
    void defaultsExposeLoginRequirementAndMaskedCsrfTokenWithoutSecretName() {
        Defaults defaults = defaults(null);
        assertThat(defaults.body).containsEntry("requiresLogin", true)
            .containsEntry("canGenerate", false)
            .containsEntry("model", "deepseek-v4-flash")
            .containsEntry("loginUrl", "/login?redirect_uri=%2Fdangjian");
        assertThat(defaults.token).isNotBlank().isNotEqualTo(defaults.cookie);
        assertThat(defaults.body.toString()).doesNotContain("api-token-secret");
        Map<?, ?> roles = (Map<?, ?>) defaults.body.get("roles");
        for (String name : List.of("secretary", "deputy", "committee", "members")) {
            assertThat(roles.containsKey(name)).isTrue();
        }
    }

    @Test
    void authenticatedHaloUserCanGenerateWithActualCsrfProtection() {
        Defaults defaults = defaults("alice");
        assertThat(defaults.body).containsEntry("canGenerate", true);
        post(defaults, "alice", VALID_BODY).exchange().expectStatus().isOk()
            .expectBody().jsonPath("$.content").isEqualTo("会议记录正文");
        verify(generationService).generate(any(MeetingRequest.class), eq(settings));
    }

    @Test
    void anonymousGenerationRequiresExplicitSetting() {
        Defaults defaults = defaults(null);
        post(defaults, null, VALID_BODY).exchange().expectStatus().isUnauthorized()
            .expectBody().jsonPath("$.error").isEqualTo("请先登录 Halo 账号后生成。");
        verify(generationService, never()).generate(any(), any());
        when(settingsService.current()).thenReturn(Mono.just(settings("/dangjian", true, 3)));
        Defaults publicDefaults = defaults(null);
        assertThat(publicDefaults.body).containsEntry("canGenerate", true)
            .containsEntry("requiresLogin", false);
        post(publicDefaults, null, VALID_BODY).exchange().expectStatus().isOk();
    }

    @Test
    void springAnonymousAuthenticationTokenDoesNotCountAsLogin() {
        ServerWebExchange exchange = directExchange(VALID_BODY).mutate().principal(Mono.just(
            new AnonymousAuthenticationToken("anonymous-key", "anonymousUser",
                AuthorityUtils.createAuthorityList("ROLE_ANONYMOUS")))).build();
        filter.filter(exchange, ignored -> Mono.error(new AssertionError("Unexpected chain")))
            .block(Duration.ofSeconds(2));
        assertThat(exchange.getResponse().getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        verify(generationService, never()).generate(any(), any());
    }

    @Test
    void missingOrInvalidCsrfTokenIsRejectedBeforeGeneration() {
        Defaults defaults = defaults("alice");
        client.post().uri("/dangjian/api/generate").header("X-Test-User", "alice")
            .cookie("XSRF-TOKEN", defaults.cookie).contentType(MediaType.APPLICATION_JSON)
            .bodyValue(VALID_BODY).exchange().expectStatus().isForbidden();
        post(defaults, "alice", VALID_BODY).headers(headers -> headers.set(defaults.header, "invalid-token"))
            .exchange().expectStatus().isForbidden();
        verify(generationService, never()).generate(any(), any());
    }

    @Test
    void missingSecurityChainAttributeFailsClosed() {
        ServerWebExchange exchange = directExchange(VALID_BODY).mutate().principal(Mono.just(
            UsernamePasswordAuthenticationToken.authenticated("alice", "", List.of()))).build();
        exchange.getAttributes().remove(CsrfToken.class.getName());
        filter.filter(exchange, ignored -> Mono.error(new AssertionError("Unexpected chain")))
            .block(Duration.ofSeconds(2));
        assertThat(exchange.getResponse().getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        verify(generationService, never()).generate(any(), any());
    }

    @Test
    void rejectsCrossOriginAndSiblingOriginSubmission() {
        Defaults defaults = defaults("alice");
        for (String origin : List.of("https://other.example", "http://localhost:9090",
            "http://localhost.attacker.example", "null")) {
            post(defaults, "alice", VALID_BODY).header("Origin", origin)
                .exchange().expectStatus().isForbidden();
        }
        post(defaults, "alice", VALID_BODY).header("Sec-Fetch-Site", "cross-site")
            .exchange().expectStatus().isForbidden();
        verify(generationService, never()).generate(any(), any());
    }

    @Test
    void malformedAndInvalidMeetingRequestsReturnUseful400() {
        Defaults defaults = defaults("alice");
        post(defaults, "alice", "{broken").exchange().expectStatus().isBadRequest()
            .expectBody().jsonPath("$.error").isEqualTo("会议内容格式不正确，请重新填写后提交。");
        post(defaults, "alice", "{\"topics\":[]}").exchange().expectStatus().isBadRequest()
            .expectBody().jsonPath("$.error").isEqualTo("请至少填写一个议题。");
        verify(generationService, never()).generate(any(), any());
    }

    @Test
    void oversizedJsonIsRejectedBeforeCallingUpstream() {
        Defaults defaults = defaults("alice");
        post(defaults, "alice", "{\"topics\":[\"" + "大".repeat(30_000) + "\"]}")
            .exchange().expectStatus().isEqualTo(HttpStatus.PAYLOAD_TOO_LARGE);
        verify(generationService, never()).generate(any(), any());
    }

    @Test
    void configuredPerUserRateLimitReturns429() {
        when(settingsService.current()).thenReturn(Mono.just(settings("/dangjian", false, 1)));
        Defaults defaults = defaults("alice");
        post(defaults, "alice", VALID_BODY).exchange().expectStatus().isOk();
        post(defaults, "alice", VALID_BODY).exchange().expectStatus().isEqualTo(429)
            .expectHeader().valueEquals("Retry-After", "60");
        Defaults anotherUser = defaults("bob");
        post(anotherUser, "bob", VALID_BODY).exchange().expectStatus().isOk();
    }

    @Test
    void upstreamFailureDoesNotLeakExceptionOrCredentialsAndReleasesConcurrency() {
        when(generationService.generate(any(), any())).thenReturn(Mono.error(
            new RuntimeException("Authorization Bearer sk-private-token")));
        Defaults defaults = defaults("alice");
        post(defaults, "alice", VALID_BODY).exchange().expectStatus().isEqualTo(502)
            .expectBody(String.class).value(body -> assertThat(body)
                .contains("生成服务暂不可用").doesNotContain("sk-private-token", "Bearer"));
        when(generationService.generate(any(), any())).thenReturn(Mono.just(
            new MeetingResponse("恢复正常", "theme-day", "主题党日", List.of())));
        post(defaults, "alice", VALID_BODY).exchange().expectStatus().isOk();
    }

    @Test
    void settingsReadFailureDoesNotOpenGenerationOrSwallowOtherHaloRequests() {
        when(settingsService.current()).thenReturn(Mono.error(new IllegalStateException("sensitive")));
        client.get().uri("/dangjian/api/defaults").exchange().expectStatus().isEqualTo(503)
            .expectBody(String.class).value(body -> assertThat(body).doesNotContain("sensitive"));
        client.get().uri("/ordinary-halo-page").exchange().expectStatus().isNotFound();
        verify(generationService, never()).generate(any(), any());
    }

    @Test
    void configFailureAtLastCustomPathFailsClosed() {
        when(settingsService.current()).thenReturn(Mono.just(settings("/tools/party", true, 3)));
        client.get().uri("/tools/party").exchange().expectStatus().isOk();
        when(settingsService.current()).thenReturn(Mono.error(new IllegalStateException("failure")));
        client.get().uri("/tools/party/api/defaults").exchange().expectStatus().isEqualTo(503);
    }

    @Test
    void missingApiKeyDisablesGenerationAndReports503() {
        when(settingsService.current()).thenReturn(Mono.just(new PluginSettings(
            "/dangjian", "deepseek-v4-flash", "", false, true, 3)));
        Defaults defaults = defaults(null);
        assertThat(defaults.body).containsEntry("canGenerate", false);
        post(defaults, null, VALID_BODY).exchange().expectStatus().isEqualTo(503);
        verify(generationService, never()).generate(any(), any());
    }

    @Test
    void deletedOrInvalidSecretDisablesGenerationWithoutExposingItsContent() {
        when(settingsService.apiKey(any())).thenReturn(Mono.error(
            new IllegalStateException("unexpected private-token-value")));
        Defaults defaults = defaults("alice");
        assertThat(defaults.body).containsEntry("canGenerate", false)
            .containsEntry("configurationMessage", "AI 密钥配置不可用，请联系管理员重新配置。");
        assertThat(defaults.body.toString()).doesNotContain("private-token-value");
    }

    @Test
    void fourConcurrentGenerationsAreAllowedAndCancellationReleasesSlots() {
        when(settingsService.current()).thenReturn(Mono.just(settings("/dangjian", true, 30)));
        when(generationService.generate(any(), any())).thenReturn(Mono.never());
        List<Disposable> requests = new ArrayList<>();
        try {
            for (int index = 0; index < 4; index++) {
                requests.add(filter.filter(directExchange(VALID_BODY), ignored -> Mono.empty()).subscribe());
            }
            var rejected = directExchange(VALID_BODY);
            filter.filter(rejected, ignored -> Mono.empty()).block(Duration.ofSeconds(2));
            assertThat(rejected.getResponse().getStatusCode()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
            requests.forEach(Disposable::dispose);
            when(generationService.generate(any(), any())).thenReturn(Mono.just(
                new MeetingResponse("已恢复", "theme-day", "主题党日", List.of())));
            var recovered = directExchange(VALID_BODY);
            filter.filter(recovered, ignored -> Mono.empty()).block(Duration.ofSeconds(2));
            assertThat(recovered.getResponse().getStatusCode()).isEqualTo(HttpStatus.OK);
        } finally {
            requests.forEach(Disposable::dispose);
        }
    }

    @Test
    void unrelatedErrorsPropagateToHaloInsteadOfBeingReplacedByPluginError() {
        var exchange = MockServerWebExchange.from(MockServerHttpRequest.get("/other-page"));
        var propagated = new AtomicBoolean();
        filter.filter(exchange, ignored -> Mono.error(new IllegalStateException("Halo owns this error")))
            .doOnError(error -> propagated.set(error.getMessage().equals("Halo owns this error")))
            .onErrorComplete().block(Duration.ofSeconds(2));
        assertThat(propagated).isTrue();
    }

    @SuppressWarnings("unchecked")
    private Defaults defaults(String user) {
        var request = client.get().uri("/dangjian/api/defaults");
        if (user != null) {
            request.header("X-Test-User", user);
        }
        var response = request.exchange().expectStatus().isOk()
            .expectBody(Map.class).returnResult();
        Map<String, Object> body = response.getResponseBody();
        assertThat(body).isNotNull();
        assertThat(response.getResponseCookies().getFirst("XSRF-TOKEN")).isNotNull();
        return new Defaults(body, (String) body.get("csrfToken"), (String) body.get("csrfHeader"),
            response.getResponseCookies().getFirst("XSRF-TOKEN").getValue());
    }

    private WebTestClient.RequestHeadersSpec<?> post(Defaults defaults, String user, String body) {
        var request = client.post().uri("/dangjian/api/generate")
            .header(defaults.header, defaults.token)
            .cookie("XSRF-TOKEN", defaults.cookie)
            .contentType(MediaType.APPLICATION_JSON).bodyValue(body);
        if (user != null) {
            request.header("X-Test-User", user);
        }
        return request;
    }

    private MockServerWebExchange directExchange(String body) {
        var exchange = MockServerWebExchange.from(MockServerHttpRequest
            .post("http://localhost/dangjian/api/generate")
            .contentType(MediaType.APPLICATION_JSON).header("X-XSRF-TOKEN", "token").body(body));
        exchange.getAttributes().put(CsrfToken.class.getName(),
            Mono.just(new DefaultCsrfToken("X-XSRF-TOKEN", "_csrf", "token")));
        return exchange;
    }

    private static PluginSettings settings(String path, boolean anonymous, int limit) {
        return new PluginSettings(path, "deepseek-v4-flash", "api-token-secret", false,
            anonymous, limit);
    }

    private record Defaults(Map<String, Object> body, String token, String header, String cookie) {
    }
}
