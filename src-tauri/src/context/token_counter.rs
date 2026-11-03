use serde::Serialize;

/// Approximate token count, the same estimate the knowledge base chunks
/// with: a CJK character counts 1, every 4 other characters count 1.
/// (Plain chars / 4 put Chinese at a quarter of a token per character.)
pub fn count_tokens(text: &str) -> usize {
    crate::rag::cjk::estimate_tokens(text)
}

/// A single segment in the token budget breakdown.
#[derive(Debug, Clone, Serialize)]
pub struct TokenBudgetSegment {
    pub label: String,
    pub tokens: usize,
    pub color: String,
    pub category: String,
}

/// The full token budget breakdown.
#[derive(Debug, Clone, Serialize)]
pub struct TokenBudget {
    pub total: usize,
    /// The model's context length; 0 when it isn't known.
    pub limit: u64,
    pub segments: Vec<TokenBudgetSegment>,
    /// Files in the knowledge base index, which a request gets passages of
    /// instead of their whole text, and their whole size.
    pub library_files: usize,
    pub library_tokens: usize,
    /// The model the context goes to and its connection's name.
    pub model: Option<String>,
    pub connection: Option<String>,
}

/// Categorize a resource by its name/type for color assignment.
fn categorize_resource(name: &str, file_type: &str) -> (&'static str, &'static str, &'static str) {
    let name_lower = name.to_lowercase();

    if name_lower.contains("resume") || name_lower.contains("cv") {
        ("Resume", "#3b82f6", "resume")
    } else if name_lower.contains("jd")
        || name_lower.contains("job")
        || name_lower.contains("description")
        || name_lower.contains("posting")
    {
        ("JD", "#22c55e", "jd")
    } else {
        // Default to "Notes" category
        match file_type {
            "pdf" => ("Notes (PDF)", "#a855f7", "notes"),
            "md" => ("Notes (MD)", "#a855f7", "notes"),
            _ => ("Notes", "#a855f7", "notes"),
        }
    }
}

/// Represents a resource passed into budget computation.
pub struct BudgetResource {
    pub name: String,
    pub file_type: String,
    pub token_count: usize,
    /// In the knowledge base index.
    pub indexed: bool,
}

/// Compute the token budget breakdown.
///
/// - `resources`: the loaded context resources
/// - `custom_instructions`: the user's custom instructions text
/// - `transcript_tokens`: estimated tokens used by the current transcript
/// - `model_limit`: the model's context window size in tokens (0: unknown)
/// - `retrieved_tokens`: the most document text one search brings back; 0
///   when the documents are sent whole, indexed or not
pub fn compute_budget(
    resources: &[BudgetResource],
    custom_instructions: &str,
    transcript_tokens: usize,
    model_limit: u64,
    retrieved_tokens: usize,
) -> TokenBudget {
    let mut segments = Vec::new();
    let mut total: usize = 0;
    let (mut library_files, mut library_tokens) = (0usize, 0usize);

    // Add resource segments
    for res in resources {
        if res.indexed && retrieved_tokens > 0 {
            library_files += 1;
            library_tokens += res.token_count;
            continue;
        }
        let (label, color, category) = categorize_resource(&res.name, &res.file_type);
        segments.push(TokenBudgetSegment {
            label: label.to_string(),
            tokens: res.token_count,
            color: color.to_string(),
            category: category.to_string(),
        });
        total += res.token_count;
    }

    // Indexed files: only the passages a search finds go out
    if library_files > 0 {
        let tokens = retrieved_tokens.min(library_tokens);
        segments.push(TokenBudgetSegment {
            label: "Knowledge base".to_string(),
            tokens,
            color: "#14b8a6".to_string(),
            category: "knowledge".to_string(),
        });
        total += tokens;
    }

    // Custom instructions segment
    let instructions_tokens = count_tokens(custom_instructions);
    if instructions_tokens > 0 {
        segments.push(TokenBudgetSegment {
            label: "Custom Instructions".to_string(),
            tokens: instructions_tokens,
            color: "#6b7280".to_string(),
            category: "system".to_string(),
        });
        total += instructions_tokens;
    }

    // System prompt overhead (estimated)
    let system_prompt_tokens: usize = 200;
    segments.push(TokenBudgetSegment {
        label: "System Prompt".to_string(),
        tokens: system_prompt_tokens,
        color: "#6b7280".to_string(),
        category: "system".to_string(),
    });
    total += system_prompt_tokens;

    // Transcript segment
    if transcript_tokens > 0 {
        segments.push(TokenBudgetSegment {
            label: "Transcript".to_string(),
            tokens: transcript_tokens,
            color: "#f97316".to_string(),
            category: "transcript".to_string(),
        });
        total += transcript_tokens;
    }

    // Remaining headroom
    let limit = model_limit;
    if (limit as usize) > total {
        let headroom = (limit as usize) - total;
        segments.push(TokenBudgetSegment {
            label: "Available".to_string(),
            tokens: headroom,
            color: "#1f2937".to_string(),
            category: "headroom".to_string(),
        });
    }

    TokenBudget {
        total,
        limit,
        segments,
        library_files,
        library_tokens,
        model: None,
        connection: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_count_tokens_empty() {
        assert_eq!(count_tokens(""), 0);
    }

    #[test]
    fn test_count_tokens_basic() {
        // "hello" = 5 chars => (5+3)/4 = 2 tokens
        assert_eq!(count_tokens("hello"), 2);
    }

    #[test]
    fn test_count_tokens_longer() {
        // 100 chars => 25 tokens
        let text = "a".repeat(100);
        assert_eq!(count_tokens(&text), 25);
    }

    #[test]
    fn test_count_tokens_counts_chinese_per_character() {
        assert_eq!(count_tokens("上下文长度"), 5);
        // 4 CJK characters + "abc, " (5 others => 2)
        assert_eq!(count_tokens("abc, 你好世界"), 6);
    }

    fn resource(name: &str, token_count: usize, indexed: bool) -> BudgetResource {
        BudgetResource { name: name.to_string(), file_type: "md".to_string(), token_count, indexed }
    }

    #[test]
    fn indexed_files_count_as_one_search_not_their_whole_text() {
        let resources = [resource("thesis.md", 900_000, true), resource("v7.md", 700_000, true), resource("notes.md", 3_000, false)];
        let budget = compute_budget(&resources, "", 0, 1_000_000, 16_000);
        assert_eq!((budget.library_files, budget.library_tokens), (2, 1_600_000));
        // 3k unindexed notes + 16k retrieved + 200 system prompt
        assert_eq!(budget.total, 19_200);
        let knowledge: Vec<_> = budget.segments.iter().filter(|s| s.category == "knowledge").collect();
        assert_eq!((knowledge.len(), knowledge[0].tokens), (1, 16_000));
    }

    #[test]
    fn documents_sent_whole_count_in_full_even_when_indexed() {
        let budget = compute_budget(&[resource("cv.md", 5_000, true)], "", 0, 128_000, 0);
        assert_eq!((budget.library_files, budget.total), (0, 5_200));
    }

    #[test]
    fn a_small_library_counts_its_own_size() {
        let budget = compute_budget(&[resource("faq.md", 1_200, true)], "", 0, 128_000, 16_000);
        assert_eq!(budget.total, 1_400);
    }
}
