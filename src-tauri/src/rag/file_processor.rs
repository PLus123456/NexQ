use std::collections::HashMap;

use crate::context::{file_loader, pdf_extractor};

/// Extract text from a file based on its type.
///
/// Dispatches to the appropriate extractor:
/// - "pdf" → `pdf_extractor::extract_text_from_pdf`
/// - "txt" or "md" → `file_loader::load_text_file`
/// - "docx" → `extract_docx_text` (simple XML parsing of OOXML)
pub fn extract_text(file_path: &str, file_type: &str) -> Result<String, String> {
    match file_type.to_lowercase().as_str() {
        "pdf" => pdf_extractor::extract_text_from_pdf(file_path),
        "txt" | "md" => file_loader::load_text_file(file_path),
        "docx" => extract_docx_text(file_path),
        other => Err(format!(
            "Unsupported file type for text extraction: {}",
            other
        )),
    }
}

/// Prepares a PDF's extracted `text` for the heading splitter: running
/// headers and footers are cut out, and lines that read like one of its
/// outline (bookmark) titles become Markdown headings at the outline's level.
/// A PDF lopdf can't read gives `text` back; one without an outline only
/// loses its running lines.
pub fn mark_pdf_outline(file_path: &str, text: &str) -> String {
    let doc = match lopdf::Document::load(file_path) {
        Ok(doc) => doc,
        Err(_) => return text.to_string(),
    };
    let outline = doc
        .get_toc()
        .map(|toc| toc.toc.into_iter().map(|t| (t.level, t.title)).collect::<Vec<_>>())
        .unwrap_or_default();
    let text = strip_running_lines(text, doc.get_pages().len(), &outline);
    mark_outline_lines(&text, &outline)
}

/// Whitespace and case ignored.
fn outline_key(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_lowercase()
}

/// Cuts out lines that come back on a quarter of the pages or more (at least
/// 5 times), digits ignored: running headers and footers such as the title
/// with "Page 5 of 73". Only lines with some letters count, so repeated
/// table rows of numbers stay.
///
/// Word also prints the first heading of a page in its header, even when the
/// page starts inside the previous section; taken for the heading, that copy
/// would file the rest of the previous section under the next one. A title
/// line next to a running line is dropped as such a copy when the same title
/// comes next in the body of that page (not next to a running line itself),
/// and only for titles the outline has once ("本章小结" in every chapter is a
/// real heading each time). Other copies stay for the heading splitter, which
/// cuts a repeat of an open heading.
fn strip_running_lines(text: &str, pages: usize, outline: &[(usize, String)]) -> String {
    if pages < 4 {
        return text.to_string();
    }
    let mut in_outline: HashMap<String, usize> = HashMap::new();
    for (_, t) in outline {
        *in_outline.entry(outline_key(t)).or_default() += 1;
    }
    // Digit runs become one '#', so "Page 5 of 73" and "Page 12 of 73" match.
    let shape = |line: &str| -> Option<String> {
        if line.chars().filter(|c| c.is_alphabetic()).count() < 4 || in_outline.contains_key(&outline_key(line)) {
            return None;
        }
        let mut out = String::new();
        for c in line.chars().filter(|c| !c.is_whitespace()) {
            if c.is_ascii_digit() {
                if !out.ends_with('#') {
                    out.push('#');
                }
            } else {
                out.extend(c.to_lowercase());
            }
        }
        Some(out)
    };
    let lines: Vec<&str> = text.split('\n').collect();
    let shapes: Vec<Option<String>> = lines.iter().map(|l| shape(l)).collect();
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for s in shapes.iter().flatten() {
        *counts.entry(s.as_str()).or_default() += 1;
    }
    let min = (pages / 4).max(5);
    let running: Vec<bool> = shapes
        .iter()
        .map(|s| s.as_deref().is_some_and(|s| counts.get(s).copied().unwrap_or(0) >= min))
        .collect();
    if !running.contains(&true) {
        return text.to_string();
    }
    let blank: Vec<bool> = lines.iter().map(|l| l.trim().is_empty()).collect();
    // Whether the nearest non-blank line before / after each line is a running one.
    let mut running_before = vec![false; lines.len()];
    let mut last = false;
    for i in 0..lines.len() {
        running_before[i] = last;
        if !blank[i] {
            last = running[i];
        }
    }
    let mut running_after = vec![false; lines.len()];
    let mut next = false;
    for i in (0..lines.len()).rev() {
        running_after[i] = next;
        if !blank[i] {
            next = running[i];
        }
    }
    let at_page_edge = |i: usize| running_before[i] || running_after[i];
    // Running groups started before each line, to tell whether two lines share a page.
    let mut groups_before = vec![0usize; lines.len() + 1];
    for i in 0..lines.len() {
        let starts = running[i] && !running_before[i];
        groups_before[i + 1] = groups_before[i] + usize::from(starts);
    }
    let keys: Vec<String> = lines.iter().map(|l| outline_key(l)).collect();
    let mut next_same: Vec<Option<usize>> = vec![None; lines.len()];
    let mut seen: HashMap<&str, usize> = HashMap::new();
    for i in (0..lines.len()).rev() {
        if in_outline.get(&keys[i]) == Some(&1) {
            next_same[i] = seen.get(keys[i].as_str()).copied();
            seen.insert(keys[i].as_str(), i);
        }
    }
    let header_copy = |i: usize| -> bool {
        let Some(n) = next_same[i] else { return false };
        if running[i] || !at_page_edge(i) || at_page_edge(n) {
            return false;
        }
        // A copy above the header's running lines crosses them to reach its page.
        let allowed = usize::from(running_after[i]);
        groups_before[n] - groups_before[i + 1] <= allowed
    };
    lines
        .iter()
        .enumerate()
        .filter(|(i, _)| !running[*i] && !header_copy(*i))
        .map(|(_, l)| *l)
        .collect::<Vec<_>>()
        .join("\n")
}

