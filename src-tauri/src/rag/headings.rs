//! Headings in extracted text, and the sections they open.
//!
//! Two sources, never mixed in one document:
//! - Markdown `#` lines: Markdown files, and the markers `file_processor`
//!   writes for DOCX heading styles and PDF outline titles. Used when a
//!   document has at least two.
//! - Otherwise numbered headings as theses and reports write them: "第一章
//!   绪论", "第二节", "3.2 数据来源", "一、", "（一）", "Chapter 4", and the
//!   unnumbered "摘要", "参考文献", "致谢"…
//!
//! A heading that repeats one already open at the same level (a running page
//! header carrying the chapter title) only cuts the line out of the text.

use super::cjk;

/// Shown between the parts of a heading path.
pub const PATH_SEPARATOR: &str = " › ";

/// Longest title kept in a path (characters).
const MAX_TITLE_CHARS: usize = 80;

/// Longest line read as a numbered heading (characters).
const MAX_HEADING_CHARS: usize = 60;

/// A heading line in the (normalized) text.
#[derive(Debug, Clone, PartialEq)]
pub struct Heading {
    /// Byte range of the line, without its newline.
    pub start: usize,
    pub end: usize,
    /// 1 = outermost.
    pub level: usize,
    pub title: String,
}

/// A run of text under one heading path.
#[derive(Debug, Clone, PartialEq)]
pub struct Section {
    /// Heading titles, outermost first (empty before the first heading).
    pub path: Vec<String>,
    /// Byte range of the body (heading lines left out).
    pub start: usize,
    pub end: usize,
}

impl Section {
    pub fn path_text(&self) -> String {
        self.path.join(PATH_SEPARATOR)
    }
}

/// The headings of `text`: its Markdown headings when it has two or more,
/// else its numbered ones.
pub fn find_headings(text: &str) -> Vec<Heading> {
    let markdown = markdown_headings(text);
    if markdown.len() >= 2 {
        return markdown;
    }
    lines(text)
        .filter_map(|(start, end)| {
            let (level, title) = numbered_heading(&text[start..end])?;
            Some(Heading { start, end, level, title })
        })
        .collect()
}

/// `(start, end)` byte ranges of the lines of `text` (newlines excluded).
fn lines(text: &str) -> impl Iterator<Item = (usize, usize)> + '_ {
    let mut start = 0;
    text.split('\n').map(move |line| {
        let range = (start, start + line.len());
        start += line.len() + 1;
        range
    })
}

fn markdown_headings(text: &str) -> Vec<Heading> {
    let mut out = Vec::new();
    let mut fenced = false;
    for (start, end) in lines(text) {
        let line = text[start..end].trim();
        if line.starts_with("```") || line.starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        let hashes = line.chars().take_while(|c| *c == '#').count();
        if !(1..=6).contains(&hashes) {
            continue;
        }
        let rest = &line[hashes..];
        if !rest.starts_with(char::is_whitespace) {
            continue;
        }
        let title = clean_title(rest.trim().trim_end_matches('#'));
        if !title.is_empty() {
            out.push(Heading { start, end, level: hashes, title });
        }
    }
    out
}

/// Unnumbered top-level sections of theses and papers (whitespace removed,
/// lowercase).
const NAMED_SECTIONS: &[&str] = &[
    "摘要", "中文摘要", "英文摘要", "abstract", "目录", "目次", "contents", "tableofcontents", "引言", "绪论", "前言",
    "导论", "结论", "结语", "结束语", "总结与展望", "结论与展望", "参考文献", "references", "bibliography", "致谢", "致谢辞",
    "acknowledgements", "acknowledgments", "附录", "appendix", "后记", "作者简介", "攻读学位期间取得的研究成果",
];

