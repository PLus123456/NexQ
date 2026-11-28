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

    /// Call under the shared credential lock so readers see a tested key and region together.
    pub fn store_key_with_region(
        &self,
        key_slot: &str,
        key: &str,
        region_slot: &str,
        region: &str,
    ) -> Result<(), String> {
        let previous_key = self.get_key(key_slot)?;
        self.store_key(key_slot, key)?;
        if let Err(error) = self.store_key(region_slot, region) {
            let rollback = match previous_key {
                Some(previous) => self.store_key(key_slot, &previous),
                None => self.delete_key(key_slot),
            };
            return match rollback {
                Ok(()) => Err(error),
                Err(rollback_error) => Err(format!("{error}. Could not restore the previous key: {rollback_error}")),
            };
        }
        Ok(())
    }

    /// Retrieve an API key for the given provider. Returns None if not stored.
    pub fn get_key(&self, provider: &str) -> Result<Option<String>, String> {
        let provider = Self::normalize_provider(provider);
        backend::credential_read(&provider).map(|key| key.filter(|value| !value.is_empty()))
    }

    /// Delete the API key for the given provider.
    pub fn delete_key(&self, provider: &str) -> Result<(), String> {
        let provider = Self::normalize_provider(provider);
        backend::credential_delete(&provider)
    }

    /// Check whether an API key exists for the given provider.
    pub fn has_key(&self, provider: &str) -> Result<bool, String> {
        Ok(self.get_key(provider)?.is_some())
    }

    /// Normalize provider name to lowercase for consistent key naming.
    pub(crate) fn normalize_provider(provider: &str) -> String {
        provider.to_lowercase().trim().to_string()
    }
}
