//! maxx-core: pure domain logic for the Maxx Tauri port.
//!
//! Everything in this crate is deterministic and side-effect free except
//! `persist`, which touches the filesystem. Provider-specific branching lives
//! only in `normalize`; views and the runtime shell consume the canonical
//! contract in `contract`.

pub mod agents;
pub mod computer_use;
pub mod contract;
pub mod error;
pub mod handoff;
pub mod ids;
pub mod linebuf;
pub mod normalize;
pub mod order;
pub mod persist;
pub mod stamp;
pub mod voice;

pub use contract::*;
pub use computer_use::ComputerUseSettings;
pub use error::CoreError;
pub use handoff::{
    render_handoff, render_handoff_with_agents, ContextHandoff, DEFAULT_HANDOFF_BUDGET,
};
pub use linebuf::StreamingJsonLineBuffer;
pub use normalize::{normalize, NormalizerState, ProviderEventDraft};
pub use stamp::TurnStamper;
