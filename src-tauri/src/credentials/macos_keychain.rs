//! macOS Keychain-backed credential storage.
//!
//! Uses the Security framework directly (generic-password items), so secrets
//! never appear on a command line. Key naming matches the Windows backend:
//! service `NexQPlus:{provider}` (see `SERVICE_PREFIX`), account `{provider}`.

use security_framework::passwords::{
    delete_generic_password, get_generic_password, set_generic_password,
};

/// `errSecItemNotFound`.
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

fn service_name(provider: &str) -> String {
    format!("{}{}", super::SERVICE_PREFIX, provider)
}

/// Write (or update) a credential.
pub fn credential_write(provider: &str, key: &str) -> Result<(), String> {
    set_generic_password(&service_name(provider), provider, key.as_bytes())
        .map_err(|e| format!("Keychain write failed for {}: {}", provider, e))
}

/// Read a credential. Returns None if it does not exist.
pub fn credential_read(provider: &str) -> Result<Option<String>, String> {
    match get_generic_password(&service_name(provider), provider) {
        Ok(bytes) => {
            let value = String::from_utf8(bytes)
                .map_err(|_| format!("Keychain item for {} is not valid UTF-8", provider))?;
            Ok(if value.is_empty() { None } else { Some(value) })
        }
        Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
        Err(e) => Err(format!("Keychain read failed for {}: {}", provider, e)),
    }
}

/// Delete a credential. Deleting a missing item is not an error.
pub fn credential_delete(provider: &str) -> Result<(), String> {
    match delete_generic_password(&service_name(provider), provider) {
        Ok(()) => Ok(()),
        Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
        Err(e) => Err(format!("Keychain delete failed for {}: {}", provider, e)),
    }
}
