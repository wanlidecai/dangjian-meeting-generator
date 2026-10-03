package cn.wanlidecai.dangjian;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.Principal;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Semaphore;
import java.util.concurrent.atomic.AtomicBoolean;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.buffer.DataBufferLimitException;
import org.springframework.core.io.buffer.DataBufferUtils;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.security.authentication.AuthenticationTrustResolverImpl;
import org.springframework.security.core.Authentication;
import org.springframework.security.web.server.csrf.CsrfToken;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.server.WebFilterChain;
import reactor.core.publisher.Mono;
import run.halo.app.security.AfterSecurityWebFilter;
import tools.jackson.databind.json.JsonMapper;

/**
 * Serves the independent generator after Halo authentication, authorization and CSRF.
 * Only the exact plugin routes are consumed; all other Halo requests keep their chain.
 */
@Component
public class DangjianWebFilter implements AfterSecurityWebFilter {
    private static final int MAX_REQUEST_BYTES = 64 * 1024;
    private static final int MAX_TRACKED_CLIENTS = 1024;
    private static final int MAX_CONCURRENT_GENERATIONS = 4;
    private static final MediaType JAVASCRIPT =
        new MediaType("text", "javascript", StandardCharsets.UTF_8);
    private static final MediaType CSS = new MediaType("text", "css", StandardCharsets.UTF_8);
    private static final MediaType HTML = new MediaType("text", "html", StandardCharsets.UTF_8);
    private static final MediaType JSON =
        new MediaType("application", "json", StandardCharsets.UTF_8);

    private final PluginSettingsService settingsService;
    private final GenerationService generationService;
    private final JsonMapper mapper = JsonMapper.builder().build();
    private final AuthenticationTrustResolverImpl trustResolver =
        new AuthenticationTrustResolverImpl();
    private final Semaphore generationSlots = new Semaphore(MAX_CONCURRENT_GENERATIONS);
    private final Map<String, RateWindow> rateWindows = new ConcurrentHashMap<>();
    private final String indexHtml;
    private final byte[] javascript;
    private final byte[] stylesheet;
    private volatile String lastBasePath = "/dangjian";

