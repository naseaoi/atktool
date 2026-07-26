use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DeviceBinding {
    pub vendor_id: u16,
    pub product_id: u16,
    pub product_name: String,
    pub collection_signature: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowPosition {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Preferences {
    pub overlay_bounds: Option<WindowPosition>,
    pub compact_overlay_bounds: Option<WindowPosition>,
    pub manager_bounds: Option<WindowBounds>,
    pub preferred_hid_device: Option<DeviceBinding>,
    pub display_device_name: String,
    pub always_on_top: bool,
    pub open_at_login: bool,
    pub overlay_variant: String,
    pub overlay_visible: bool,
    pub hub_sync: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            overlay_bounds: None,
            compact_overlay_bounds: None,
            manager_bounds: None,
            preferred_hid_device: None,
            display_device_name: String::new(),
            always_on_top: true,
            open_at_login: false,
            overlay_variant: "full".to_owned(),
            overlay_visible: true,
            hub_sync: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayState {
    pub status: String,
    pub message: String,
    pub battery_percent: Option<u8>,
    pub battery_text: String,
    pub device_name: String,
    pub charging: bool,
    pub charge_status: String,
    pub needs_user_action: bool,
    pub sampled_at: Option<String>,
    pub protocol_name: String,
    pub mode: String,
    pub always_on_top: bool,
    pub overlay_variant: String,
    pub granted_devices_count: usize,
}

impl OverlayState {
    pub fn from_preferences(preferences: &Preferences) -> Self {
        Self {
            status: "loading".to_owned(),
            message: "正在准备原生 HID 直连器...".to_owned(),
            battery_percent: None,
            battery_text: "--".to_owned(),
            device_name: preferences.display_device_name.clone(),
            charging: false,
            charge_status: "idle".to_owned(),
            needs_user_action: true,
            sampled_at: None,
            protocol_name: String::new(),
            mode: "stable".to_owned(),
            always_on_top: preferences.always_on_top,
            overlay_variant: preferences.overlay_variant.clone(),
            granted_devices_count: 0,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolSupport {
    pub compx: bool,
    pub hechi: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChooserDevice {
    pub device_id: String,
    pub vendor_id: u16,
    pub product_id: u16,
    pub product_name: String,
    pub serial_number: String,
    pub interface: i32,
    pub usage_page: u16,
    pub usage: u16,
    pub collection_signature: String,
    pub score: i32,
    pub match_level: u8,
    pub protocol_support: ProtocolSupport,
    pub candidate_count: usize,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HidSelectionPayload {
    pub open: bool,
    pub devices: Vec<ChooserDevice>,
}