/// Lines equal to an outline title (whitespace and case ignored) become
/// `#` headings of its level (1 = outermost). A title wrapped over two or
/// three lines (blank lines between them allowed) becomes one heading line.
fn mark_outline_lines(text: &str, outline: &[(usize, String)]) -> String {
    let mut levels: HashMap<String, usize> = HashMap::new();
    for (level, title) in outline {
        let k = outline_key(title);
        if !k.is_empty() {
            levels.entry(k).or_insert((*level).clamp(1, 6));
        }
    }
    if levels.is_empty() {
        return text.to_string();
    }
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let mut k = outline_key(line);
        if let Some(level) = levels.get(&k) {
            out.push(format!("{} {}", "#".repeat(*level), line.trim()));
            i += 1;
            continue;
        }
        // The start of a longer title: join the next non-blank lines while
        // they still spell one.
        let mut joined = None;
        if k.chars().count() >= 4 && levels.keys().any(|t| t.len() > k.len() && t.starts_with(&k)) {
            let mut parts = vec![line.trim()];
            let mut j = i + 1;
            while j < lines.len() && parts.len() < 3 {
                let next = lines[j].trim();
                j += 1;
                if next.is_empty() {
                    continue;
                }
                k.push_str(&outline_key(next));
                parts.push(next);
                if let Some(level) = levels.get(&k) {
                    joined = Some((format!("{} {}", "#".repeat(*level), parts.join(" ")), j));
                    break;
                }
                if !levels.keys().any(|t| t.starts_with(&k)) {
                    break;
                }
            }
        }
        match joined {
            Some((heading, next)) => {
                out.push(heading);
                i = next;
            }
            None => {
                out.push(line.to_string());
                i += 1;
            }
        }
    }
    out.join("\n")
}

