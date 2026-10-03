package cn.wanlidecai.dangjian;

public record PluginSettings(String basePath, String model, String apiKeySecretName,
                             boolean searchEnabled, boolean allowAnonymous,
                             int requestsPerMinute) {
    public static PluginSettings defaults() {
        return new PluginSettings("/dangjian", "deepseek-v4-flash", "", true, false, 3);
    }
}
