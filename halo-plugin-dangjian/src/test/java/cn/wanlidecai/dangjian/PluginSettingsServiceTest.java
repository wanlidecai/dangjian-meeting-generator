package cn.wanlidecai.dangjian;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import org.junit.jupiter.api.Test;
import reactor.core.publisher.Mono;
import run.halo.app.extension.ReactiveExtensionClient;
import run.halo.app.extension.Secret;
import run.halo.app.plugin.ReactiveSettingFetcher;

class PluginSettingsServiceTest {
    private static final Duration TIMEOUT = Duration.ofSeconds(2);
    private final ReactiveSettingFetcher fetcher = mock(ReactiveSettingFetcher.class);
    private final ReactiveExtensionClient extensions = mock(ReactiveExtensionClient.class);
    private final PluginSettingsService service = new PluginSettingsService(fetcher, extensions);

    private PluginSettingsService.Values values(String basePath, String model, String secret,
                                                Boolean search, Boolean anonymous, Integer rate) {
        return new PluginSettingsService.Values(basePath, model, secret, search, anonymous, rate);
    }

    private PluginSettings keySettings() {
        return PluginSettingsService.validate(values(null, null, "dangjian-key", null, null, null));
    }

    @Test
    void pathDefaultsAndCommonCustomFormsNormalize() {
        assertEquals("/dangjian", PluginSettingsService.normalizePath(null));
        assertEquals("/dangjian", PluginSettingsService.normalizePath(" "));
        assertEquals("/dangjian", PluginSettingsService.normalizePath("dangjian"));
        assertEquals("/dangjian", PluginSettingsService.normalizePath(" /dangjian/ "));
        assertEquals("/tools/party-records", PluginSettingsService.normalizePath("tools/party-records/"));
        assertEquals("/tools/party_records", PluginSettingsService.normalizePath("/tools/party_records///"));
    }

    @Test
    void reservedHaloPathsCannotBeShadowed() {
        for (String path : new String[]{"/api", "/apis/dangjian", "/console", "/uc/dangjian",
            "/login", "/logout", "/signup", "/oauth2/callback", "/actuator", "/assets",
            "/upload", "/themes", "/plugins", "/webjars", "/error", "/API/custom"}) {
            assertThrows(IllegalArgumentException.class,
                () -> PluginSettingsService.normalizePath(path), path);
        }
    }

    @Test
    void traversalAbsoluteUrlsQueryFragmentsAndMalformedPathsFail() {
        for (String path : new String[]{"/", "/../dangjian", "/tools/../dangjian", "/tools/./dangjian",
            "https://example.com/dangjian", "//example.com/dangjian", "/dangjian?admin=true",
            "/dangjian#result", "/dangjian%2fadmin", "/dangjian%252fadmin", "/dangjian\\admin",
            "/党建", "/tools//dangjian", "/dangjian;admin", "/dangjian\u0000", "/dang jian"}) {
            assertThrows(IllegalArgumentException.class,
                () -> PluginSettingsService.normalizePath(path), path);
        }
        assertThrows(IllegalArgumentException.class,
            () -> PluginSettingsService.normalizePath("/" + "a".repeat(128)));
    }

    @Test
    void absentSettingsUseClosedAnonymousAccess() {
        when(fetcher.fetch("basic", PluginSettingsService.Values.class)).thenReturn(Mono.empty());
        PluginSettings settings = service.current().block(TIMEOUT);
        assertEquals(PluginSettings.defaults(), settings);
        assertFalse(settings.allowAnonymous());
        assertTrue(settings.searchEnabled());
        assertEquals(3, settings.requestsPerMinute());
    }

    @Test
    void omittedBooleanFieldsDefaultToClosedAnonymousAccess() {
        PluginSettings defaults = PluginSettingsService.validate(values(null, null, null, null, null, null));
        assertFalse(defaults.allowAnonymous());
        assertTrue(defaults.searchEnabled());
        assertEquals("deepseek-v4-flash", defaults.model());
        assertEquals("", defaults.apiKeySecretName());
        PluginSettings custom = PluginSettingsService.validate(
            values("records", "deepseek-v4-pro", "dangjian-key", false, true, 7));
        assertEquals("/records", custom.basePath());
        assertEquals("deepseek-v4-pro", custom.model());
        assertFalse(custom.searchEnabled());
        assertTrue(custom.allowAnonymous());
        assertEquals(7, custom.requestsPerMinute());
    }

    @Test
    void settingsFetchAndValidationFailureDoNotEnableAnonymousAccess() {
        when(fetcher.fetch("basic", PluginSettingsService.Values.class))
            .thenReturn(Mono.error(new IllegalStateException("settings unavailable")));
        assertThrows(IllegalStateException.class, () -> service.current().block(TIMEOUT));
        when(fetcher.fetch("basic", PluginSettingsService.Values.class))
            .thenReturn(Mono.just(values("/console", null, null, null, true, null)));
        assertThrows(IllegalArgumentException.class, () -> service.current().block(TIMEOUT));
    }

