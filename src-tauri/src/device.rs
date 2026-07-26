use std::collections::BTreeMap;
use std::ffi::{CStr, CString};

use hidapi::{DeviceInfo, HidApi};

use crate::models::{ChooserDevice, DeviceBinding, ProtocolSupport};

#[derive(Debug, Clone)]
pub struct NativeDevice {
    pub path: CString,
    pub vendor_id: u16,
    pub product_id: u16,
    pub product_name: String,
    pub serial_number: String,
    pub manufacturer: String,
    pub usage_page: u16,
    pub usage: u16,
    pub interface: i32,
    pub collection_signature: String,
    pub protocol_support: ProtocolSupport,
}

impl NativeDevice {
    pub fn device_id(&self) -> String {
        self.path.to_string_lossy().into_owned()
    }

    pub fn display_name(&self) -> String {
        if !self.product_name.is_empty() {
            return self.product_name.clone();
        }
        if !self.manufacturer.is_empty() {
            return self.manufacturer.clone();
        }
        format!("HID {:04X}:{:04X}", self.vendor_id, self.product_id)
    }

    pub fn binding(&self) -> DeviceBinding {
        DeviceBinding {
            vendor_id: self.vendor_id,
            product_id: self.product_id,
            product_name: self.product_name.clone(),
            collection_signature: self.collection_signature.clone(),
        }
    }

    fn chooser_group_key(&self) -> String {
        let identity = if !self.serial_number.is_empty() {
            &self.serial_number
        } else if !self.product_name.is_empty() {
            &self.product_name
        } else {
            &self.manufacturer
        };
        format!("{}:{}:{}", self.vendor_id, self.product_id, identity)
    }
}

pub fn normalize_name(value: Option<&str>) -> String {
    value
        .unwrap_or_default()
        .chars()
        .filter(|character| !character.is_control() && *character != '\u{fffd}')
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(128)
        .collect()
}

fn protocol_support(product_name: &str, usage_page: u16, usage: u16) -> ProtocolSupport {
    let name = product_name.to_ascii_uppercase();
    let known_family = ["ATK", "VXE", "F1", "X1", "R1"]
        .iter()
        .any(|needle| name.contains(needle));
    ProtocolSupport {
        compx: known_family || usage_page == 65280,
        hechi: known_family || usage == 2,
    }
}

fn from_device_info(info: &DeviceInfo) -> Option<NativeDevice> {
    let path = CString::new(info.path().to_bytes()).ok()?;
    let product_name = normalize_name(info.product_string());
    let serial_number = normalize_name(info.serial_number());
    let manufacturer = normalize_name(info.manufacturer_string());
    let usage_page = info.usage_page();
    let usage = info.usage();
    let interface = info.interface_number();
    let release = info.release_number();
    let collection_signature =
        format!("{interface}/{usage_page}/{usage}/{release}/{serial_number}");

    Some(NativeDevice {
        path,
        vendor_id: info.vendor_id(),
        product_id: info.product_id(),
        product_name: product_name.clone(),
        serial_number,
        manufacturer,
        usage_page,
        usage,
        interface,
        collection_signature,
        protocol_support: protocol_support(&product_name, usage_page, usage),
    })
}

pub fn list_devices(api: &mut HidApi) -> Result<Vec<NativeDevice>, String> {
    api.refresh_devices().map_err(|error| error.to_string())?;
    Ok(api.device_list().filter_map(from_device_info).collect())
}

pub fn binding_match_level(device: &NativeDevice, binding: Option<&DeviceBinding>) -> u8 {
    let Some(binding) = binding else {
        return 0;
    };
    if device.vendor_id != binding.vendor_id
        || device.product_id != binding.product_id
        || device.product_name != binding.product_name
    {
        return 0;
    }
    if device.collection_signature == binding.collection_signature {
        2
    } else {
        1
    }
}

pub fn same_product(device: &NativeDevice, binding: Option<&DeviceBinding>) -> bool {
    binding.is_some_and(|binding| {
        device.vendor_id == binding.vendor_id && device.product_id == binding.product_id
    })
}

pub fn match_score(device: &NativeDevice, binding: Option<&DeviceBinding>) -> i32 {
    let name = device.product_name.to_ascii_lowercase();
    let mut score = 0;
    if name.contains("virtual multitouch") {
        score -= 40;
    }
    if name.contains("atk") || name.contains("vxe") {
        score += 36;
    }
    if ["mouse", "鼠标", "dongle", "receiver", "2.4"]
        .iter()
        .any(|needle| name.contains(needle))
    {
        score += 28;
    }
    if name.contains("nano") {
        score += 10;
    }
    if name.contains("keyboard") {
        score -= 18;
    }
    if device.protocol_support.compx {
        score += 28;
    }
    if device.protocol_support.hechi {
        score += 28;
    }
    if device.usage == 2 {
        score += 18;
    } else if device.usage == 6 {
        score -= 10;
    }
    if device.interface > 0 {
        score += device.interface * 2;
    }
    score + i32::from(binding_match_level(device, binding)) * 120
}

