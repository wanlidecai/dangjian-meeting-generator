package cn.wanlidecai.dangjian;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.web.reactive.function.client.ClientRequest;
import org.springframework.web.reactive.function.client.ClientResponse;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.server.ResponseStatusException;
import reactor.core.publisher.Mono;

class GenerationServiceTest {
    PluginSettingsService settingsService;
    SourceSearchService search;
    PluginSettings settings = PluginSettings.defaults();
    MeetingRequest request = new MeetingRequest("committee-meeting", List.of("加强基层党组织建设"),
        "书记甲", "副书记乙", List.of("委员丙"), List.of("普通成员"), List.of("外部人员"), List.of());

    @BeforeEach
    void prepare() {
        settingsService = mock(PluginSettingsService.class);
        search = mock(SourceSearchService.class);
        when(settingsService.apiKey(any())).thenReturn(Mono.just("test-secret-never-return"));
        when(search.search(anyList(), anyBoolean())).thenReturn(Mono.just(List.of(
            new SourceMaterial("加强基层党组织建设", "测试参考", "https://www.12371.cn/reference", "学习材料"))));
    }

    @Test
    void completesUsingOnlyFixedProviderAndTrimsExtraLearningWithoutRemovingMatters() {
        AtomicReference<ClientRequest> captured = new AtomicReference<>();
        var client = WebClient.builder().exchangeFunction(outbound -> {
            captured.set(outbound);
            return Mono.just(ClientResponse.create(HttpStatus.OK)
                .header("Content-Type", MediaType.APPLICATION_JSON_VALUE)
                .body("{\"choices\":[{\"message\":{\"content\":\"支委会记录\\n一、学习《加强基层党组织建设》\\n保留学习。\\n二、学习《多余议题》\\n应删除。\\n三、讨论支部工作\\n保留事项。\"}}],\"usage\":{\"total_tokens\":100}}")
                .build());
        }).build();
        var service = new GenerationService(settingsService, search, client);
        var result = service.generate(request, settings).block();
        assertNotNull(result);
        assertEquals("committee-meeting", result.meetingType());
        assertEquals("支委会", result.meetingTypeLabel());
        assertFalse(result.content().contains("多余议题"));
        assertTrue(result.content().contains("保留事项"));
        assertEquals(1, result.sources().size());
        assertEquals("https://api.deepseek.com/chat/completions", captured.get().url().toString());
        assertEquals("Bearer test-secret-never-return", captured.get().headers().getFirst("Authorization"));
        assertFalse(result.toString().contains("test-secret-never-return"));
    }

    @Test
    void invalidInputNeverFetchesSecretOrUsesNetwork() {
        var service = new GenerationService(settingsService, search, WebClient.builder()
            .exchangeFunction(request -> { fail("Must not call provider"); return Mono.empty(); }).build());
        assertThrows(IllegalArgumentException.class, () -> service.generate(
            new MeetingRequest("__proto__", List.of("议题"), null, null, null, null, null, null), settings).block());
        verifyNoInteractions(settingsService, search);
    }

    @Test
    void missingSecretNeverSearchesOrCallsProvider() {
        when(settingsService.apiKey(any())).thenReturn(Mono.error(new IllegalStateException("密钥未配置")));
        var service = new GenerationService(settingsService, search, WebClient.builder()
            .exchangeFunction(request -> { fail("Must not call provider"); return Mono.empty(); }).build());
        assertThrows(IllegalStateException.class, () -> service.generate(request, settings).block());
        verifyNoInteractions(search);
    }

    @Test
    void upstreamErrorsAndRedirectsNeverExposeTheirBodies() {
        for (var status : List.of(HttpStatus.UNAUTHORIZED, HttpStatus.TOO_MANY_REQUESTS,
            HttpStatus.FOUND, HttpStatus.INTERNAL_SERVER_ERROR)) {
            AtomicReference<Integer> calls = new AtomicReference<>(0);
            var client = WebClient.builder().exchangeFunction(outbound -> {
                calls.updateAndGet(n -> n + 1);
                return Mono.just(ClientResponse.create(status)
                    .header("Location", "http://127.0.0.1/private")
                    .body("unsafe body test-secret-never-return")
                    .build());
            }).build();
            var service = new GenerationService(settingsService, search, client);
            var error = assertThrows(ResponseStatusException.class,
                () -> service.generate(request, settings).block());
            assertEquals(HttpStatus.BAD_GATEWAY, error.getStatusCode());
            assertFalse(error.getReason().contains("test-secret-never-return"));
            assertFalse(error.getReason().contains("unsafe body"));
            assertEquals(1, calls.get());
        }
    }

    @Test
    void emptyProviderContentIsAnExplicitFailure() {
        for (String json : List.of("{}", "{\"choices\":[]}", "{\"choices\":[{\"message\":{\"content\":\"  \"}}]}")) {
            var service = new GenerationService(settingsService, search, WebClient.builder()
                .exchangeFunction(outbound -> Mono.just(ClientResponse.create(HttpStatus.OK)
                    .header("Content-Type", "application/json").body(json).build())).build());
            var error = assertThrows(ResponseStatusException.class, () -> service.generate(request, settings).block());
            assertEquals(HttpStatus.BAD_GATEWAY, error.getStatusCode());
        }
    }
}