    @Test
    void generationRateHasUsableFiniteBounds() {
        assertEquals(1, PluginSettingsService.validate(values(null, null, null, null, null, 1))
            .requestsPerMinute());
        assertEquals(30, PluginSettingsService.validate(values(null, null, null, null, null, 30))
            .requestsPerMinute());
        for (int rate : new int[]{0, -1, 31, Integer.MAX_VALUE}) {
            assertThrows(IllegalArgumentException.class,
                () -> PluginSettingsService.validate(values(null, null, null, null, null, rate)));
        }
    }

    @Test
    void modelAndSecretNameErrorsDoNotEchoSubmittedValues() {
        String malicious = "private-secret-value\r\nAuthorization: leaked";
        var modelError = assertThrows(IllegalArgumentException.class,
            () -> PluginSettingsService.validate(values(null, malicious, null, null, null, null)));
        assertFalse(modelError.getMessage().contains("private-secret-value"));
        var nameError = assertThrows(IllegalArgumentException.class,
            () -> PluginSettingsService.validate(values(null, null, malicious, null, null, null)));
        assertFalse(nameError.getMessage().contains("private-secret-value"));
    }

    @Test
    void secretTokenCanBeReadFromStringData() {
        var secret = new Secret();
        secret.setStringData(Map.of("token", " sk-test-secret "));
        when(extensions.fetch(Secret.class, "dangjian-key")).thenReturn(Mono.just(secret));
        assertEquals("sk-test-secret", service.apiKey(keySettings()).block(TIMEOUT));
    }

    @Test
    void secretTokenCanBeReadFromUtf8Data() {
        var secret = new Secret();
        secret.setData(Map.of("token", "sk-test-data".getBytes(StandardCharsets.UTF_8)));
        when(extensions.fetch(Secret.class, "dangjian-key")).thenReturn(Mono.just(secret));
        assertEquals("sk-test-data", service.apiKey(keySettings()).block(TIMEOUT));
    }

    @Test
    void blankStringDataFallsBackToDataAndNonBlankStringDataWins() {
        var secret = new Secret();
        secret.setStringData(Map.of("token", " "));
        secret.setData(Map.of("token", "sk-data-value".getBytes(StandardCharsets.UTF_8)));
        when(extensions.fetch(Secret.class, "dangjian-key")).thenReturn(Mono.just(secret));
        assertEquals("sk-data-value", service.apiKey(keySettings()).block(TIMEOUT));
        secret.setStringData(Map.of("token", "sk-string-value"));
        assertEquals("sk-string-value", service.apiKey(keySettings()).block(TIMEOUT));
    }

    @Test
    void absentSecretConfigurationDoesNotFetchAnyResource() {
        var error = assertThrows(IllegalStateException.class,
            () -> service.apiKey(PluginSettings.defaults()).block(TIMEOUT));
        assertTrue(error.getMessage().contains("配置"));
        verifyNoInteractions(extensions);
    }

    @Test
    void missingSecretAndTokenHaveSafeActionableErrors() {
        when(extensions.fetch(Secret.class, "dangjian-key")).thenReturn(Mono.empty());
        var missing = assertThrows(IllegalStateException.class,
            () -> service.apiKey(keySettings()).block(TIMEOUT));
        assertTrue(missing.getMessage().contains("不存在"));
        assertFalse(missing.getMessage().contains("dangjian-key"));
        var secret = new Secret();
        secret.setStringData(Map.of("other", "sk-private-unrelated-value"));
        when(extensions.fetch(Secret.class, "dangjian-key")).thenReturn(Mono.just(secret));
        var token = assertThrows(IllegalStateException.class,
            () -> service.apiKey(keySettings()).block(TIMEOUT));
        assertTrue(token.getMessage().contains("缺少 token"));
        assertFalse(token.getMessage().contains("sk-private-unrelated-value"));
    }

    @Test
    void malformedTokensFailWithoutEchoingSecretContent() {
        for (String value : new String[]{"sk-private value", "sk-private\r\nheader", "sk-private\u0000value",
            "sk-private" + "x".repeat(512)}) {
            var secret = new Secret();
            secret.setStringData(Map.of("token", value));
            when(extensions.fetch(Secret.class, "dangjian-key")).thenReturn(Mono.just(secret));
            var error = assertThrows(IllegalStateException.class,
                () -> service.apiKey(keySettings()).block(TIMEOUT));
            assertTrue(error.getMessage().contains("格式"));
            assertFalse(error.getMessage().contains("sk-private"));
        }
    }

    @Test
    void secretResourceReadFailureDoesNotLeakBackendError() {
        when(extensions.fetch(Secret.class, "dangjian-key"))
            .thenReturn(Mono.error(new IllegalStateException("backend secret sk-private-resource-value")));
        var error = assertThrows(IllegalStateException.class,
            () -> service.apiKey(keySettings()).block(TIMEOUT));
        assertFalse(error.getMessage().contains("sk-private-resource-value"));
        assertFalse(error.getMessage().contains("backend secret"));
        assertTrue(error.getMessage().contains("密钥"));
    }
}
