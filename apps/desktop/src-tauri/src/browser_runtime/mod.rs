//! Provider-neutral browser control plane.
//!
//! Remote pages remain unprivileged child webviews. Provider processes talk to
//! the authenticated MCP gateway, which resolves their server-side scope and
//! dispatches typed operations through [`BrowserBroker`]. Browser engines never
//! receive provider-supplied project, thread, or capability identifiers.

mod artifact;
mod broker;
mod contract;
mod gateway;
mod remote;
mod session;
mod stdio_bridge;

pub use artifact::*;
pub use broker::*;
pub use contract::*;
pub use gateway::*;
pub use remote::*;
pub use session::*;
pub use stdio_bridge::*;
