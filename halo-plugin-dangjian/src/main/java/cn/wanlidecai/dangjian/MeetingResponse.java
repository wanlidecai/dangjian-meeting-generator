package cn.wanlidecai.dangjian;

import java.util.List;

public record MeetingResponse(
    String content,
    String meetingType,
    String meetingTypeLabel,
    List<SourceMaterial> sources
) {
}
