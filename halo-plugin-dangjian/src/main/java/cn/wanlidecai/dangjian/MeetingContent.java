package cn.wanlidecai.dangjian;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.IntStream;

/** Pure meeting input and output rules, shared by every generation provider. */
public final class MeetingContent {
    public static final int MAX_TOPICS = 20;
    public static final int MAX_TOPIC_LENGTH = 300;
    public static final int MAX_BRANCH_MATTERS = 20;
    public static final int MAX_MATTER_LENGTH = 500;
    public static final int MAX_PEOPLE = 100;
    public static final int MAX_NAME_LENGTH = 50;

    private static final String DEFAULT_SECRETARY = "李强";
    private static final String DEFAULT_DEPUTY = "郭琳";
    private static final List<String> DEFAULT_COMMITTEE = List.of("王丽");
    private static final List<String> DEFAULT_MEMBERS =
        List.of("刘广彪", "魏鹏飞", "许茜", "杨可来尔", "尹泽华");
    private static final List<String> DEFAULT_BRANCH_MATTERS = List.of(
        "研究党员大会议程及组织安排", "讨论党员发展工作及培养考察安排");
    private static final Map<String, String> MEETING_TYPES = Map.of(
        "theme-day", "主题党日",
        "members-meeting", "党员大会",
        "committee-meeting", "支委会");
    private static final Pattern HEADINGS = Pattern.compile(
        "^[ \\t]*([一二三四五六七八九十百千零\\d]+)、[^\\r\\n]+", Pattern.MULTILINE);
    private static final Pattern LEARNING_HEADING = Pattern.compile(
        "^[ \\t]*[一二三四五六七八九十百千零\\d]+、学习《[^》]+》");

    private MeetingContent() {
    }

    public record NormalizedMeeting(
        String meetingType,
        String meetingTypeLabel,
        List<String> topics,
        String secretary,
        String deputy,
        List<String> committee,
        List<String> members,
        List<String> people,
        List<String> branchMatters
    ) {
    }

    public static Map<String, Object> defaultsRoles() {
        var roles = new LinkedHashMap<String, Object>();
        roles.put("secretary", DEFAULT_SECRETARY);
        roles.put("deputy", DEFAULT_DEPUTY);
        roles.put("committee", DEFAULT_COMMITTEE);
        roles.put("members", DEFAULT_MEMBERS);
        return Map.copyOf(roles);
    }

    public static NormalizedMeeting normalize(MeetingRequest request) {
        if (request == null) {
            throw new IllegalArgumentException("请至少填写一个议题。");
        }
        String meetingType = cleanText(request.meetingType());
        if (meetingType.isEmpty()) {
            meetingType = "theme-day";
        }
        String label = MEETING_TYPES.get(meetingType);
        if (label == null) {
            throw new IllegalArgumentException("不支持的会议类型，请选择主题党日、党员大会或支委会。");
        }
        boolean committeeMeeting = "committee-meeting".equals(meetingType);
        List<String> topics = cleanList(request.topics(), MAX_TOPICS, MAX_TOPIC_LENGTH, "学习议题");
        if (topics.isEmpty()) {
            throw new IllegalArgumentException("请至少填写一个议题。");
        }
        String secretary = normalizeName(request.secretary(), DEFAULT_SECRETARY);
        String deputy = normalizeName(request.deputy(), DEFAULT_DEPUTY);
        List<String> committee = normalizeNames(request.committee(), DEFAULT_COMMITTEE);
        List<String> members = committeeMeeting ? List.of()
            : normalizeNames(request.members(), DEFAULT_MEMBERS);
        var rolePeople = new ArrayList<String>();
        rolePeople.add(secretary);
        rolePeople.add(deputy);
        rolePeople.addAll(committee);
        rolePeople.addAll(members);
        List<String> suppliedPeople = committeeMeeting ? List.of()
            : normalizeNames(request.people(), rolePeople);
        var people = new LinkedHashSet<String>();
        people.add(secretary);
        people.add(deputy);
        people.addAll(committee);
        people.addAll(suppliedPeople);
        if (people.size() > MAX_PEOPLE) {
            throw new IllegalArgumentException("参会人员不能超过" + MAX_PEOPLE + "人。");
        }
        List<String> matters = committeeMeeting ? normalizeMatters(request.branchMatters()) : List.of();
        return new NormalizedMeeting(meetingType, label, topics, secretary, deputy, committee,
            members, List.copyOf(people), matters);
    }

