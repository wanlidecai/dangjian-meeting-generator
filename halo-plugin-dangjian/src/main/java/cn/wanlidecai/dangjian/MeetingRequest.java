package cn.wanlidecai.dangjian;

import java.util.List;

/** The existing generator's browser request contract. */
public record MeetingRequest(
    String meetingType,
    List<String> topics,
    String secretary,
    String deputy,
    List<String> committee,
    List<String> members,
    List<String> people,
    Object branchMatters
) {
}