/// Level and title of a numbered (or named) heading line.
fn numbered_heading(line: &str) -> Option<(usize, String)> {
    let line = line.trim();
    let chars = line.chars().count();
    if chars < 2 || chars > MAX_HEADING_CHARS {
        return None;
    }
    // Sentences, table-of-contents rows and links are not headings.
    if line.contains(['。', '，', '；', '！', '？', '…'])
        || line.ends_with([':', '：', ',', ';', '.', '、'])
        || line.contains("....")
        || line.contains("····")
        || line.contains("://")
        || ends_with_page_number(line)
    {
        return None;
    }

    let compact: String = line.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_lowercase();
    if NAMED_SECTIONS.contains(&compact.as_str()) {
        return Some((1, clean_title(line)));
    }
    if compact.starts_with("附录") || compact.starts_with("appendix") {
        return Some((1, clean_title(line)));
    }

    if let Some(rest) = line.strip_prefix('第') {
        let digits: String = rest.chars().take_while(|c| is_chinese_numeral(*c) || c.is_ascii_digit()).collect();
        let after = &rest[digits.len()..];
        if (1..=4).contains(&digits.chars().count()) {
            if after.starts_with(['章', '篇', '部']) {
                return Some((1, clean_title(line)));
            }
            if after.starts_with('节') {
                return Some((2, clean_title(line)));
            }
        }
        return None;
    }

    let lower = line.to_lowercase();
    for word in ["chapter ", "part "] {
        if let Some(rest) = lower.strip_prefix(word) {
            if rest.trim_start().starts_with(|c: char| c.is_ascii_digit() || matches!(c, 'i' | 'v' | 'x')) {
                return Some((1, clean_title(line)));
            }
        }
    }

    // 一、 / （一）
    let ordinal: String = line.chars().take_while(|c| is_chinese_numeral(*c)).collect();
    if (1..=3).contains(&ordinal.chars().count()) && line[ordinal.len()..].starts_with('、') {
        return titled(&line[ordinal.len() + '、'.len_utf8()..]).then(|| (2, clean_title(line)));
    }
    if let Some(rest) = line.strip_prefix('（').or_else(|| line.strip_prefix('(')) {
        let ordinal: String = rest.chars().take_while(|c| is_chinese_numeral(*c)).collect();
        let after = &rest[ordinal.len()..];
        if (1..=3).contains(&ordinal.chars().count()) && (after.starts_with('）') || after.starts_with(')')) {
            let title = after.char_indices().nth(1).map_or("", |(i, _)| &after[i..]);
            return titled(title).then(|| (3, clean_title(line)));
        }
        return None;
    }

    // 1 绪论 / 3.2 数据来源 / 3.2.1问卷设计
    let (depth, label_len) = numeric_label(line)?;
    let rest = &line[label_len..];
    let next = rest.chars().next()?;
    let separated = next.is_whitespace() || (depth >= 2 && cjk::is_cjk(next));
    if !separated || !titled(rest) {
        return None;
    }
    Some((depth, clean_title(line)))
}

/// Depth and byte length of a leading "1", "3.2", "3.2.1" (at most four
/// parts of one or two digits).
fn numeric_label(line: &str) -> Option<(usize, usize)> {
    let bytes = line.as_bytes();
    let mut i = 0;
    let mut depth = 0;
    loop {
        let digits = bytes[i..].iter().take_while(|b| b.is_ascii_digit()).count();
        if !(1..=2).contains(&digits) {
            return None;
        }
        i += digits;
        depth += 1;
        if depth < 4 && bytes.get(i) == Some(&b'.') && bytes.get(i + 1).is_some_and(u8::is_ascii_digit) {
            i += 1;
            continue;
        }
        break;
    }
    if bytes.get(i).is_some_and(|b| b.is_ascii_digit() || *b == b'.' || *b == b'%') {
        return None;
    }
    Some((depth, i))
}