    private static String normalizeName(String rawName, String fallback) {
        String name = cleanText(rawName);
        if (name.isEmpty()) {
            return fallback;
        }
        checkLength(name, MAX_NAME_LENGTH, "姓名");
        return name;
    }

    private static List<String> normalizeNames(List<String> values, List<String> fallback) {
        List<String> cleaned = cleanList(values, MAX_PEOPLE, MAX_NAME_LENGTH, "人员");
        return cleaned.isEmpty() ? List.copyOf(fallback)
            : List.copyOf(new LinkedHashSet<>(cleaned));
    }

    private static List<String> normalizeMatters(Object rawMatters) {
        List<String> values;
        if (rawMatters == null) {
            values = List.of();
        } else if (rawMatters instanceof String text) {
            values = List.of(text.split("\\r?\\n"));
        } else if (rawMatters instanceof List<?> list) {
            values = new ArrayList<>();
            for (Object value : list) {
                if (value != null && !(value instanceof String)) {
                    throw new IllegalArgumentException("支部事项必须是文本或文本数组。");
                }
                values.add((String) value);
            }
        } else {
            throw new IllegalArgumentException("支部事项必须是文本或文本数组。");
        }
        List<String> cleaned = cleanList(values, MAX_BRANCH_MATTERS, MAX_MATTER_LENGTH, "支部事项");
        return cleaned.isEmpty() ? DEFAULT_BRANCH_MATTERS
            : List.copyOf(new LinkedHashSet<>(cleaned));
    }

    private static List<String> cleanList(List<String> values, int maxCount, int maxLength, String label) {
        if (values == null) {
            return List.of();
        }
        // Bound the raw collection as well so empty strings cannot bypass resource limits.
        if (values.size() > maxCount) {
            throw new IllegalArgumentException(label + "不能超过" + maxCount + "项。");
        }
        var cleaned = new ArrayList<String>();
        for (String value : values) {
            String text = cleanText(value);
            if (!text.isEmpty()) {
                checkLength(text, maxLength, label);
                cleaned.add(text);
            }
        }
        return List.copyOf(cleaned);
    }

    private static void checkLength(String value, int maxLength, String label) {
        if (value.codePointCount(0, value.length()) > maxLength) {
            throw new IllegalArgumentException(label + "每项不能超过" + maxLength + "字。");
        }
    }

    private static String cleanText(String text) {
        return text == null ? "" : text.replace("\u0000", "")
            .replaceAll("[\\s\\p{Z}]+", " ").trim();
    }

