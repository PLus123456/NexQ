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

/// Marks the lines of a PDF's extracted `text` that read like one of its
/// outline (bookmark) titles as Markdown headings at the outline's level.
/// A PDF without an outline, or one lopdf can't read, gives `text` back.
pub fn mark_pdf_outline(file_path: &str, text: &str) -> String {
    let outline = match lopdf::Document::load(file_path).and_then(|doc| doc.get_toc()) {
        Ok(toc) => toc.toc.into_iter().map(|t| (t.level, t.title)).collect::<Vec<_>>(),
        Err(_) => return text.to_string(),
    };
    mark_outline_lines(text, &outline)
}

/// Lines equal to an outline title (whitespace and case ignored) become
/// `#` headings of its level (1 = outermost).
fn mark_outline_lines(text: &str, outline: &[(usize, String)]) -> String {
    let key = |s: &str| s.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_lowercase();
    let mut levels: HashMap<String, usize> = HashMap::new();
    for (level, title) in outline {
        let k = key(title);
        if !k.is_empty() {
            levels.entry(k).or_insert((*level).clamp(1, 6));
        }
    }
    if levels.is_empty() {
        return text.to_string();
    }
    text.split('\n')
        .map(|line| match levels.get(&key(line)) {
            Some(level) => format!("{} {}", "#".repeat(*level), line.trim()),
            None => line.to_string(),
        })
        .collect::<Vec<_>>()
        .join("\n")
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
    fn test_extract_text_unsupported() {
        let result = extract_text("test.xyz", "xyz");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unsupported"));
    }
}
