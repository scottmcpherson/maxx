use crate::engine::TurnRequest;
use crate::events::emit;
use crate::state::{find_thread, AppState};
use maxx_core::contract::{AppleDate, ChatProvider};
use maxx_core::persist::{ChatImageAttachment, ProviderProfile, TitleGenerationRuntime};
use serde::Serialize;
use std::sync::Arc;
use uuid::Uuid;

const MAX_TITLE_CHARS: usize = 40;
const MAX_PROMPT_CHARS: usize = 8_000;

#[derive(Clone)]
pub struct TitleGenerationCandidate {
    provider_instance_id: Uuid,
    provider: ChatProvider,
    model: String,
    effort: Option<String>,
    speed: Option<String>,
    profile: ProviderProfile,
}

impl TitleGenerationCandidate {
    fn from_chat(request: &TurnRequest) -> Self {
        Self {
            provider_instance_id: request.provider_instance_id,
            provider: request.provider,
            model: request.model.clone(),
            effort: request.effort.clone(),
            speed: request.speed.clone(),
            profile: request.profile.clone(),
        }
    }

    fn same_runtime(&self, other: &Self) -> bool {
        self.provider_instance_id == other.provider_instance_id
            && self.provider == other.provider
            && self.model == other.model
            && self.effort == other.effort
            && self.speed == other.speed
    }

    pub(crate) fn request(
        &self,
        prompt: String,
        attachments: Vec<ChatImageAttachment>,
        working_directory: String,
    ) -> TurnRequest {
        TurnRequest {
            turn_id: Uuid::new_v4(),
            thread_id: Uuid::new_v4(),
            provider_instance_id: self.provider_instance_id,
            provider: self.provider,
            model: self.model.clone(),
            effort: self.effort.clone(),
            speed: self.speed.clone(),
            agent_instructions: None,
            prompt,
            attachments,
            working_directory,
            session_id: None,
            profile: self.profile.clone(),
            agent_id: None,
            browser_access: None,
        }
    }
}

pub struct TitleGenerationJob {
    pub expected_title: String,
    pub message: String,
    pub attachments: Vec<ChatImageAttachment>,
    pub candidates: Vec<TitleGenerationCandidate>,
}

#[derive(Clone, Serialize)]
pub struct ThreadTitleUpdatedEnvelope {
    #[serde(rename = "projectID")]
    project_id: Uuid,
    #[serde(rename = "threadID")]
    thread_id: Uuid,
    title: String,
}

/// Resolve the configured global runtime first and the chat runtime second.
/// The actual invocation remains authoritative: an installed harness can still
/// reject a removed model or fail authentication after catalog discovery.
pub fn title_generation_candidates(
    configured: Option<&TitleGenerationRuntime>,
    chat_request: &TurnRequest,
    profiles: &[ProviderProfile],
) -> Vec<TitleGenerationCandidate> {
    let mut candidates = Vec::new();
    if let Some(configured) = configured {
        if let Some(profile) = profiles
            .iter()
            .find(|profile| profile.provider == configured.provider && profile.is_enabled)
        {
            candidates.push(TitleGenerationCandidate {
                provider_instance_id: profile.id,
                provider: configured.provider,
                model: nonempty(&configured.model).unwrap_or_else(|| "Default".into()),
                effort: configured.effort.as_deref().and_then(nonempty),
                speed: configured.speed.as_deref().and_then(nonempty),
                profile: profile.clone(),
            });
        }
    }

    let chat = TitleGenerationCandidate::from_chat(chat_request);
    if !candidates
        .iter()
        .any(|candidate| candidate.same_runtime(&chat))
    {
        candidates.push(chat);
    }
    candidates
}

fn nonempty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn limited(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

pub fn title_prompt(message: &str, attachments: &[ChatImageAttachment]) -> String {
    let attachment_names = attachments
        .iter()
        .map(|attachment| attachment.display_name.trim())
        .filter(|name| !name.is_empty())
        .collect::<Vec<_>>();
    let attachment_context = if attachment_names.is_empty() {
        String::new()
    } else {
        format!("\nAttachments: {}", attachment_names.join(", "))
    };
    format!(
        "Generate a short sidebar title for this chat.\n\
         Return only the title, with no JSON, quotes, label, or punctuation.\n\
         Use 3-8 words and fewer than 40 characters.\n\
         Capture the durable subject and desired outcome, not instructions about tools, agents, plans, reports, or output format.\n\
         Do not use tools or inspect the working directory.\n\n\
         User message:\n{}{}",
        limited(message.trim(), MAX_PROMPT_CHARS),
        attachment_context,
    )
}

pub fn sanitize_title(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let unfenced = if trimmed.starts_with("```") {
        trimmed
            .lines()
            .skip(1)
            .take_while(|line| !line.trim().starts_with("```"))
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        trimmed.to_string()
    };
    let candidate = unfenced.trim();
    let structured = serde_json::from_str::<serde_json::Value>(candidate)
        .ok()
        .and_then(|value| value.get("title")?.as_str().map(str::to_string));
    let candidate = structured.as_deref().unwrap_or(candidate);
    let line = candidate
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?
        .trim_matches('`')
        .trim();
    let line = line
        .strip_prefix("Title:")
        .or_else(|| line.strip_prefix("title:"))
        .unwrap_or(line)
        .trim()
        .trim_matches(|character| matches!(character, '\'' | '"' | '`'))
        .trim()
        .trim_end_matches(['.', ':', ';', '!', '?'])
        .trim();
    let normalized = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return None;
    }
    if normalized.chars().count() <= MAX_TITLE_CHARS {
        return Some(normalized);
    }
    let prefix = normalized
        .chars()
        .take(MAX_TITLE_CHARS - 1)
        .collect::<String>()
        .trim_end()
        .to_string();
    Some(format!("{prefix}…"))
}