/// Whether a heading's text after its number reads as a title: two CJK
/// characters or a word of three letters, and not mostly numbers (a table row).
fn titled(rest: &str) -> bool {
    let cjk_chars = rest.chars().filter(|c| cjk::is_cjk(*c)).count();
    let long_word = rest
        .split(|c: char| !c.is_ascii_alphabetic())
        .any(|w| w.len() >= 3);
    if cjk_chars < 2 && !long_word {
        return false;
    }
    let tokens: Vec<&str> = rest.split_whitespace().collect();
    let numeric = tokens.iter().filter(|t| t.chars().all(|c| c.is_ascii_digit() || c == '.')).count();
    numeric * 2 <= tokens.len()
}

/// "绪论 1", "Introduction 12": a table-of-contents row.
fn ends_with_page_number(line: &str) -> bool {
    let digits = line.chars().rev().take_while(|c| c.is_ascii_digit()).count();
    if digits == 0 || digits == line.chars().count() {
        return false;
    }
    let before = line.trim_end_matches(|c: char| c.is_ascii_digit());
    before.ends_with(char::is_whitespace) && before.trim_end().chars().last().is_some_and(|c| !c.is_ascii_digit() && c != '.')
}

fn is_chinese_numeral(c: char) -> bool {
    "一二三四五六七八九十百零〇两".contains(c)
}

/// Whitespace runs collapsed, `#` markers gone, length capped.
fn clean_title(title: &str) -> String {
    let collapsed = title.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_start_matches('#').trim();
    if trimmed.chars().count() > MAX_TITLE_CHARS {
        let mut cut: String = trimmed.chars().take(MAX_TITLE_CHARS).collect();
        cut.push('…');
        cut
    } else {
        trimmed.to_string()
    }
}

/// Splits `text` into the sections `headings` open. Heading lines are left
/// out of the bodies; sections with an empty body are dropped; a heading
/// that repeats an open one of the same level ends a body without changing
/// the path (adjacent sections may then share a path).
pub fn sections(text: &str, headings: &[Heading]) -> Vec<Section> {
    let mut out = Vec::new();
    let mut stack: Vec<(usize, String)> = Vec::new();
    let mut body_start = 0;
    let push = |path: &[(usize, String)], start: usize, end: usize, out: &mut Vec<Section>| {
        let body = &text[start..end];
        let lead = body.len() - body.trim_start().len();
        let trimmed = body.trim();
        if !trimmed.is_empty() {
            out.push(Section {
                path: path.iter().map(|(_, t)| t.clone()).collect(),
                start: start + lead,
                end: start + lead + trimmed.len(),
            });
        }
    };
    for h in headings {
        push(stack.as_slice(), body_start, h.start.max(body_start), &mut out);
        body_start = (h.end + 1).min(text.len());
        let repeated = stack.iter().any(|(level, title)| *level == h.level && *title == h.title);
        if repeated {
            continue;
        }
        while stack.last().is_some_and(|(level, _)| *level >= h.level) {
            stack.pop();
        }
        stack.push((h.level, h.title.clone()));
    }
    push(stack.as_slice(), body_start, text.len(), &mut out);
    out
}

/// A chapter: a heading of the document's chapter level and all text
/// under it (sub-heading lines included).
#[derive(Debug, Clone, PartialEq)]
pub struct Chapter {
    /// Heading path of the chapter heading itself.
    pub path: Vec<String>,
    /// Byte range of the text after the chapter heading line.
    pub start: usize,
    pub end: usize,
}

impl Chapter {
    pub fn path_text(&self) -> String {
        self.path.join(PATH_SEPARATOR)
    }
}