fn include_in_chooser(device: &NativeDevice, binding: Option<&DeviceBinding>) -> bool {
    if binding_match_level(device, binding) > 0
        || device.protocol_support.compx
        || device.protocol_support.hechi
    {
        return true;
    }
    let name = device.product_name.to_ascii_lowercase();
    let mouse_like = ["mouse", "鼠标", "dongle", "receiver", "2.4", "wireless"]
        .iter()
        .any(|needle| name.contains(needle))
        || device.usage == 2;
    let noise = [
        "virtual multitouch",
        "trackpad",
        "touchpad",
        "touch bar",
        "consumer control",
        "keyboard",
        "apple internal",
    ]
    .iter()
    .any(|needle| name.contains(needle));
    mouse_like && !noise
}

pub fn chooser_devices(
    devices: &[NativeDevice],
    binding: Option<&DeviceBinding>,
) -> Vec<ChooserDevice> {
    let filtered: Vec<_> = devices
        .iter()
        .filter(|device| include_in_chooser(device, binding))
        .collect();
    let source: Vec<_> = if filtered.is_empty() {
        devices.iter().collect()
    } else {
        filtered
    };
    let mut groups: BTreeMap<String, Vec<&NativeDevice>> = BTreeMap::new();
    for device in source {
        groups
            .entry(device.chooser_group_key())
            .or_default()
            .push(device);
    }
    let mut result: Vec<_> = groups
        .into_iter()
        .filter_map(|(device_id, group)| {
            let representative = group
                .iter()
                .max_by_key(|device| match_score(device, binding))?;
            Some(ChooserDevice {
                device_id,
                vendor_id: representative.vendor_id,
                product_id: representative.product_id,
                product_name: representative.product_name.clone(),
                serial_number: representative.serial_number.clone(),
                interface: representative.interface,
                usage_page: representative.usage_page,
                usage: representative.usage,
                collection_signature: representative.collection_signature.clone(),
                score: match_score(representative, binding),
                match_level: binding_match_level(representative, binding),
                protocol_support: representative.protocol_support,
                candidate_count: group.len(),
            })
        })
        .collect();
    result.sort_by(|left, right| {
        right
            .match_level
            .cmp(&left.match_level)
            .then_with(|| right.score.cmp(&left.score))
            .then_with(|| left.product_name.cmp(&right.product_name))
    });
    result
}

pub fn candidates(devices: &[NativeDevice], binding: Option<&DeviceBinding>) -> Vec<NativeDevice> {
    let mut candidates: Vec<_> = devices
        .iter()
        .filter(|device| binding_match_level(device, binding) > 0 || same_product(device, binding))
        .cloned()
        .collect();
    candidates.sort_by(|left, right| {
        binding_match_level(right, binding)
            .cmp(&binding_match_level(left, binding))
            .then_with(|| match_score(right, binding).cmp(&match_score(left, binding)))
    });
    candidates
}

pub fn group_binding(
    devices: &[NativeDevice],
    device_id: &str,
    binding: Option<&DeviceBinding>,
) -> Option<(DeviceBinding, String)> {
    devices
        .iter()
        .filter(|device| device.chooser_group_key() == device_id)
        .max_by_key(|device| match_score(device, binding))
        .map(|device| (device.binding(), device.display_name()))
}

pub fn open_path(api: &HidApi, path: &CStr) -> Result<hidapi::HidDevice, String> {
    api.open_path(path).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(path: &str, product_name: &str, interface: i32, usage: u16) -> NativeDevice {
        NativeDevice {
            path: CString::new(path).unwrap(),
            vendor_id: 0x373b,
            product_id: 0x1054,
            product_name: product_name.to_owned(),
            serial_number: "ABC".to_owned(),
            manufacturer: "ATK".to_owned(),
            usage_page: 1,
            usage,
            interface,
            collection_signature: format!("{interface}/1/{usage}/1/ABC"),
            protocol_support: protocol_support(product_name, 1, usage),
        }
    }

    #[test]
    fn normalizes_device_names() {
        assert_eq!(normalize_name(Some(" ATK\0  X1 \u{fffd}")), "ATK X1");
    }

    #[test]
    fn ranks_exact_binding_before_same_product_interfaces() {
        let exact = device("exact", "ATK X1", 2, 2);
        let other = device("other", "ATK X1", 1, 2);
        let binding = exact.binding();
        let result = candidates(&[other, exact.clone()], Some(&binding));
        assert_eq!(result[0].device_id(), exact.device_id());
        assert_eq!(binding_match_level(&result[0], Some(&binding)), 2);
    }

    #[test]
    fn chooser_groups_interfaces_for_one_receiver() {
        let first = device("first", "ATK X1", 1, 2);
        let second = device("second", "ATK X1", 2, 2);
        let result = chooser_devices(&[first, second], None);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].candidate_count, 2);
        assert!(result[0].protocol_support.hechi);
    }
}
