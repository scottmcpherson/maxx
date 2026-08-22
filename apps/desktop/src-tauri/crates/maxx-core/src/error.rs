//! Error surface for the core crate, mirroring the Swift `ProviderError` and
//! `ProviderNativeMessageError` cases the normalizer and runtime can raise.

use crate::contract::ChatProvider;

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum CoreError {
    #[error("{} emitted a malformed native message: {detail}", provider.display_name())]
    Malformed {
        provider: ChatProvider,
        detail: String,
    },
    #[error("{0}")]
    CommandFailed(String),
    #[error("{0}")]
    Unsupported(String),
    #[error("Persistence failed: {0}")]
    Persistence(String),
}
