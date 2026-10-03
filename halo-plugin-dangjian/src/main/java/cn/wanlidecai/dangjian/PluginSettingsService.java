package cn.wanlidecai.dangjian;

import java.nio.charset.StandardCharsets;
import java.util.Set;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;
import run.halo.app.extension.ReactiveExtensionClient;
import run.halo.app.extension.Secret;
import run.halo.app.plugin.ReactiveSettingFetcher;

@Service
public class PluginSettingsService {
    private static final Set<String> RESERVED = Set.of("api", "apis", "console", "uc",
        "login", "logout", "signup", "oauth2", "actuator", "assets", "upload", "themes",
        "plugins", "webjars", "error", "favicon.ico", "robots.txt", "sitemap.xml");
    private final ReactiveSettingFetcher settingFetcher;
    private final ReactiveExtensionClient extensionClient;

    public PluginSettingsService(ReactiveSettingFetcher settingFetcher,
                                 ReactiveExtensionClient extensionClient) {
        this.settingFetcher = settingFetcher;
        this.extensionClient = extensionClient;
    }

    public Mono<PluginSettings> current() {
        return settingFetcher.fetch("basic", Values.class)
            .map(PluginSettingsService::validate)
            .defaultIfEmpty(PluginSettings.defaults());
    }

    public Mono<String> apiKey(PluginSettings settings) {
        if (settings.apiKeySecretName().isBlank()) {
            return Mono.error(new IllegalStateException("请先在插件设置中配置 DeepSeek API 密钥。"));
        }
        return extensionClient.fetch(Secret.class, settings.apiKeySecretName())
            .onErrorMap(error -> new IllegalStateException("DeepSeek 密钥读取失败，请检查密钥配置。"))
            .switchIfEmpty(Mono.error(new IllegalStateException("DeepSeek 密钥不存在，请重新配置。")))
            .map(secret -> {
                String key = secret.getStringData() == null ? null : secret.getStringData().get("token");
                if ((key == null || key.isBlank()) && secret.getData() != null
                    && secret.getData().get("token") != null) {
                    key = new String(secret.getData().get("token"), StandardCharsets.UTF_8);
                }
                if (key == null || key.isBlank()) {
                    throw new IllegalStateException("DeepSeek 密钥缺少 token，请重新配置。");
                }
                key = key.trim();
                if (key.length() > 512 || key.chars().anyMatch(c -> Character.isWhitespace(c) || Character.isISOControl(c))) {
                    throw new IllegalStateException("DeepSeek 密钥格式不正确，请重新配置。");
                }
                return key;
            });
    }

    static PluginSettings validate(Values values) {
        PluginSettings defaults = PluginSettings.defaults();
        String model = values.model() == null || values.model().isBlank()
            ? defaults.model() : values.model().trim();
        if (!model.matches("[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}")) {
            throw new IllegalArgumentException("模型名称格式不正确，请检查插件设置。" );
        }
        String secret = values.apiKeySecretName() == null ? "" : values.apiKeySecretName().trim();
        if (!secret.isEmpty() && !secret.matches("[a-z0-9][a-z0-9.-]{0,252}")) {
            throw new IllegalArgumentException("密钥资源名称格式不正确，请重新选择密钥。" );
        }
        int limit = values.requestsPerMinute() == null ? defaults.requestsPerMinute() : values.requestsPerMinute();
        if (limit < 1 || limit > 30) {
            throw new IllegalArgumentException("每分钟生成次数必须介于 1 和 30。" );
        }
        return new PluginSettings(normalizePath(values.basePath()), model, secret,
            values.searchEnabled() == null || values.searchEnabled(),
            Boolean.TRUE.equals(values.allowAnonymous()), limit);
    }

    public static String normalizePath(String value) {
        if (value != null && value.chars().anyMatch(Character::isISOControl)) {
            throw new IllegalArgumentException("访问路径不能包含控制字符。" );
        }
        String path = value == null || value.isBlank() ? "/dangjian" : value.trim();
        if (!path.startsWith("/")) {
            path = "/" + path;
        }
        path = path.replaceAll("/+$", "");
        if (path.length() > 128 || !path.matches("/(?:[A-Za-z0-9][A-Za-z0-9_-]*)(?:/[A-Za-z0-9][A-Za-z0-9_-]*)*")) {
            throw new IllegalArgumentException("访问路径请使用 /dangjian 或 /tools/dangjian 这样的格式。" );
        }
        String first = path.substring(1).split("/", 2)[0].toLowerCase(java.util.Locale.ROOT);
        if (RESERVED.contains(first)) {
            throw new IllegalArgumentException("该路径由 Halo 使用，请选择其他访问路径。" );
        }
        return path;
    }

    public record Values(String basePath, String model, String apiKeySecretName,
                         Boolean searchEnabled, Boolean allowAnonymous,
                         Integer requestsPerMinute) { }
}