impl AppState {
    pub async fn run_title_generation(
        self: Arc<Self>,
        project_id: Uuid,
        thread_id: Uuid,
        job: TitleGenerationJob,
    ) {
        let prompt = title_prompt(&job.message, &job.attachments);
        // Keep background naming isolated from repository instructions and
        // files. The title request has all of its context in the prompt.
        let working_directory = std::env::temp_dir().to_string_lossy().into_owned();
        let mut generated = None;
        for candidate in job.candidates {
            let provider = candidate.provider;
            let model = candidate.model.clone();
            let request = candidate.request(prompt.clone(), Vec::new(), working_directory.clone());
            match self.runtime.generate_text(request).await {
                Ok(raw) => match sanitize_title(&raw) {
                    Some(title) => {
                        generated = Some(title);
                        break;
                    }
                    None => log::warn!(
                        "title generation returned an empty title with {} ({model})",
                        provider.display_name()
                    ),
                },
                Err(error) => log::warn!(
                    "title generation failed with {} ({model}); trying chat runtime if available: {error}",
                    provider.display_name()
                ),
            }
        }
        let Some(title) = generated else {
            return;
        };

        {
            let mut workspace = self.workspace.lock().await;
            let Some(thread) = find_thread(&mut workspace, project_id, thread_id) else {
                return;
            };
            if thread.title != job.expected_title {
                return;
            }
            thread.title = title.clone();
            thread.updated_at = AppleDate::now();
        }
        self.save().await;
        emit(
            self.events.as_ref(),
            "thread://title-updated",
            &ThreadTitleUpdatedEnvelope {
                project_id,
                thread_id,
                title,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_plain_quoted_and_structured_titles() {
        assert_eq!(
            sanitize_title("  Title: Add generated chat titles.\nignored"),
            Some("Add generated chat titles".into())
        );
        assert_eq!(
            sanitize_title(r#"{"title":"Choose a title harness"}"#),
            Some("Choose a title harness".into())
        );
        assert_eq!(
            sanitize_title("```json\n{\"title\":\"Generated Sidebar Titles\"}\n```").as_deref(),
            Some("Generated Sidebar Titles")
        );
        assert_eq!(
            sanitize_title("`Improve title generation fallback behavior everywhere`")
                .expect("title")
                .chars()
                .count(),
            MAX_TITLE_CHARS
        );
    }

    #[test]
    fn deduplicates_a_configured_runtime_that_matches_the_chat() {
        let profile = ProviderProfile::default_for(ChatProvider::Codex);
        let request = crate::engine::test_request(ChatProvider::Codex);
        let configured = TitleGenerationRuntime {
            provider: ChatProvider::Codex,
            model: request.model.clone(),
            effort: None,
            speed: None,
        };
        assert_eq!(
            title_generation_candidates(Some(&configured), &request, &[profile]).len(),
            1
        );
    }

    #[test]
    fn falls_back_to_chat_when_the_configured_harness_is_disabled() {
        let mut configured_profile = ProviderProfile::default_for(ChatProvider::Claude);
        configured_profile.is_enabled = false;
        let request = crate::engine::test_request(ChatProvider::Codex);
        let configured = TitleGenerationRuntime {
            provider: ChatProvider::Claude,
            model: "sonnet".into(),
            effort: None,
            speed: None,
        };
        let candidates =
            title_generation_candidates(Some(&configured), &request, &[configured_profile]);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].provider, ChatProvider::Codex);
    }

    #[test]
    fn tries_a_distinct_configured_runtime_before_the_chat_runtime() {
        let configured_profile = ProviderProfile::default_for(ChatProvider::Claude);
        let request = crate::engine::test_request(ChatProvider::Codex);
        let configured = TitleGenerationRuntime {
            provider: ChatProvider::Claude,
            model: "sonnet".into(),
            effort: Some("low".into()),
            speed: None,
        };

        let candidates =
            title_generation_candidates(Some(&configured), &request, &[configured_profile]);

        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].provider, ChatProvider::Claude);
        assert_eq!(candidates[0].model, "sonnet");
        assert_eq!(candidates[1].provider, ChatProvider::Codex);
    }
}
