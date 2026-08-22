//! Agent instruction and user-prompt composition.
//!
//! A preconfigured agent carries operator instructions that must reach the
//! provider through a privileged system/developer channel. They must never be
//! rendered into user-authored prompt text.

/// Render the privileged instructions for a preconfigured agent.
pub fn agent_instructions(name: &str, instructions: &str) -> String {
    let trimmed = instructions.trim();
    let instructions_section = if trimmed.is_empty() {
        String::new()
    } else {
        format!("\n\nYour operator-provided instructions, which apply to every reply:\n{trimmed}")
    };
    format!(
        "You are \"{name}\", a preconfigured agent persona in this workspace.\n\
         Respond in character as {name}.{instructions_section}"
    )
}

/// Compose the user-message content for one agent turn.
///
/// `context_seed` is the rendered parent-thread transcript a side thread was
/// created with, `handoff` is the side thread's own transcript replay when the
/// provider session was reset (agent switch), and `prompt` is what the user
/// actually typed. Context may be absent; the user prompt always comes last.
pub fn compose_agent_user_prompt(
    context_seed: Option<&str>,
    handoff: Option<&str>,
    prompt: &str,
) -> String {
    let mut parts: Vec<&str> = Vec::new();
    if let Some(seed) = context_seed.filter(|s| !s.is_empty()) {
        parts.push(seed);
    }
    if let Some(handoff) = handoff.filter(|h| !h.is_empty()) {
        parts.push(handoff);
    }
    parts.push(prompt);
    parts.join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn privileged_instructions_carry_name_and_operator_instructions() {
        let instructions = agent_instructions("Charlie", "Review code. Be terse.");
        assert!(instructions.contains("You are \"Charlie\""));
        assert!(instructions.contains("Review code. Be terse."));
        assert!(!instructions.contains("<maxx-agent>"));
    }

    #[test]
    fn empty_instructions_still_name_the_persona() {
        let instructions = agent_instructions("Dana", "   ");
        assert!(instructions.contains("You are \"Dana\""));
        assert!(!instructions.contains("operator-provided instructions"));
    }

    #[test]
    fn compose_orders_seed_handoff_prompt() {
        let composed = compose_agent_user_prompt(Some("SEED"), Some("HANDOFF"), "the question");
        assert_eq!(composed, "SEED\n\nHANDOFF\n\nthe question");
    }

    #[test]
    fn compose_skips_absent_parts() {
        assert_eq!(compose_agent_user_prompt(None, None, "hi"), "hi");
        assert_eq!(
            compose_agent_user_prompt(Some("SEED"), None, "hi"),
            "SEED\n\nhi"
        );
    }
}
