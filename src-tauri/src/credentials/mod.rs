#[cfg(target_os = "windows")]
mod windows_cred;

#[cfg(target_os = "macos")]
mod macos_keychain;

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
mod fallback_cred;

#[cfg(target_os = "windows")]
use self::windows_cred as backend;

#[cfg(target_os = "macos")]
use self::macos_keychain as backend;

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
use self::fallback_cred as backend;

/// Prefix of every credential's service / target name (`NexQPlus:{provider}`).
/// Differs from the official app's `NexQ:` so the two never share keys.
#[cfg_attr(all(not(target_os = "windows"), not(target_os = "macos")), allow(dead_code))]
pub(crate) const SERVICE_PREFIX: &str = "NexQPlus:";

/// Credential manager for secure API key storage.
/// Delegates to the platform-specific credential backend
/// (Windows Credential Manager, macOS Keychain, or a stub on other platforms).
pub struct CredentialManager;

impl Default for CredentialManager {
    fn default() -> Self {
        Self::new()
    }
}

impl CredentialManager {
    pub fn new() -> Self {
        Self
    }

    /// Store an API key for the given provider.
    pub fn store_key(&self, provider: &str, key: &str) -> Result<(), String> {
        let provider = Self::normalize_provider(provider);
        backend::credential_write(&provider, key)
    }

    /// Retrieve an API key for the given provider. Returns None if not stored.
    pub fn get_key(&self, provider: &str) -> Result<Option<String>, String> {
        let provider = Self::normalize_provider(provider);
        backend::credential_read(&provider)
    }

    /// Delete the API key for the given provider.
    pub fn delete_key(&self, provider: &str) -> Result<(), String> {
        let provider = Self::normalize_provider(provider);
        backend::credential_delete(&provider)
    }

    /// Check whether an API key exists for the given provider.
    pub fn has_key(&self, provider: &str) -> Result<bool, String> {
        let provider = Self::normalize_provider(provider);
        let key = backend::credential_read(&provider)?;
        Ok(key.is_some())
    }

    /// Normalize provider name to lowercase for consistent key naming.
    fn normalize_provider(provider: &str) -> String {
        provider.to_lowercase().trim().to_string()
    }
}