    public DangjianWebFilter(PluginSettingsService settingsService,
        GenerationService generationService) {
        this.settingsService = settingsService;
        this.generationService = generationService;
        // Cache packaged resources at plugin startup, never block a WebFlux request thread.
        this.indexHtml = new String(readResource("index.html"), StandardCharsets.UTF_8);
        this.javascript = readResource("app.js");
        this.stylesheet = readResource("styles.css");
    }

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, WebFilterChain chain) {
        String path = exchange.getRequest().getPath().pathWithinApplication().value();
        return Mono.defer(settingsService::current)
            .map(Optional::of)
            .onErrorReturn(Optional.empty())
            .defaultIfEmpty(Optional.empty())
            .flatMap(optional -> {
                if (optional.isEmpty()) {
                    if (isOwnedRoute(path, lastBasePath)) {
                        return error(exchange, HttpStatus.SERVICE_UNAVAILABLE,
                            "插件配置暂不可用，请联系管理员或稍后重试。");
                    }
                    return chain.filter(exchange);
                }
                PluginSettings settings = optional.get();
                String basePath = settings.basePath();
                lastBasePath = basePath;
                if (!isOwnedRoute(path, basePath)) {
                    return chain.filter(exchange);
                }
                return handle(exchange, settings, path.substring(basePath.length()))
                    .onErrorResume(RequestFailure.class,
                        failure -> error(exchange, failure.status, failure.getMessage()))
                    .onErrorResume(ResponseStatusException.class, failure ->
                        json(exchange, failure.getStatusCode().value(), Map.of("error",
                            failure.getReason() == null ? "生成服务暂不可用，请稍后重试。"
                                : failure.getReason())))
                    .onErrorResume(IllegalStateException.class, failure -> error(exchange,
                        HttpStatus.SERVICE_UNAVAILABLE, safeConfigurationMessage(failure)))
                    .onErrorResume(failure -> error(exchange, HttpStatus.BAD_GATEWAY,
                        "生成服务暂不可用，请稍后重试；持续失败时请联系管理员检查服务配置。"));
            });
    }

    private static boolean isOwnedRoute(String path, String basePath) {
        return path.equals(basePath) || path.equals(basePath + "/")
            || path.equals(basePath + "/assets/app.js")
            || path.equals(basePath + "/assets/styles.css")
            || path.equals(basePath + "/api/defaults")
            || path.equals(basePath + "/api/generate");
    }

    private Mono<Void> handle(ServerWebExchange exchange, PluginSettings settings, String suffix) {
        HttpMethod method = exchange.getRequest().getMethod();
        boolean generating = suffix.equals("/api/generate");
        if (generating && !HttpMethod.POST.equals(method)) {
            exchange.getResponse().getHeaders().set(HttpHeaders.ALLOW, "POST");
            return error(exchange, HttpStatus.METHOD_NOT_ALLOWED, "请使用 POST 提交生成请求。");
        }
        if (!generating && !HttpMethod.GET.equals(method) && !HttpMethod.HEAD.equals(method)) {
            exchange.getResponse().getHeaders().set(HttpHeaders.ALLOW, "GET, HEAD");
            return error(exchange, HttpStatus.METHOD_NOT_ALLOWED, "此地址仅支持 GET 或 HEAD。");
        }
        return switch (suffix) {
            case "", "/" -> bytes(exchange, HTML, indexHtml
                .replace("__DJ_BASE_PATH__", html(settings.basePath()))
                .replace("__DJ_LOGIN_URL__", html(loginUrl(exchange, settings.basePath())))
                .getBytes(StandardCharsets.UTF_8));
            case "/assets/app.js" -> bytes(exchange, JAVASCRIPT, javascript);
            case "/assets/styles.css" -> bytes(exchange, CSS, stylesheet);
            case "/api/defaults" -> defaults(exchange, settings);
            case "/api/generate" -> generate(exchange, settings);
            default -> throw new IllegalStateException("Unrecognized internal route");
        };
    }

    private Mono<Void> defaults(ServerWebExchange exchange, PluginSettings settings) {
        return Mono.zip(authenticatedPrincipal(exchange).map(Optional::of)
                .defaultIfEmpty(Optional.empty()), csrfToken(exchange).map(Optional::of)
                .defaultIfEmpty(Optional.empty()), configurationMessage(settings))
            .flatMap(values -> {
                var response = new LinkedHashMap<String, Object>();
                boolean requiresLogin = !settings.allowAnonymous();
                String message = values.getT3();
                if (message.isBlank() && values.getT2().isEmpty()) {
                    message = "安全校验未就绪，请联系管理员检查插件配置。";
                }
                boolean configured = message.isBlank();
                response.put("model", settings.model());
                response.put("roles", MeetingContent.defaultsRoles());
                response.put("requiresLogin", requiresLogin);
                response.put("canGenerate", configured
                    && (!requiresLogin || values.getT1().isPresent())
                    && values.getT2().isPresent());
                response.put("loginUrl", loginUrl(exchange, settings.basePath()));
                response.put("csrfToken", values.getT2().map(CsrfToken::getToken).orElse(""));
                response.put("csrfHeader", values.getT2().map(CsrfToken::getHeaderName).orElse(""));
                response.put("configurationMessage", message);
                return json(exchange, HttpStatus.OK, response);
            });
    }

    private Mono<String> configurationMessage(PluginSettings settings) {
        if (settings.apiKeySecretName() == null || settings.apiKeySecretName().isBlank()) {
            return Mono.just("管理员尚未配置 AI API Key，请配置插件后再生成。");
        }
        return Mono.defer(() -> settingsService.apiKey(settings))
            .map(ignored -> "")
            .switchIfEmpty(Mono.just("AI 密钥配置不可用，请联系管理员重新配置。"))
            .onErrorResume(failure -> Mono.just(safeConfigurationMessage(failure)));
    }

    private static String safeConfigurationMessage(Throwable failure) {
        String message = failure.getMessage();
        return switch (message == null ? "" : message) {
            case "请先在插件设置中配置 DeepSeek API 密钥。", "DeepSeek 密钥不存在，请重新配置。",
                "DeepSeek 密钥缺少 token，请重新配置。", "DeepSeek 密钥格式不正确，请重新配置。"
                -> message;
            default -> "AI 密钥配置不可用，请联系管理员重新配置。";
        };
    }

    private Mono<Void> generate(ServerWebExchange exchange, PluginSettings settings) {
        return authenticatedPrincipal(exchange).map(Optional::of)
            .defaultIfEmpty(Optional.empty())
            .flatMap(principal -> {
                if (principal.isEmpty() && !settings.allowAnonymous()) {
                    return error(exchange, HttpStatus.UNAUTHORIZED, "请先登录 Halo 账号后生成。");
                }
                if (!sameOrigin(exchange)) {
                    return error(exchange, HttpStatus.FORBIDDEN, "请从本站页面提交生成请求。");
                }
                if (settings.apiKeySecretName() == null || settings.apiKeySecretName().isBlank()) {
                    return error(exchange, HttpStatus.SERVICE_UNAVAILABLE,
                        "管理员尚未配置 AI API Key，请配置插件后再生成。");
                }
                // The core CsrfWebFilter has already verified the masked token at this point.
                // Requiring its attribute/header also fails closed if our extension is misplaced.
                return csrfToken(exchange)
                    .flatMap(token -> Mono.justOrEmpty(exchange.getRequest().getHeaders()
                        .getFirst(token.getHeaderName())))
                    .filter(value -> !value.isBlank())
                    .switchIfEmpty(Mono.error(new RequestFailure(HttpStatus.FORBIDDEN,
                        "安全校验已失效，请重新读取配置后再生成。")))
                    .flatMap(ignored -> readMeeting(exchange))
                    .flatMap(request -> {
                        String key = principal.map(p -> "user:" + p.getName())
                            .orElseGet(() -> anonymousClientKey(exchange));
                        if (!allowRequest(key, settings.requestsPerMinute())) {
                            exchange.getResponse().getHeaders().set(HttpHeaders.RETRY_AFTER, "60");
                            return error(exchange, HttpStatus.TOO_MANY_REQUESTS,
                                "生成请求过于频繁，请稍后再试。");
                        }
                        if (!generationSlots.tryAcquire()) {
                            exchange.getResponse().getHeaders().set(HttpHeaders.RETRY_AFTER, "5");
                            return error(exchange, HttpStatus.TOO_MANY_REQUESTS,
                                "当前生成请求较多，请稍后再试。");
                        }
                        return Mono.defer(() -> generationService.generate(request, settings))
                            .switchIfEmpty(Mono.error(new RequestFailure(HttpStatus.BAD_GATEWAY,
                                "AI 服务未返回结果，请稍后重试。")))
                            .flatMap(result -> json(exchange, HttpStatus.OK, result))
                            .doFinally(signal -> generationSlots.release());
                    });
            });
    }

    private Mono<MeetingRequest> readMeeting(ServerWebExchange exchange) {
        MediaType contentType = exchange.getRequest().getHeaders().getContentType();
        if (contentType == null || !MediaType.APPLICATION_JSON.isCompatibleWith(contentType)) {
            return Mono.error(new RequestFailure(HttpStatus.UNSUPPORTED_MEDIA_TYPE,
                "请以 JSON 格式提交会议内容。"));
        }
        if (exchange.getRequest().getHeaders().getContentLength() > MAX_REQUEST_BYTES) {
            return Mono.error(new RequestFailure(HttpStatus.PAYLOAD_TOO_LARGE,
                "会议内容过长，请缩短议题或人员列表。"));
        }
        return DataBufferUtils.join(exchange.getRequest().getBody(), MAX_REQUEST_BYTES)
            .switchIfEmpty(Mono.error(new RequestFailure(HttpStatus.BAD_REQUEST,
                "会议内容不能为空。")))
            .map(buffer -> {
                byte[] payload = new byte[buffer.readableByteCount()];
                try {
                    buffer.read(payload);
                } finally {
                    DataBufferUtils.release(buffer);
                }
                MeetingRequest request;
                try {
                    request = mapper.readValue(payload, MeetingRequest.class);
                } catch (Exception failure) {
                    throw new RequestFailure(HttpStatus.BAD_REQUEST,
                        "会议内容格式不正确，请重新填写后提交。");
                }
                try {
                    MeetingContent.normalize(request);
                } catch (IllegalArgumentException failure) {
                    throw new RequestFailure(HttpStatus.BAD_REQUEST, failure.getMessage());
                }
                return request;
            })
            .onErrorMap(DataBufferLimitException.class, failure ->
                new RequestFailure(HttpStatus.PAYLOAD_TOO_LARGE,
                    "会议内容过长，请缩短议题或人员列表。"));
    }

    private Mono<Principal> authenticatedPrincipal(ServerWebExchange exchange) {
        return exchange.<Principal>getPrincipal()
            .filter(principal -> principal instanceof Authentication authentication
                && trustResolver.isAuthenticated(authentication)
                && !authentication.getClass().getSimpleName().equals("TwoFactorAuthentication"));
    }

    private static Mono<CsrfToken> csrfToken(ServerWebExchange exchange) {
        Mono<CsrfToken> token = exchange.getAttribute(CsrfToken.class.getName());
        return token == null ? Mono.empty() : token;
    }

    private boolean allowRequest(String key, int limit) {
        long minute = System.currentTimeMillis() / 60_000;
        if (rateWindows.size() >= MAX_TRACKED_CLIENTS) {
            rateWindows.entrySet().removeIf(entry -> entry.getValue().minute != minute);
            if (!rateWindows.containsKey(key) && rateWindows.size() >= MAX_TRACKED_CLIENTS) {
                return false;
            }
        }
        var allowed = new AtomicBoolean();
        int effectiveLimit = Math.max(1, Math.min(60, limit));
        rateWindows.compute(key, (ignored, previous) -> {
            int count = previous != null && previous.minute == minute ? previous.count : 0;
            allowed.set(count < effectiveLimit);
            return new RateWindow(minute, Math.min(count + 1, effectiveLimit + 1));
        });
        return allowed.get();
    }

    private static String anonymousClientKey(ServerWebExchange exchange) {
        var address = exchange.getRequest().getRemoteAddress();
        // Forwarded headers are controlled by the reverse proxy, not trusted by this limiter.
        return "ip:" + (address == null || address.getAddress() == null
            ? "unknown" : address.getAddress().getHostAddress());
    }

    private static boolean sameOrigin(ServerWebExchange exchange) {
        var headers = exchange.getRequest().getHeaders();
        String fetchSite = headers.getFirst("Sec-Fetch-Site");
        if (fetchSite != null && !fetchSite.equals("same-origin") && !fetchSite.equals("none")) {
            return false;
        }
        String origin = headers.getOrigin();
        if (origin == null) {
            return true; // Non-browser callers remain protected by Halo authentication and CSRF.
        }
        try {
            URI actual = URI.create(origin);
            URI expected = exchange.getRequest().getURI();
            return actual.getHost() != null && actual.getUserInfo() == null
                && actual.getQuery() == null && actual.getFragment() == null
                && (actual.getPath() == null || actual.getPath().isEmpty())
                && actual.getScheme().equalsIgnoreCase(expected.getScheme())
                && actual.getHost().equalsIgnoreCase(expected.getHost())
                && effectivePort(actual) == effectivePort(expected);
        } catch (IllegalArgumentException failure) {
            return false;
        }
    }

    private static int effectivePort(URI uri) {
        return uri.getPort() != -1 ? uri.getPort()
            : "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
    }

    private static String loginUrl(ServerWebExchange exchange, String basePath) {
        String contextPath = exchange.getRequest().getPath().contextPath().value();
        String target = contextPath + basePath;
        return contextPath + "/login?redirect_uri="
            + URLEncoder.encode(target, StandardCharsets.UTF_8);
    }

    private static String html(String value) {
        return value.replace("&", "&amp;").replace("\"", "&quot;")
            .replace("<", "&lt;").replace(">", "&gt;").replace("'", "&#39;");
    }

    private Mono<Void> error(ServerWebExchange exchange, HttpStatus status, String message) {
        return json(exchange, status, Map.of("error", message));
    }

    private Mono<Void> json(ServerWebExchange exchange, HttpStatus status, Object body) {
        exchange.getResponse().setStatusCode(status);
        return bytes(exchange, JSON, mapper.writeValueAsBytes(body));
    }

    private Mono<Void> json(ServerWebExchange exchange, int status, Object body) {
        exchange.getResponse().setStatusCode(HttpStatusCode.valueOf(status));
        return bytes(exchange, JSON, mapper.writeValueAsBytes(body));
    }

    private static Mono<Void> bytes(ServerWebExchange exchange, MediaType contentType, byte[] body) {
        var response = exchange.getResponse();
        response.getHeaders().setContentType(contentType);
        response.getHeaders().set(HttpHeaders.CACHE_CONTROL, "no-store");
        response.getHeaders().set("X-Content-Type-Options", "nosniff");
        if (HTML.equals(contentType)) {
            response.getHeaders().set("Content-Security-Policy",
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                    + "connect-src 'self'; img-src 'self' data:; base-uri 'none'; "
                    + "object-src 'none'; frame-ancestors 'self'; form-action 'self'");
            response.getHeaders().set("Referrer-Policy", "same-origin");
        }
        response.getHeaders().setContentLength(body.length);
        if (HttpMethod.HEAD.equals(exchange.getRequest().getMethod())) {
            return response.setComplete();
        }
        return response.writeWith(Mono.just(response.bufferFactory().wrap(body)));
    }

    private byte[] readResource(String filename) {
        var resource = new ClassPathResource("website/" + filename, getClass().getClassLoader());
        try (var input = resource.getInputStream()) {
            return input.readAllBytes();
        } catch (IOException failure) {
            throw new IllegalStateException("Packaged generator resource missing: " + filename, failure);
        }
    }

    private record RateWindow(long minute, int count) {
    }

    private static final class RequestFailure extends RuntimeException {
        private final HttpStatus status;

        private RequestFailure(HttpStatus status, String message) {
            super(message);
            this.status = status;
        }
    }
}