    public static String buildPrompt(NormalizedMeeting meeting, List<SourceMaterial> sourcePack) {
        boolean committeeMeeting = "committee-meeting".equals(meeting.meetingType());
        List<String> topics = meeting.topics();
        String secretary = meeting.secretary();
        String topicLines = IntStream.range(0, topics.size())
            .mapToObj(index -> (index + 1) + ". " + topics.get(index))
            .collect(Collectors.joining("\n"));
        List<SourceMaterial> sources = sourcePack == null ? List.of() : sourcePack;
        String sourceLines = IntStream.range(0, sources.size()).mapToObj(index -> {
            SourceMaterial item = sources.get(index);
            String materialLabel = index == 0 ? "第一议题参考材料"
                : "第" + toChineseNumber(index + 1) + "议题检索材料";
            return materialLabel + "：" + item.topic() + "\n来源："
                + nonEmpty(item.source(), "未取得明确来源") + "\n摘录："
                + nonEmpty(item.excerpt(), "未检索到可用摘录，请根据题目进行规范生成。") + "\n";
        }).collect(Collectors.joining("\n"));
        String firstExample = """
            输出格式示例：
            一、学习《%s》
            xx同志领学了《%s》。围绕检索材料和学习内容作约100字概括摘抄，说明主要内容、核心要求和实践指向。与会人员结合自身工作谈了学习体会。
            xx同志:
            不少于50字的心得体会。
            xx同志:
            不少于50字的心得体会。
            党支部书记%s同志:
            不少于50字的学习总结。
            """.formatted(topics.getFirst(), topics.getFirst(), secretary);
        String formatHint = topics.size() == 1
            ? firstExample + "\n注意：本次只有一个学习议题，严禁输出“二、学习”。支部事项按其专门要求继续编号。"
            : firstExample + "\n二、学习《" + topics.get(1) + "》\n约100字原文摘取或整理内容。";
        String meetingRequirement = committeeMeeting
            ? "本次为支部委员会会议，参会人员和发言人员仅限党支部书记、副书记及委员。学习议题结束后，必须逐项讨论下列支部事项，不能省略。"
            : "members-meeting".equals(meeting.meetingType())
                ? "本次为党员大会，体现全体参会党员围绕学习议题开展学习交流，由党支部书记提出贯彻落实要求。"
                : "本次为主题党日，围绕学习议题体现主题学习、党员交流和联系工作实际落实要求；未提供的实践活动不得自行编造。";
        String scopeRequirement = committeeMeeting
            ? "只能输出用户输入的" + topics.size() + "个学习议题及下列" + meeting.branchMatters().size()
                + "项支部事项，严禁自行新增其他议题。学习议题与支部事项合计"
                + (topics.size() + meeting.branchMatters().size()) + "项。"
            : "只能输出用户输入的学习议题，严禁新增、联想或补充其他议题；输出的议题数量必须与输入议题数量完全一致。";
        String branchMatterInstructions = "";
        if (committeeMeeting) {
            String matterHeadings = IntStream.range(0, meeting.branchMatters().size())
                .mapToObj(index -> toChineseNumber(topics.size() + index + 1) + "、讨论"
                    + meeting.branchMatters().get(index).replaceFirst("^(研究|讨论)", ""))
                .collect(Collectors.joining("\n"));
            branchMatterInstructions = """

                支部事项（按以下顺序接在全部学习议题之后）：
                %s

                支部事项记录要求：
                每项使用上述标题，编号承接学习议题。正文按“事项内容、委员讨论意见、书记归纳及后续安排”的结构展开，副书记和委员的意见必须围绕该项具体事项，不要套用学习心得格式。
                涉及党员大会议程时，讨论议题设置、会议准备和组织安排；涉及党员发展时，讨论培养教育、考察材料及后续工作安排，具体内容以输入事项为准。
                用户未提供的具体人名、日期、发展阶段、票数、表决结果或审批结论不得编造；未明确的具体信息用“待补充”标识，未明确的决定写为待进一步核实或提交讨论的建议，不得写成已经表决通过、批准发展或完成审批。
                """.formatted(matterHeadings);
        }
        return """
            请根据以下信息生成%s记录。

            会议类型：%s
            %s

            固定要求：
            0. 第一行输出“%s记录”，接着输出编号议题正文。
            1. 第一议题必须写成“领学 + 两名同志分享心得 + 党支部书记作学习总结”。
            2. 只有第一议题需要领学、两分享、党支部书记总结。
            3. 第一议题领学段必须围绕第一议题题目和检索材料进行概括摘抄，正文约100字，体现“领学人员检索题目、总结内容摘抄”的效果；如果检索材料为空，根据该题目常见公开原文内容进行规范凝练。
            4. 第一议题两名分享人员的心得每人至少50字，必须结合岗位职责或工作实际，不能写成口号。
            5. 党支部书记学习总结至少50字，必须使用“党支部书记%s同志:”作为姓名行，内容要体现总结、要求和落实方向。
            6. 第二个及以后的学习议题，只输出“二、学习《题目》”这类标题，并摘取或整理约100字原文内容；如果有检索材料，优先从检索材料中摘取；如果检索材料为空，根据该题目常见公开原文内容进行凝练，不要再写心得、领学和总结。%s
            7. 如有多个议题，按“一、二、三、四、五……”顺序继续编号，议题数量不限制。
            8. 所有姓名必须从参会人员中选取，领学人员和两名分享人员不能是党支部书记%s，优先从副书记、委员、成员中选择；如实际参会人员不足两名非书记人员，只使用现有人员，不能编造姓名。职务仅使用输入信息，未明确委员分工时只称“委员”，不得自行指定为组织委员、宣传委员或纪检委员。
            9. %s
            10. 语言正式、准确、可直接复制到会议记录中，不要添加说明、注释、Markdown代码块或除会议类型和编号议题以外的多余标题。

            党支部书记：%s
            副书记：%s
            委员：%s
            %s全部参会人员：%s

            议题：
            %s

            检索/参考材料：
            %s

            %s
            %s""".formatted(
            meeting.meetingTypeLabel(), meeting.meetingTypeLabel(), meetingRequirement,
            meeting.meetingTypeLabel(), secretary, committeeMeeting ? "支部事项另按下方要求记录。" : "",
            secretary, scopeRequirement, secretary, meeting.deputy(),
            String.join("、", meeting.committee()),
            committeeMeeting ? "" : "成员：" + String.join("、", meeting.members()) + "\n",
            String.join("、", meeting.people()), topicLines, sourceLines, formatHint, branchMatterInstructions);
    }

