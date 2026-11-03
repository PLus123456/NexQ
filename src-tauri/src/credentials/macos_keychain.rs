//! macOS Keychain-backed credential storage.
//!
//! Every key lives in one generic-password item, service `NexQPlus:vault`,
//! account `vault`: a JSON object of provider → key, read once per run and
//! kept in memory. A self-built app is ad-hoc signed, so each rebuild is a
//! new app to the keychain, which asks for the login password once for every
//! item the app reads: one item, one prompt per build. Uses the Security
//! framework directly, so secrets never appear on a command line.
//!
//! Items from before the vault (service `NexQPlus:{provider}`, account
//! `{provider}`, the naming the Windows backend keeps; see `SERVICE_PREFIX`)
//! are copied in the first time they are read, and removed then and whenever
//! that key is changed or deleted. A provider in the vault is answered from
//! it, and a deleted key stays there as an empty string, so an old item that
//! could not be removed never brings it back.

use std::collections::{BTreeMap, HashSet};
use std::sync::Mutex;

use security_framework::passwords::{
    delete_generic_password, get_generic_password, set_generic_password,
};

/// `errSecItemNotFound`.
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

const VAULT_ACCOUNT: &str = "vault";

fn service_name(account: &str) -> String {
    format!("{}{}", super::SERVICE_PREFIX, account)
}

/// Generic-password items by account: the login keychain, or a map in tests.
trait Items {
    fn get(&self, account: &str) -> Result<Option<Vec<u8>>, String>;
    fn set(&self, account: &str, data: &[u8]) -> Result<(), String>;
    /// Removing a missing item is not an error.
    fn remove(&self, account: &str) -> Result<(), String>;
}

struct Keychain;

impl Items for Keychain {
    fn get(&self, account: &str) -> Result<Option<Vec<u8>>, String> {
        match get_generic_password(&service_name(account), account) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(None),
            Err(e) => Err(format!("Keychain read failed for {}: {}", account, e)),
        }
    }

    fn set(&self, account: &str, data: &[u8]) -> Result<(), String> {
        set_generic_password(&service_name(account), account, data)
            .map_err(|e| format!("Keychain write failed for {}: {}", account, e))
    }

    fn remove(&self, account: &str) -> Result<(), String> {
        match delete_generic_password(&service_name(account), account) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(e) => Err(format!("Keychain delete failed for {}: {}", account, e)),
        }
    }
}

/// What this run knows: the vault's keys, and the providers that have no
/// item from before the vault either.
#[derive(Default)]
struct Known {
    keys: BTreeMap<String, String>,
    absent: HashSet<String>,
}

struct Vault<I> {
    items: I,
    known: Mutex<Option<Known>>,
}

static VAULT: Vault<Keychain> = Vault::new(Keychain);

impl<I: Items> Vault<I> {
    const fn new(items: I) -> Self {
        Self { items, known: Mutex::new(None) }
    }

    /// Runs `f` on what is known, reading the vault first if this run hasn't
    /// (the lock is held meanwhile, so a password prompt is shown once).
    fn with_known<T>(&self, f: impl FnOnce(&I, &mut Known) -> Result<T, String>) -> Result<T, String> {
        let mut guard = self.known.lock().map_err(|_| "Keychain cache lock poisoned".to_string())?;
        if guard.is_none() {
            let keys = match self.items.get(VAULT_ACCOUNT)? {
                Some(bytes) => serde_json::from_slice(&bytes)
                    .map_err(|_| "The keychain vault is not valid JSON".to_string())?,
                None => BTreeMap::new(),
            };
            *guard = Some(Known { keys, absent: HashSet::new() });
        }
        f(&self.items, guard.as_mut().expect("read above"))
    }

    /// Saves the vault with `provider` set to `key` (empty: deleted).
    fn put(items: &I, known: &mut Known, provider: &str, key: &str) -> Result<(), String> {
        let mut keys = known.keys.clone();
        keys.insert(provider.to_string(), key.to_string());
        let json = serde_json::to_vec(&keys).map_err(|e| format!("Keychain vault: {}", e))?;
        items.set(VAULT_ACCOUNT, &json)?;
        known.keys = keys;
        Ok(())
    }

    /// Removes the item `provider`'s key had before the vault, if any (the
    /// vault holds the key, so failing only leaves a stale copy behind).
    fn remove_old(items: &I, known: &mut Known, provider: &str) {
        if known.absent.contains(provider) {
            return;
        }
        match items.remove(provider) {
            Ok(()) => {
                known.absent.insert(provider.to_string());
            }
            Err(e) => log::warn!("Could not remove the old keychain item of {}: {}", provider, e),
        }
    }

    fn write(&self, provider: &str, key: &str) -> Result<(), String> {
        self.with_known(|items, known| {
            Self::put(items, known, provider, key)?;
            Self::remove_old(items, known, provider);
            Ok(())
        })
    }

    fn read(&self, provider: &str) -> Result<Option<String>, String> {
        self.with_known(|items, known| {
            if let Some(key) = known.keys.get(provider) {
                return Ok(Some(key.clone()).filter(|k| !k.is_empty()));
            }
            if known.absent.contains(provider) {
                return Ok(None);
            }
            let Some(bytes) = items.get(provider)? else {
                known.absent.insert(provider.to_string());
                return Ok(None);
            };
            let key = String::from_utf8(bytes)
                .map_err(|_| format!("Keychain item for {} is not valid UTF-8", provider))?;
            if key.is_empty() {
                return Ok(None);
            }
            match Self::put(items, known, provider, &key) {
                Ok(()) => Self::remove_old(items, known, provider),
                Err(e) => log::warn!("Could not move the {} key into the keychain vault: {}", provider, e),
            }
            Ok(Some(key))
        })
    }