/// Extract text from a DOCX (Office Open XML) file.
///
/// Opens the file as a ZIP archive, reads `word/document.xml`,
/// and extracts text content from `<w:t>` elements using simple
/// string parsing (no full XML parser dependency). Paragraphs in a heading
/// style (or with an outline level) become Markdown headings ("## 1.1 背景"),
/// which the heading-aware splitter reads.
pub fn extract_docx_text(file_path: &str) -> Result<String, String> {
    let file = std::fs::File::open(file_path)
        .map_err(|e| format!("Failed to open DOCX file '{}': {}", file_path, e))?;

    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Failed to read DOCX as ZIP archive: {}", e))?;

    let mut xml_content = String::new();
    {
        let mut document_xml = archive
            .by_name("word/document.xml")
            .map_err(|e| format!("DOCX missing word/document.xml: {}", e))?;

        std::io::Read::read_to_string(&mut document_xml, &mut xml_content)
            .map_err(|e| format!("Failed to read document.xml: {}", e))?;
    }
    let mut styles_xml = String::new();
    if let Ok(mut styles) = archive.by_name("word/styles.xml") {
        let _ = std::io::Read::read_to_string(&mut styles, &mut styles_xml);
    }

    Ok(parse_docx_xml_with_styles(&xml_content, &docx_heading_styles(&styles_xml)))
}

/// Heading level (1 = outermost) of each paragraph style in `styles.xml`:
/// styles named "heading N" / "标题 N", styles with an outline level, and
/// styles based on one of those.
fn docx_heading_styles(styles_xml: &str) -> HashMap<String, usize> {
    let mut own: HashMap<String, Option<usize>> = HashMap::new();
    let mut based_on: HashMap<String, String> = HashMap::new();
    for block in styles_xml.split("<w:style ").skip(1) {
        let block = block.split("</w:style>").next().unwrap_or(block);
        let Some(id) = attr(block, "w:styleId=\"") else { continue };
        let level = attr(block, "<w:outlineLvl w:val=\"")
            .and_then(|v| v.parse::<usize>().ok())
            .filter(|l| *l < 9)
            .map(|l| l + 1)
            .or_else(|| attr(block, "<w:name w:val=\"").and_then(heading_level_of_name));
        own.insert(id.to_string(), level);
        if let Some(parent) = attr(block, "<w:basedOn w:val=\"") {
            based_on.insert(id.to_string(), parent.to_string());
        }
    }
    let mut out = HashMap::new();
    for id in own.keys() {
        let mut current = id.as_str();
        for _ in 0..8 {
            if let Some(Some(level)) = own.get(current) {
                out.insert(id.clone(), *level);
                break;
            }
            match based_on.get(current) {
                Some(parent) => current = parent,
                None => break,
            }
        }
    }
    out
}

/// "heading 2" → 2, "标题 3" → 3.
fn heading_level_of_name(name: &str) -> Option<usize> {
    let lower = name.to_lowercase();
    let rest = lower.strip_prefix("heading").or_else(|| lower.strip_prefix("标题"))?;
    rest.trim().parse::<usize>().ok().filter(|l| (1..=9).contains(l))
}

/// The value after `prefix` up to the next `"`.
fn attr<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    let start = s.find(prefix)? + prefix.len();
    let len = s[start..].find('"')?;
    Some(&s[start..start + len])
}

/// Parse text content from DOCX XML by extracting `<w:t>` element text.
#[cfg(test)]
fn parse_docx_xml(xml: &str) -> String {
    parse_docx_xml_with_styles(xml, &HashMap::new())
}