    private static String nonEmpty(String value, String fallback) {
        return value == null || value.isBlank() ? fallback : value;
    }

    public static String trimExtraSections(String content, int topicCount) {
        if (content == null) {
            return "";
        }
        if (topicCount < 1) {
            return content.trim();
        }
        Set<String> allowedNumbers = IntStream.rangeClosed(1, topicCount)
            .mapToObj(MeetingContent::toChineseNumber).collect(Collectors.toSet());
        var headings = HEADINGS.matcher(content).results().toList();
        var result = new StringBuilder();
        int start = 0;
        for (int index = 0; index < headings.size(); index++) {
            var heading = headings.get(index);
            String number = heading.group(1);
            boolean isAllowed = allowedNumbers.contains(number);
            if (!isAllowed && number.matches("\\d+")) {
                try {
                    int numeric = Integer.parseInt(number);
                    isAllowed = numeric >= 1 && numeric <= topicCount;
                } catch (NumberFormatException ignored) {
                    // Oversized numeric headings are surplus, without aborting valid output.
                }
            }
            if (LEARNING_HEADING.matcher(heading.group()).find() && !isAllowed) {
                result.append(content, start, heading.start());
                start = index + 1 < headings.size() ? headings.get(index + 1).start() : content.length();
            }
        }
        return result.append(content.substring(start)).toString().trim();
    }

    public static String toChineseNumber(int number) {
        if (number < 0 || number > 9999) {
            throw new IllegalArgumentException("编号必须在0到9999之间。");
        }
        if (number == 0) {
            return "零";
        }
        String[] digits = {"零", "一", "二", "三", "四", "五", "六", "七", "八", "九"};
        String[] units = {"", "十", "百", "千"};
        var result = new StringBuilder();
        boolean zeroPending = false;
        for (int place = 3; place >= 0; place--) {
            int divisor = (int) Math.pow(10, place);
            int digit = number / divisor % 10;
            if (digit == 0) {
                if (!result.isEmpty() && number % divisor != 0) {
                    zeroPending = true;
                }
                continue;
            }
            if (zeroPending) {
                result.append("零");
                zeroPending = false;
            }
            if (!(digit == 1 && place == 1 && result.isEmpty())) {
                result.append(digits[digit]);
            }
            result.append(units[place]);
        }
        return result.toString();
    }
}