    /// Deleting a missing key is not an error.
    fn delete(&self, provider: &str) -> Result<(), String> {
        self.with_known(|items, known| {
            if !known.keys.get(provider).is_some_and(|k| k.is_empty()) {
                Self::put(items, known, provider, "")?;
            }
            Self::remove_old(items, known, provider);
            Ok(())
        })
    }
}

/// Write (or update) a credential.
pub fn credential_write(provider: &str, key: &str) -> Result<(), String> {
    VAULT.write(provider, key)
}

/// Read a credential. Returns None if it does not exist.
pub fn credential_read(provider: &str) -> Result<Option<String>, String> {
    VAULT.read(provider)
}

/// Delete a credential. Deleting a missing item is not an error.
pub fn credential_delete(provider: &str) -> Result<(), String> {
    VAULT.delete(provider)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    /// Items in memory, counting reads of each account.
    #[derive(Default)]
    struct Memory {
        items: RefCell<HashMap<String, Vec<u8>>>,
        reads: RefCell<HashMap<String, usize>>,
    }

    impl Items for Memory {
        fn get(&self, account: &str) -> Result<Option<Vec<u8>>, String> {
            *self.reads.borrow_mut().entry(account.to_string()).or_default() += 1;
            Ok(self.items.borrow().get(account).cloned())
        }

        fn set(&self, account: &str, data: &[u8]) -> Result<(), String> {
            self.items.borrow_mut().insert(account.to_string(), data.to_vec());
            Ok(())
        }

        fn remove(&self, account: &str) -> Result<(), String> {
            self.items.borrow_mut().remove(account);
            Ok(())
        }
    }

    fn stored(vault: &Vault<Memory>) -> Vec<String> {
        let mut accounts: Vec<String> = vault.items.items.borrow().keys().cloned().collect();
        accounts.sort();
        accounts
    }

    fn memory(items: &[(&str, &str)]) -> Memory {
        let m = Memory::default();
        for (account, value) in items {
            m.set(account, value.as_bytes()).unwrap();
        }
        m
    }

    fn reads(vault: &Vault<Memory>, account: &str) -> usize {
        vault.items.reads.borrow().get(account).copied().unwrap_or(0)
    }

    #[test]
    fn keys_from_before_the_vault_move_in_on_first_read() {
        let vault = Vault::new(memory(&[("llm:c_1", "sk-a"), ("soniox_us", "s-us")]));
        assert_eq!(vault.read("llm:c_1").unwrap().as_deref(), Some("sk-a"));
        assert_eq!(vault.read("soniox_us").unwrap().as_deref(), Some("s-us"));
        assert_eq!(vault.read("llm:c_1").unwrap().as_deref(), Some("sk-a"));
        assert_eq!(reads(&vault, "llm:c_1"), 1);
        assert_eq!(stored(&vault), ["vault"]);

        // The next run reads the vault alone.
        let items = std::mem::take(&mut *vault.items.items.borrow_mut());
        let next = Vault::new(Memory { items: RefCell::new(items), ..Memory::default() });
        assert_eq!(next.read("llm:c_1").unwrap().as_deref(), Some("sk-a"));
        assert_eq!(next.read("soniox_us").unwrap().as_deref(), Some("s-us"));
        assert_eq!((reads(&next, "vault"), reads(&next, "llm:c_1"), reads(&next, "soniox_us")), (1, 0, 0));
    }

    #[test]
    fn a_deleted_key_does_not_come_back_from_its_old_item() {
        let vault = Vault::new(memory(&[("deepgram", "dg")]));
        vault.delete("deepgram").unwrap();
        assert_eq!(stored(&vault), ["vault"]);
        assert_eq!(vault.read("deepgram").unwrap(), None);
        assert_eq!(reads(&vault, "deepgram"), 0);
        vault.write("deepgram", "dg2").unwrap();
        assert_eq!(vault.read("deepgram").unwrap().as_deref(), Some("dg2"));
    }

    #[test]
    fn a_new_key_replaces_the_old_item() {
        let vault = Vault::new(memory(&[("soniox_eu", "old")]));
        vault.write("soniox_eu", "new").unwrap();
        assert_eq!(stored(&vault), ["vault"]);
        assert_eq!(vault.read("soniox_eu").unwrap().as_deref(), Some("new"));
    }

    #[test]
    fn a_missing_key_is_looked_up_once_per_run() {
        let vault = Vault::new(Memory::default());
        assert_eq!(vault.read("groq_whisper").unwrap(), None);
        assert_eq!(vault.read("groq_whisper").unwrap(), None);
        assert_eq!(reads(&vault, "groq_whisper"), 1);
        // Nothing stored, nothing written.
        assert!(vault.items.items.borrow().is_empty());
        vault.delete("groq_whisper").unwrap();
        assert_eq!(vault.read("groq_whisper").unwrap(), None);
    }

    #[test]
    fn the_vault_is_read_once_per_run() {
        let vault = Vault::new(memory(&[("vault", r#"{"openai":"sk-o"}"#)]));
        for _ in 0..3 {
            assert_eq!(vault.read("openai").unwrap().as_deref(), Some("sk-o"));
        }
        vault.write("deepl", "d").unwrap();
        assert_eq!(reads(&vault, "vault"), 1);
        let saved: BTreeMap<String, String> =
            serde_json::from_slice(&vault.items.items.borrow()["vault"]).unwrap();
        assert_eq!(saved.len(), 2);
    }
}
