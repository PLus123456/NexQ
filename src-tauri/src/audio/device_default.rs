//! Temporary default recording endpoint override for engines that open their own mic.

#![cfg(target_os = "windows")]

use std::ffi::c_void;

use windows::core::{IUnknown, Interface, GUID, HRESULT, PCWSTR};
use windows::Win32::Media::Audio::{
    eCapture, eCommunications, eConsole, eMultimedia, ERole, IMMDevice, IMMDeviceEnumerator,
    MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
    COINIT_MULTITHREADED,
};

const ROLES: [ERole; 3] = [eConsole, eMultimedia, eCommunications];

/// Preserve each default separately. Some users choose a different device for
/// calls, and setting one role must not overwrite their other role preferences.
pub struct DefaultCaptureOverride {
    target: String,
    original: [String; ROLES.len()],
    changed: [bool; ROLES.len()],
    active: bool,
}

impl DefaultCaptureOverride {
    pub fn new(device_name: &str) -> Result<Self, String> {
        with_com(|| {
            let enumerator = device_enumerator()?;
            let target = find_capture_endpoint_id_by_name(&enumerator, device_name)?;
            let original = [
                default_endpoint(&enumerator, eConsole)?,
                default_endpoint(&enumerator, eMultimedia)?,
                default_endpoint(&enumerator, eCommunications)?,
            ];
            Ok(Self { target, original, changed: [false; ROLES.len()], active: false })
        })
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn target(&self) -> &str {
        &self.target
    }

    /// Return whether any roles needed applying, including if one has drifted
    /// since an initially matching default was selected.
    pub fn ensure(&mut self) -> Result<bool, String> {
        with_com(|| {
            let enumerator = device_enumerator()?;
            let mut applied = false;
            for (index, role) in ROLES.into_iter().enumerate() {
                if default_endpoint(&enumerator, role)? != self.target {
                    set_default_endpoint(&self.target, role)?;
                    self.changed[index] = true;
                    applied = true;
                }
            }
            self.active = true;
            Ok(applied)
        })
    }

    /// Undo the app's changes. If a role has since been changed elsewhere,
    /// leave that device selection in place. Keep failed restores for retry.
    pub fn restore(&mut self) -> Result<(), String> {
        self.active = false;
        with_com(|| {
            let enumerator = device_enumerator()?;
            let mut error = None;
            for (index, role) in ROLES.into_iter().enumerate() {
                if !self.changed[index] {
                    continue;
                }
                let still_overridden = default_endpoint(&enumerator, role)
                    .map(|current| current == self.target).unwrap_or(true);
                if still_overridden && self.original[index] != self.target {
                    if let Err(err) = set_default_endpoint(&self.original[index], role) {
                        error = Some(err);
                        continue;
                    }
                }
                self.changed[index] = false;
            }
            error.map_or(Ok(()), Err)
        })
    }
}

fn with_com<T>(operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    struct Apartment(bool);
    impl Drop for Apartment {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }
    let result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    // RPC_E_CHANGED_MODE means the caller already has a different COM apartment.
    if result.is_err() && result.0 as u32 != 0x80010106 {
        return Err(format!("CoInitializeEx failed: 0x{:08X}", result.0));
    }
    let _apartment = Apartment(result.is_ok()); // includes S_FALSE
    operation()
}

fn device_enumerator() -> Result<IMMDeviceEnumerator, String> {
    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
        .map_err(|err| format!("Device enumerator creation failed: {err}"))
}

fn endpoint_id(device: &IMMDevice) -> Result<String, String> {
    unsafe {
        let id = device.GetId().map_err(|err| format!("GetId failed: {err}"))?;
        let value = id.to_string();
        CoTaskMemFree(Some(id.0.cast::<c_void>()));
        value.map_err(|err| format!("Invalid Windows endpoint ID: {err}"))
    }
}

fn default_endpoint(enumerator: &IMMDeviceEnumerator, role: ERole) -> Result<String, String> {
    let device = unsafe { enumerator.GetDefaultAudioEndpoint(eCapture, role) }
        .map_err(|err| format!("Couldn't read default capture device for role {}: {err}", role.0))?;
    endpoint_id(&device)
}

fn find_capture_endpoint_id_by_name(enumerator: &IMMDeviceEnumerator, name: &str) -> Result<String, String> {
    unsafe {
        let devices = enumerator.EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)
            .map_err(|err| format!("EnumAudioEndpoints failed: {err}"))?;
        let count = devices.GetCount().map_err(|err| format!("GetCount failed: {err}"))?;
        for index in 0..count {
            if let Ok(device) = devices.Item(index) {
                if get_device_friendly_name_internal(&device).as_deref() == Some(name) {
                    return endpoint_id(&device);
                }
            }
        }
    }
    Err(format!("Capture device '{name}' not found in MMDevice enumeration"))
}

fn set_default_endpoint(endpoint: &str, role: ERole) -> Result<(), String> {
    // IPolicyConfig, available since Vista. SetDefaultEndpoint is vtable slot
    // 13, including the three leading IUnknown entries.
    const CLASS: GUID = GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9);
    const IID: GUID = GUID::from_u128(0xf8679f50_850a_41cf_9c72_430f290290c8);
    type QueryInterface = unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> HRESULT;
    type SetDefault = unsafe extern "system" fn(*mut c_void, PCWSTR, i32) -> HRESULT;
    unsafe {
        let client: IUnknown = CoCreateInstance(&CLASS, None, CLSCTX_ALL)
            .map_err(|err| format!("PolicyConfig COM creation failed: {err}"))?;
        let raw = client.as_raw();
        let vtable = *raw.cast::<*const *const c_void>();
        let query: QueryInterface = std::mem::transmute(*vtable);
        let mut raw_policy = std::ptr::null_mut();
        query(raw, &IID, &mut raw_policy).ok()
            .map_err(|err| format!("QueryInterface for IPolicyConfig failed: {err}"))?;
        let policy = IUnknown::from_raw(raw_policy);
        let policy_vtable = *policy.as_raw().cast::<*const *const c_void>();
        let set_default: SetDefault = std::mem::transmute(*policy_vtable.add(13));
        let wide: Vec<u16> = endpoint.encode_utf16().chain(std::iter::once(0)).collect();
        set_default(policy.as_raw(), PCWSTR(wide.as_ptr()), role.0).ok()
            .map_err(|err| format!("Couldn't set default capture device for role {}: {err}", role.0))
    }
}

/// Extract the friendly name from a Windows audio endpoint device,
/// matching the format that cpal uses for device names (PKEY_Device_FriendlyName).
#[cfg(target_os = "windows")]
fn get_device_friendly_name_internal(
    device: &windows::Win32::Media::Audio::IMMDevice,
) -> Option<String> {
    use windows::Win32::Foundation::PROPERTYKEY;
    use windows::core::GUID;

    unsafe {
        // PKEY_Device_FriendlyName = {a45c254e-df1c-4efd-8020-67d146a850e0}, 14
        let pkey = PROPERTYKEY {
            fmtid: GUID::from_values(
                0xa45c254e,
                0xdf1c,
                0x4efd,
                [0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0],
            ),
            pid: 14,
        };
        let store = device
            .OpenPropertyStore(windows::Win32::System::Com::STGM(0))
            .ok()?;
        let prop = store.GetValue(&pkey).ok()?;
        let s = format!("{}", prop);
        if s.is_empty() || s == "VT_EMPTY" {
            return None;
        }
        Some(s)
    }
}