/// The chapters of `text`: the sections opened by the shallowest heading
/// level used at least twice (a single top heading is usually the title).
/// Front and back matter (abstract, contents, references,
/// acknowledgements, appendices) are left out.
pub fn chapters(text: &str, headings: &[Heading]) -> Vec<Chapter> {
    let Some(level) = (1..=6).find(|l| headings.iter().filter(|h| h.level == *l).count() >= 2) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut stack: Vec<(usize, String)> = Vec::new();
    let mut open: Option<Chapter> = None;
    for h in headings {
        if stack.iter().any(|(l, t)| *l == h.level && *t == h.title) {
            continue;
        }
        while stack.last().is_some_and(|(l, _)| *l >= h.level) {
            stack.pop();
        }
        stack.push((h.level, h.title.clone()));
        if h.level > level {
            continue;
        }
        if let Some(mut chapter) = open.take() {
            chapter.end = h.start.max(chapter.start);
            out.push(chapter);
        }
        if h.level == level && !is_front_or_back_matter(&h.title) {
            let start = (h.end + 1).min(text.len());
            open = Some(Chapter { path: stack.iter().map(|(_, t)| t.clone()).collect(), start, end: start });
        }
    }
    if let Some(mut chapter) = open {
        chapter.end = text.len();
        out.push(chapter);
    }
    out.retain(|c| !text[c.start..c.end].trim().is_empty());
    out
}

/// Abstract, contents and the lists of tables and figures, declarations,
/// references, acknowledgements, appendices: no summary.
fn is_front_or_back_matter(title: &str) -> bool {
    const SKIPPED: &[&str] = &[
        "摘要", "中文摘要", "英文摘要", "abstract", "目录", "目次", "contents", "tableofcontents", "参考文献",
        "references", "bibliography", "致谢", "致谢辞", "acknowledgements", "acknowledgments", "acknowledgement",
        "acknowledgment", "作者简介", "插图目录", "图目录", "表格目录", "表目录", "附表目录", "插图和附表清单",
        "符号说明", "主要符号表", "符号表", "缩略语", "listoftables", "listoffigures", "listofsymbols",
        "listofabbreviations", "abbreviations", "nomenclature", "glossary", "declaration", "声明", "独创性声明",
        "原创性声明", "学位论文原创性声明",
    ];
    let compact: String = title.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_lowercase();
    SKIPPED.contains(&compact.as_str()) || compact.starts_with("附录") || compact.starts_with("appendix")
}