/// Parse text content from DOCX XML by extracting `<w:t>` element text.
///
/// Uses simple string splitting rather than a full XML parser:
/// 1. Split on '<' to get tag fragments
/// 2. Look for fragments starting with "w:t>" or "w:t " (the w:t element)
/// 3. Extract the text content after the '>'
/// 4. Track `<w:p>` (paragraph) boundaries to insert newlines
/// 5. Prefix paragraphs in a heading style (`heading_styles`) or with an
///    outline level with Markdown `#` markers
fn parse_docx_xml_with_styles(xml: &str, heading_styles: &HashMap<String, usize>) -> String {
    let mut result = String::new();
    let mut paragraph = String::new();
    let mut level: Option<usize> = None;
    let flush = |result: &mut String, paragraph: &mut String, level: Option<usize>| {
        let text = std::mem::take(paragraph);
        match level {
            Some(level) if !text.trim().is_empty() => {
                if !result.is_empty() && !result.ends_with('\n') {
                    result.push('\n');
                }
                result.push_str(&"#".repeat(level.min(6)));
                result.push(' ');
                result.push_str(text.trim());
            }
            _ => result.push_str(&text),
        }
        if !result.is_empty() && !result.ends_with('\n') {
            result.push('\n');
        }
    };

    // Split on '<' to get tag-like fragments
    for fragment in xml.split('<') {
        if fragment.is_empty() {
            continue;
        }

        // Paragraph start ("w:p " or "w:p>") or end ("/w:p>")
        if fragment.starts_with("w:p>") || fragment.starts_with("w:p ") || fragment.starts_with("/w:p>") {
            flush(&mut result, &mut paragraph, level);
            level = None;
            continue;
        }

        if fragment.starts_with("w:pStyle ") {
            if let Some(style) = attr(fragment, "w:val=\"") {
                level = heading_styles.get(style).copied().or(level);
            }
            continue;
        }
        if fragment.starts_with("w:outlineLvl ") {
            if let Some(l) = attr(fragment, "w:val=\"").and_then(|v| v.parse::<usize>().ok()) {
                level = (l < 9).then_some(l + 1);
            }
            continue;
        }

        // Check for text element: "w:t>" or "w:t " (with attributes like xml:space)
        if fragment.starts_with("w:t>") || fragment.starts_with("w:t ") {
            // Extract text after the closing '>'
            if let Some(pos) = fragment.find('>') {
                paragraph.push_str(&fragment[pos + 1..]);
            }
        }
    }
    flush(&mut result, &mut paragraph, level);

    let trimmed = result.trim().to_string();

    // Clean up excessive blank lines (collapse multiple newlines to double)
    let mut cleaned = String::with_capacity(trimmed.len());
    let mut prev_newline_count = 0;
    for ch in trimmed.chars() {
        if ch == '\n' {
            prev_newline_count += 1;
            if prev_newline_count <= 2 {
                cleaned.push(ch);
            }
        } else {
            prev_newline_count = 0;
            cleaned.push(ch);
        }
    }

    cleaned
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_docx_xml_simple() {
        let xml = r#"<w:body><w:p><w:r><w:t>Hello World</w:t></w:r></w:p></w:body>"#;
        let text = parse_docx_xml(xml);
        assert!(text.contains("Hello World"));
    }

    #[test]
    fn test_parse_docx_xml_multiple_paragraphs() {
        let xml = r#"<w:body><w:p><w:r><w:t>First</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p></w:body>"#;
        let text = parse_docx_xml(xml);
        assert!(text.contains("First"));
        assert!(text.contains("Second"));
        // Paragraphs should be separated by newlines
        assert!(text.contains('\n'));
    }

    #[test]
    fn test_parse_docx_xml_with_attributes() {
        let xml = r#"<w:p><w:r><w:t xml:space="preserve"> spaced text </w:t></w:r></w:p>"#;
        let text = parse_docx_xml(xml);
        assert!(text.contains("spaced text"));
    }

    #[test]
    fn test_parse_docx_xml_empty() {
        let text = parse_docx_xml("");
        assert!(text.is_empty());
    }

    #[test]
    fn test_extract_docx_text_from_a_deflated_archive() {
        use std::io::Write;
        let path = std::env::temp_dir().join(format!("nexq-docx-{}.docx", std::process::id()));
        {
            let mut zip = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            zip.start_file("word/document.xml", options).unwrap();
            zip.write_all(br#"<w:body><w:p><w:r><w:t>Quarterly plan</w:t></w:r></w:p></w:body>"#).unwrap();
            zip.finish().unwrap();
        }
        let text = extract_docx_text(path.to_str().unwrap());
        let _ = std::fs::remove_file(&path);
        assert!(text.unwrap().contains("Quarterly plan"));
    }

    #[test]
    fn docx_heading_styles_become_markdown_headings() {
        // Chinese Word: style ids "1", "2"; a template style based on one; an
        // outline level set on the paragraph itself.
        let styles = r#"<w:styles>
            <w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>
            <w:style w:type="paragraph" w:styleId="2"><w:name w:val="heading 2"/></w:style>
            <w:style w:type="paragraph" w:styleId="ThesisL3"><w:name w:val="论文三级标题"/><w:basedOn w:val="Wps3"/></w:style>
            <w:style w:type="paragraph" w:styleId="Wps3"><w:name w:val="标题 3"/></w:style>
            <w:style w:type="paragraph" w:styleId="a"><w:name w:val="Normal"/></w:style>
        </w:styles>"#;
        let map = docx_heading_styles(styles);
        assert_eq!(map.get("1"), Some(&1));
        assert_eq!(map.get("2"), Some(&2));
        assert_eq!(map.get("ThesisL3"), Some(&3));
        assert_eq!(map.get("a"), None);

        let xml = r#"<w:body>
            <w:p><w:pPr><w:pStyle w:val="1"/></w:pPr><w:r><w:t>绪论</w:t></w:r></w:p>
            <w:p><w:pPr><w:pStyle w:val="a"/></w:pPr><w:r><w:t>正文第一段。</w:t></w:r></w:p>
            <w:p><w:pPr><w:pStyle w:val="2"/></w:pPr><w:r><w:t>研究</w:t></w:r><w:r><w:t>背景</w:t></w:r></w:p>
            <w:p><w:pPr><w:pStyle w:val="ThesisL3"/></w:pPr><w:r><w:t>国内现状</w:t></w:r></w:p>
            <w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>参考文献</w:t></w:r></w:p>
            <w:p><w:pPr><w:pStyle w:val="1"/></w:pPr></w:p>
            <w:p><w:r><w:t>[1] 文献。</w:t></w:r></w:p>
        </w:body>"#;
        assert_eq!(
            parse_docx_xml_with_styles(xml, &map),
            "# 绪论\n正文第一段。\n## 研究背景\n### 国内现状\n# 参考文献\n[1] 文献。"
        );
    }

    #[test]
    fn pdf_outline_titles_mark_matching_lines() {
        let text = "目 录\n第一章 绪论 ........ 1\n第一章  绪论\n正文。\n1.1 背景\n背景正文。";
        let outline = vec![(1, "第一章 绪论".to_string()), (2, "1.1 背景".to_string())];
        assert_eq!(
            mark_outline_lines(text, &outline),
            "目 录\n第一章 绪论 ........ 1\n# 第一章  绪论\n正文。\n## 1.1 背景\n背景正文。"
        );
        assert_eq!(mark_outline_lines(text, &[]), text);
        // A file lopdf can't read leaves the text alone.
        assert_eq!(mark_pdf_outline("/nonexistent.pdf", "x\ny"), "x\ny");
    }

    #[test]
    fn wrapped_outline_titles_become_one_heading() {
        let outline = vec![
            (1, "Appendix F: Complete system and component diagrams".to_string()),
            (1, "Appendix G: UPRN-grouped re-split (leakage-free generalisation check)".to_string()),
        ];
        let text = "Figure F.1\nAppendix F: Complete system and component \n\ndiagrams\nBody F.\nAppendix G: UPRN-grouped re-split (leakage-free\n\ngeneralisation check)\nBody G.\nAppendix H: not in the outline\nmore";
        assert_eq!(
            mark_outline_lines(text, &outline),
            "Figure F.1\n# Appendix F: Complete system and component diagrams\nBody F.\n# Appendix G: UPRN-grouped re-split (leakage-free generalisation check)\nBody G.\nAppendix H: not in the outline\nmore"
        );
        // A line that only starts like a title stays as it is.
        let text = "Appendix F: Complete system\nand something else";
        assert_eq!(mark_outline_lines(text, &outline), text);
    }

    #[test]
    fn running_headers_and_footers_are_cut_out() {
        let mut text = String::new();
        let bodies = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"];
        for (page, body) in bodies.iter().enumerate() {
            text.push_str(&format!("Thesis Title: A Framework\nPage {} of 73\nChapter 1: Introduction\n", page + 1));
            text.push_str(&format!("The {body} paragraph.\n0.900 0.896\n"));
        }
        let outline = vec![(1, "Chapter 1: Introduction".to_string())];
        let out = strip_running_lines(&text, 8, &outline);
        assert!(!out.contains("Thesis Title") && !out.contains("Page 3 of 73"));
        // Outline titles (here the header's copies of an open chapter, left
        // to the heading splitter), number rows and the body stay.
        assert_eq!(out.matches("Chapter 1: Introduction").count(), 8);
        assert_eq!(out.matches("0.900 0.896").count(), 8);
        assert!(out.contains("The alpha paragraph.") && out.contains("The theta paragraph."));
        // A section title printed in the header (Word shows the page's first
        // heading there) goes when the real heading follows; the last copy
        // and a real heading at the top of a page stay.
        let text = "Title Line\nPage 1 of 9\n\n5.6 OOD detection\nend of 5.5.\n5.6 OOD detection\nbody of 5.6.\n\
                    Title Line\nPage 2 of 9\n5.6 OOD detection\nmore 5.6.\nTitle Line\nPage 3 of 9\n5.7 Triage\nbody of 5.7.\n\
                    Title Line\nPage 4 of 9\nTitle Line\nPage 5 of 9\nTitle Line\nPage 6 of 9";
        let outline = vec![(2, "5.6 OOD detection".to_string()), (2, "5.7 Triage".to_string())];
        assert_eq!(
            strip_running_lines(text, 8, &outline),
            "\nend of 5.5.\n5.6 OOD detection\nbody of 5.6.\n5.6 OOD detection\nmore 5.6.\n5.7 Triage\nbody of 5.7."
        );
        // The same with the copy above the running lines (pdf_extract's
        // order), and a chapter starting at the top of a page keeps its heading.
        let text = "end of 4.3 (assessor\n\n4.4 Stack\n\nTitle Line\nPage 19 of 73\n\nlanguage is templated.\n4.4 Stack\nThe stack.\n\
                    4.4 Stack\nTitle Line\nPage 20 of 73\nmore 4.4.\nChapter 5 Results\nTitle Line\nPage 21 of 73\nChapter 5 Results\nbody 5.\n\
                    Chapter 5 Results\nTitle Line\nPage 22 of 73\nmore 5.\nTitle Line\nPage 23 of 73";
        let outline = vec![(2, "4.4 Stack".to_string()), (1, "Chapter 5 Results".to_string())];
        assert_eq!(
            strip_running_lines(text, 8, &outline),
            "end of 4.3 (assessor\n\n\n\nlanguage is templated.\n4.4 Stack\nThe stack.\n4.4 Stack\nmore 4.4.\n\
             Chapter 5 Results\nChapter 5 Results\nbody 5.\nChapter 5 Results\nmore 5."
        );
        // A title the outline has twice is a real heading every time.
        let text = "Title Line\nPage 1 of 9\n本章小结\n第一章小结。\nTitle Line\nPage 2 of 9\n本章小结\n第二章小结。\n\
                    Title Line\nPage 3 of 9\nTitle Line\nPage 4 of 9\nTitle Line\nPage 5 of 9";
        let outline = vec![(2, "本章小结".to_string()), (2, "本章小结".to_string())];
        assert_eq!(strip_running_lines(text, 8, &outline), "本章小结\n第一章小结。\n本章小结\n第二章小结。");
        // Too few pages, or nothing repeated often enough: unchanged.
        assert_eq!(strip_running_lines(&text, 3, &outline), text);
        assert_eq!(strip_running_lines("a line\nanother", 40, &[]), "a line\nanother");
    }

    #[test]
    fn test_extract_text_unsupported() {
        let result = extract_text("test.xyz", "xyz");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unsupported"));
    }
}
