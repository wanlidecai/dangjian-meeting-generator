package cn.wanlidecai.dangjian;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class MeetingContentTest {
    private static final String TOPIC = "加强基层党组织建设";

    private MeetingRequest request(String meetingType, List<String> topics, Object branchMatters) {
        return new MeetingRequest(meetingType, topics, null, null, null, null, null, branchMatters);
    }

    private String prompt(MeetingRequest request) {
        return MeetingContent.buildPrompt(MeetingContent.normalize(request), List.of(
            new SourceMaterial(TOPIC, "测试参考材料", "https://example.invalid/reference",
                "围绕议题开展学习，结合岗位职责落实工作要求。")));
    }

    @Test
    void defaultsRetainOriginalRoles() {
        assertEquals(Map.of("secretary", "李强", "deputy", "郭琳", "committee", List.of("王丽"),
            "members", List.of("刘广彪", "魏鹏飞", "许茜", "杨可来尔", "尹泽华")),
            MeetingContent.defaultsRoles());
        var meeting = MeetingContent.normalize(request(null, List.of(TOPIC), null));
        assertEquals("theme-day", meeting.meetingType());
        assertEquals(List.of("李强", "郭琳", "王丽", "刘广彪", "魏鹏飞", "许茜", "杨可来尔", "尹泽华"),
            meeting.people());
    }

    @Test
    void allSupportedMeetingTypesKeepTitleAndPromptContract() {
        for (var entry : Map.of("theme-day", "主题党日", "members-meeting", "党员大会",
            "committee-meeting", "支委会").entrySet()) {
            var request = request(entry.getKey(), List.of(TOPIC), null);
            var meeting = MeetingContent.normalize(request);
            assertEquals(entry.getValue(), meeting.meetingTypeLabel());
            String prompt = prompt(request);
            assertTrue(prompt.contains("会议类型：" + entry.getValue()));
            assertTrue(prompt.contains("第一行输出“" + entry.getValue() + "记录”"));
        }
        assertTrue(prompt(request(null, List.of(TOPIC), null)).contains("会议类型：主题党日"));
    }

    @Test
    void committeeMeetingsRequireDefaultMattersWhenAbsentOrEmpty() {
        for (Object matters : List.of("", List.of())) {
            String prompt = prompt(request("committee-meeting", List.of(TOPIC), matters));
            assertTrue(prompt.contains("二、讨论党员大会议程及组织安排"));
            assertTrue(prompt.contains("三、讨论党员发展工作及培养考察安排"));
            assertTrue(prompt.contains("必须逐项讨论下列支部事项，不能省略"));
            assertTrue(prompt.contains("学习议题与支部事项合计3项"));
        }
        assertEquals(2, MeetingContent.normalize(request("committee-meeting", List.of(TOPIC), null))
            .branchMatters().size());
    }

    @Test
    void customMattersReplaceDefaultsAndContinueAfterLearningTopics() {
        String prompt = prompt(request("committee-meeting", List.of(TOPIC, "党员教育管理"),
            List.of(" 研究下月党员大会议程 ", "讨论入党积极分子培养安排", "研究下月党员大会议程", " ")));
        assertTrue(prompt.contains("三、讨论下月党员大会议程"));
        assertTrue(prompt.contains("四、讨论入党积极分子培养安排"));
        assertTrue(prompt.contains("学习议题与支部事项合计4项"));
        assertFalse(prompt.contains("研究党员大会议程及组织安排"));
        assertFalse(prompt.contains("讨论党员发展工作及培养考察安排"));
        assertTrue(prompt.contains("未明确的决定写为待进一步核实或提交讨论的建议"));
    }

    @Test
    void committeeMeetingsAcceptOneMatterPerLine() {
        String prompt = prompt(request("committee-meeting", List.of(TOPIC),
            "研究党员大会会务安排\r\n\r\n 讨论党员教育计划 "));
        assertTrue(prompt.contains("二、讨论党员大会会务安排"));
        assertTrue(prompt.contains("三、讨论党员教育计划"));
    }

    @Test
    void ordinaryMeetingsIgnoreCommitteeOnlyMattersIncludingInvalidShapes() {
        for (String meetingType : List.of("theme-day", "members-meeting")) {
            String prompt = prompt(request(meetingType, List.of(TOPIC),
                List.of("研究机密分组事项", "讨论特殊党员发展事项")));
            assertFalse(prompt.contains("机密分组事项"));
            assertFalse(prompt.contains("特殊党员发展事项"));
            assertFalse(prompt.contains("支部事项（按以下顺序"));
            assertTrue(prompt.contains("输出的议题数量必须与输入议题数量完全一致"));
            assertEquals(List.of(), MeetingContent.normalize(request(meetingType, List.of(TOPIC),
                Map.of("unexpected", "shape"))).branchMatters());
        }
    }

    @Test
    void committeeSpeakersExcludeOrdinaryMembersAndRawPeopleLists() {
        var request = new MeetingRequest("committee-meeting", List.of(TOPIC), "书记甲", "副书记乙",
            List.of("委员丙", "委员丁"), List.of("普通党员戊"),
            List.of("外部人员己", "普通党员戊"), null);
        var meeting = MeetingContent.normalize(request);
        assertEquals(List.of("书记甲", "副书记乙", "委员丙", "委员丁"), meeting.people());
        assertTrue(meeting.members().isEmpty());
        String prompt = prompt(request);
        assertTrue(prompt.contains("全部参会人员：书记甲、副书记乙、委员丙、委员丁"));
        assertFalse(prompt.contains("普通党员戊"));
        assertFalse(prompt.contains("外部人员己"));
        assertFalse(prompt.contains("\n成员："));
    }

    @Test
    void namesAreCleanedAndPeopleAreDeduplicatedInStableOrder() {
        var request = new MeetingRequest("members-meeting", List.of("  加强\u0000基层\n党组织建设 "),
            " 书记甲 ", " 副书记乙 ", List.of(" 委员丙 ", "委员丙"), List.of(" 党员丁 "),
            List.of("书记甲", "党员丁", "党员丁", " 党员戊 "), null);
        var meeting = MeetingContent.normalize(request);
        assertEquals(List.of("加强基层 党组织建设"), meeting.topics());
        assertEquals(List.of("委员丙"), meeting.committee());
        assertEquals(List.of("书记甲", "副书记乙", "委员丙", "党员丁", "党员戊"), meeting.people());
    }

    @Test
    void unknownMeetingTypesFailBeforeGeneration() {
        for (String meetingType : List.of("invalid-type", "__proto__", "constructor")) {
            var error = assertThrows(IllegalArgumentException.class,
                () -> MeetingContent.normalize(request(meetingType, List.of(TOPIC), null)));
            assertTrue(error.getMessage().contains("不支持的会议类型"));
        }
    }

    @Test
    void emptyTopicsFailValidation() {
        assertThrows(IllegalArgumentException.class, () -> MeetingContent.normalize(null));
        assertThrows(IllegalArgumentException.class,
            () -> MeetingContent.normalize(request(null, null, null)));
        assertThrows(IllegalArgumentException.class,
            () -> MeetingContent.normalize(request(null, List.of(" ", "\n"), null)));
    }

    @Test
    void topicMatterAndNameLimitsRejectOversizedRequests() {
        assertThrows(IllegalArgumentException.class, () -> MeetingContent.normalize(
            request(null, Collections.nCopies(MeetingContent.MAX_TOPICS + 1, TOPIC), null)));
        assertThrows(IllegalArgumentException.class, () -> MeetingContent.normalize(
            request(null, List.of("题".repeat(MeetingContent.MAX_TOPIC_LENGTH + 1)), null)));
        assertThrows(IllegalArgumentException.class, () -> MeetingContent.normalize(
            request("committee-meeting", List.of(TOPIC),
                Collections.nCopies(MeetingContent.MAX_BRANCH_MATTERS + 1, "事项"))));
        assertThrows(IllegalArgumentException.class, () -> MeetingContent.normalize(
            request("committee-meeting", List.of(TOPIC),
                List.of("事".repeat(MeetingContent.MAX_MATTER_LENGTH + 1)))));
        assertThrows(IllegalArgumentException.class, () -> MeetingContent.normalize(
            new MeetingRequest(null, List.of(TOPIC), "名".repeat(MeetingContent.MAX_NAME_LENGTH + 1),
                null, null, null, null, null)));
        var people = new ArrayList<String>();
        for (int index = 0; index < MeetingContent.MAX_PEOPLE; index++) {
            people.add("人员" + index);
        }
        assertThrows(IllegalArgumentException.class, () -> MeetingContent.normalize(
            new MeetingRequest(null, List.of(TOPIC), null, null, null, null, people, null)));
    }

    @Test
    void invalidCommitteeMatterShapeFailsValidation() {
        assertThrows(IllegalArgumentException.class, () -> MeetingContent.normalize(
            request("committee-meeting", List.of(TOPIC), Map.of("title", "事项"))));
        assertThrows(IllegalArgumentException.class, () -> MeetingContent.normalize(
            request("committee-meeting", List.of(TOPIC), List.of(3))));
    }

    @Test
    void surplusLearningSectionIsRemovedWhileLaterMattersRemain() {
        String original = "支委会记录\n一、学习《加强基层党组织建设》\n有效学习正文。\n"
            + "二、学习《未提供的议题》\n应删除的学习正文。\n"
            + "三、讨论党员大会议程及组织安排\n保留的委员讨论意见。\n"
            + "四、讨论党员发展工作及培养考察安排\n保留的后续工作安排。";
        String result = MeetingContent.trimExtraSections(original, 1);
        assertTrue(result.contains("有效学习正文"));
        assertFalse(result.contains("未提供的议题"));
        assertFalse(result.contains("应删除的学习正文"));
        assertTrue(result.contains("保留的委员讨论意见"));
        assertTrue(result.contains("保留的后续工作安排"));
    }

    @Test
    void trimmingRetainsAllSuppliedTopicsAndLaterDiscussion() {
        String original = "党员大会记录\n一、学习《第一议题》\n第一项正文。\n"
            + "二、学习《第二议题》\n第二项正文。\n三、学习《多余议题》\n多余正文。\n"
            + "四、讨论支部事项\n应保留的讨论。";
        assertEquals("党员大会记录\n一、学习《第一议题》\n第一项正文。\n"
            + "二、学习《第二议题》\n第二项正文。\n四、讨论支部事项\n应保留的讨论。",
            MeetingContent.trimExtraSections(original, 2));
    }

    @Test
    void trimmingSupportsArabicAndOversizedNumericHeadings() {
        String original = "会议记录\r\n1、学习《第一议题》\r\n保留。\r\n"
            + "99999999999999999999999、学习《多余议题》\r\n删除。\r\n3、讨论事项\r\n讨论保留。";
        assertEquals("会议记录\r\n1、学习《第一议题》\r\n保留。\r\n3、讨论事项\r\n讨论保留。",
            MeetingContent.trimExtraSections(original, 1));
        assertEquals("内容", MeetingContent.trimExtraSections(" 内容 ", 0));
        assertEquals("", MeetingContent.trimExtraSections(null, 1));
    }

    @Test
    void missingMaterialFallsBackAndNumberingContinuesPastTen() {
        var topics = new ArrayList<String>();
        for (int number = 1; number <= 11; number++) {
            topics.add("议题" + number);
        }
        var meeting = MeetingContent.normalize(request("committee-meeting", topics, List.of("讨论组织安排")));
        String prompt = MeetingContent.buildPrompt(meeting, List.of(new SourceMaterial(
            "议题1", "", "", ""), new SourceMaterial("议题2", null, null, null)));
        assertTrue(prompt.contains("来源：未取得明确来源"));
        assertTrue(prompt.contains("未检索到可用摘录，请根据题目进行规范生成。"));
        assertTrue(prompt.contains("第二议题检索材料：议题2"));
        assertTrue(prompt.contains("十二、讨论组织安排"));
        assertTrue(prompt.contains("学习议题与支部事项合计12项"));
    }

    @Test
    void chineseNumberingHandlesSectionBoundaries() {
        assertEquals("零", MeetingContent.toChineseNumber(0));
        assertEquals("一", MeetingContent.toChineseNumber(1));
        assertEquals("十", MeetingContent.toChineseNumber(10));
        assertEquals("十一", MeetingContent.toChineseNumber(11));
        assertEquals("二十", MeetingContent.toChineseNumber(20));
        assertEquals("四十", MeetingContent.toChineseNumber(40));
        assertEquals("九十九", MeetingContent.toChineseNumber(99));
        assertEquals("一百", MeetingContent.toChineseNumber(100));
        assertEquals("一百零一", MeetingContent.toChineseNumber(101));
        assertEquals("一千零一", MeetingContent.toChineseNumber(1001));
        assertThrows(IllegalArgumentException.class, () -> MeetingContent.toChineseNumber(-1));
    }
}