/// The heading path parts of a stored path text.
pub fn split_path(path: &str) -> Vec<&str> {
    if path.is_empty() {
        Vec::new()
    } else {
        path.split(PATH_SEPARATOR).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn titles(text: &str) -> Vec<(usize, String)> {
        find_headings(text).into_iter().map(|h| (h.level, h.title)).collect()
    }

    fn paths(text: &str) -> Vec<(String, String)> {
        sections(text, &find_headings(text))
            .into_iter()
            .map(|s| (s.path_text(), text[s.start..s.end].to_string()))
            .collect()
    }

    #[test]
    fn markdown_headings_win_when_there_are_two() {
        let text = "# 标题\n\n引言段落。\n\n## 1.1 背景\n\n正文。\n\n```\n# not a heading\n```\n\n### 细节 ###\n内容";
        assert_eq!(
            titles(text),
            vec![(1, "标题".into()), (2, "1.1 背景".into()), (3, "细节".into())]
        );
        // One marker is not enough: numbered headings are looked for instead.
        assert_eq!(titles("# 题目\n\n第一章 绪论\n正文。"), vec![(1, "第一章 绪论".into())]);
        assert!(titles("#hashtag line\n#another").is_empty());
    }

    #[test]
    fn thesis_headings_are_found_with_levels() {
        let text = "摘  要\n本文研究了……的问题。\n第一章 绪论\n1.1 研究背景\n近年来，随着技术发展，问题日益突出。\n1.1.1国内研究现状\n文献综述内容。\n一、研究对象\n（一）样本选择\n第二节 方法\nChapter 3 Methods\n参考文献\n[1] 张三. 论文[J]. 期刊, 2020.";
        assert_eq!(
            titles(text),
            vec![
                (1, "摘 要".into()),
                (1, "第一章 绪论".into()),
                (2, "1.1 研究背景".into()),
                (3, "1.1.1国内研究现状".into()),
                (2, "一、研究对象".into()),
                (3, "（一）样本选择".into()),
                (2, "第二节 方法".into()),
                (1, "Chapter 3 Methods".into()),
                (1, "参考文献".into()),
            ]
        );
    }

    #[test]
    fn sentences_toc_rows_numbers_and_tables_are_not_headings() {
        for line in [
            "1.1 研究背景 .......... 3",
            "第一章 绪论 1",
            "1.2倍的增长，说明问题。",
            "2023 年的数据",
            "3.14159",
            "2.5 mm",
            "12",
            "1 2 3 4",
            "1 张三 25 46",
            "图 3.2 系统架构",
            "1. 首先收集数据",
            "这是一个普通的句子，没有标题。",
            "见 https://example.com",
            "第一个问题是什么",
        ] {
            assert!(numbered_heading(line).is_none(), "{line:?}");
        }
    }

    #[test]
    fn sections_carry_paths_and_skip_heading_only_bodies() {
        let text = "前言文字。\n第一章 绪论\n1.1 研究背景\n背景正文。\n1.2 研究意义\n意义正文。\n第二章 方法\n方法正文。";
        assert_eq!(
            paths(text),
            vec![
                ("".into(), "前言文字。".into()),
                ("第一章 绪论 › 1.1 研究背景".into(), "背景正文。".into()),
                ("第一章 绪论 › 1.2 研究意义".into(), "意义正文。".into()),
                ("第二章 方法".into(), "方法正文。".into()),
            ]
        );
    }

    #[test]
    fn a_repeated_running_header_keeps_the_path() {
        let text = "第三章 研究方法\n3.2 数据来源\n第一页的内容。\n第三章 研究方法\n第二页的内容。\n3.3 分析\n分析内容。";
        assert_eq!(
            paths(text),
            vec![
                ("第三章 研究方法 › 3.2 数据来源".into(), "第一页的内容。".into()),
                ("第三章 研究方法 › 3.2 数据来源".into(), "第二页的内容。".into()),
                ("第三章 研究方法 › 3.3 分析".into(), "分析内容。".into()),
            ]
        );
    }

    #[test]
    fn chapters_use_the_shallowest_repeated_level_and_skip_back_matter() {
        let text = "# 论文题目\n## 摘要\n摘要内容。\n## 第一章 绪论\n绪论内容。\n### 1.1 背景\n背景内容。\n## 第二章 方法\n方法内容。\n## 参考文献\n[1] 文献。\n## 致谢\n感谢。";
        let found = find_headings(text);
        let got: Vec<(String, String)> = chapters(text, &found)
            .into_iter()
            .map(|c| (c.path_text(), text[c.start..c.end].trim().to_string()))
            .collect();
        assert_eq!(
            got,
            vec![
                ("论文题目 › 第一章 绪论".into(), "绪论内容。\n### 1.1 背景\n背景内容。".into()),
                ("论文题目 › 第二章 方法".into(), "方法内容。".into()),
            ]
        );
        // A running header repeating the chapter title does not start a new one.
        let text = "第一章 绪论\n第一页。\n第一章 绪论\n第二页。\n第二章 方法\n方法。";
        let found = find_headings(text);
        let got = chapters(text, &found);
        assert_eq!(got.len(), 2);
        assert_eq!(text[got[0].start..got[0].end].trim(), "第一页。\n第一章 绪论\n第二页。");
        assert!(chapters("只有正文。", &[]).is_empty());
    }

    #[test]
    fn front_matter_in_english_gets_no_summary() {
        for title in ["Acknowledgement", "List of Tables", "List of Figures", "Declaration", "原创性声明", "Appendix G: Re-split"] {
            assert!(is_front_or_back_matter(title), "{title}");
        }
        for title in ["Chapter 6: Conclusion", "Publication and Code Availability", "第三章 研究方法"] {
            assert!(!is_front_or_back_matter(title), "{title}");
        }
    }

    #[test]
    fn text_without_headings_is_one_section() {
        let text = "只有正文。\n\n第二段。";
        assert_eq!(paths(text), vec![("".into(), text.into())]);
        assert!(sections("", &[]).is_empty());
        assert_eq!(split_path("a › b"), vec!["a", "b"]);
        assert!(split_path("").is_empty());
    }
}
