use super::search::ScoredChunk;

/// Build the RAG context string to prepend to an LLM prompt.
///
/// Assembles custom instructions (if any) and retrieved chunks into a
/// structured context block suitable for injection into a system prompt.
///
/// - `chunks`: scored and ranked chunks from the search pipeline
/// - `custom_instructions`: user-provided custom instructions text
///
/// Returns the assembled context string.
pub fn build_rag_context(chunks: &[ScoredChunk], custom_instructions: &str) -> String {
    let mut parts: Vec<String> = Vec::new();

    // Custom instructions section
    if !custom_instructions.is_empty() {
        parts.push(format!("## Custom Instructions\n{}\n", custom_instructions));
    }

    // RAG context section
    if !chunks.is_empty() {
        parts.push("## Relevant Context (Retrieved via RAG)".to_string());

        for (i, chunk) in chunks.iter().enumerate() {
            let source_label = build_source_label(chunk);
            parts.push(format!(
                "[Source {}: {}]\n{}\n---",
                i + 1,
                source_label,
                chunk.text
            ));
        }
    }

    parts.join("\n")
}

/// Build a human-readable source label for a chunk.
///
/// - For transcript chunks: "Live Transcript, segment N"
/// - For file chunks: "filename › heading path, chunk N" (or "chunks N–M"
///   for an expanded passage, "chapter summary" for a summary)
fn build_source_label(chunk: &ScoredChunk) -> String {
    if chunk.source_type == "transcript" {
        return format!("Live Transcript, segment {}", chunk.chunk_index);
    }
    let mut label = chunk.source_file.clone();
    if let Some(heading) = chunk.heading.as_deref().filter(|h| !h.is_empty()) {
        label.push_str(" › ");
        label.push_str(heading);
    }
    match (chunk.source_type.as_str(), chunk.chunk_range) {
        ("summary", _) => label.push_str(", chapter summary"),
        (_, Some((first, last))) => label.push_str(&format!(", chunks {first}–{last}")),
        _ => label.push_str(&format!(", chunk {}", chunk.chunk_index)),
    }
    label
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_chunk(
        source_type: &str,
        source_file: &str,
        chunk_index: usize,
        text: &str,
    ) -> ScoredChunk {
        ScoredChunk {
            chunk_id: format!("chunk_{}", chunk_index),
            text: text.to_string(),
            score: 0.9,
            normalized_score: 0.9,
            source_file: source_file.to_string(),
            chunk_index,
            source_type: source_type.to_string(),
            fused_rank: None,
            fused_score: None,
            heading: None,
            chunk_range: None,
        }
    }

    #[test]
    fn test_empty_chunks_no_instructions() {
        let result = build_rag_context(&[], "");
        assert!(result.is_empty());
    }

    #[test]
    fn test_custom_instructions_only() {
        let result = build_rag_context(&[], "Be concise.");
        assert!(result.contains("## Custom Instructions"));
        assert!(result.contains("Be concise."));
    }

    #[test]
    fn test_file_source_label() {
        let chunks = vec![make_chunk("file", "resume.pdf", 0, "Experience section")];
        let result = build_rag_context(&chunks, "");
        assert!(result.contains("[Source 1: resume.pdf, chunk 0]"));
        assert!(result.contains("Experience section"));
    }

    #[test]
    fn headings_ranges_and_summaries_are_named_in_the_label() {
        let mut passage = make_chunk("file", "thesis.pdf", 12, "Expanded text");
        passage.heading = Some("第三章 研究方法 › 3.2 数据来源".into());
        passage.chunk_range = Some((11, 14));
        let mut summary = make_chunk("summary", "thesis.pdf", 2, "Chapter summary text");
        summary.heading = Some("第三章 研究方法".into());
        let result = build_rag_context(&[passage, summary], "");
        assert!(result.contains("[Source 1: thesis.pdf › 第三章 研究方法 › 3.2 数据来源, chunks 11–14]"), "{result}");
        assert!(result.contains("[Source 2: thesis.pdf › 第三章 研究方法, chapter summary]"), "{result}");
    }

    #[test]
    fn test_transcript_source_label() {
        let chunks = vec![make_chunk("transcript", "transcript_abc", 3, "They asked about...")];
        let result = build_rag_context(&chunks, "");
        assert!(result.contains("[Source 1: Live Transcript, segment 3]"));
    }

    #[test]
    fn test_multiple_chunks_with_instructions() {
        let chunks = vec![
            make_chunk("file", "notes.md", 0, "First chunk"),
            make_chunk("transcript", "t_123", 5, "Second chunk"),
        ];
        let result = build_rag_context(&chunks, "Focus on technical details.");
        assert!(result.contains("## Custom Instructions"));
        assert!(result.contains("Focus on technical details."));
        assert!(result.contains("[Source 1: notes.md, chunk 0]"));
        assert!(result.contains("[Source 2: Live Transcript, segment 5]"));
        assert!(result.contains("---"));
    }
}
