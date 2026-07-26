use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

const HUB_PERMISSION_ORIGIN: &str = "https://hub.atk.pro:443,*";
const MAX_PREFERENCES_BYTES: u64 = 64 * 1024 * 1024;
const MAX_HID_GRANTS: usize = 32;

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
struct HidGrant {
    name: String,
    product_id: u16,
    serial_number: String,
    vendor_id: u16,
}

fn read_json(path: &Path) -> Result<Value, String> {
    let metadata = fs::metadata(path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_PREFERENCES_BYTES {
        return Err("浏览器配置文件过大".to_owned());
    }
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&contents).map_err(|error| error.to_string())
}

fn valid_profile_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value != "."
        && value != ".."
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || " _-.".contains(character))
}

fn edge_profile_names(edge_root: &Path) -> Vec<String> {
    let mut names = Vec::new();
    if let Ok(local_state) = read_json(&edge_root.join("Local State")) {
        if let Some(last_used) = local_state
            .pointer("/profile/last_used")
            .and_then(Value::as_str)
            .filter(|value| valid_profile_name(value))
        {
            names.push(last_used.to_owned());
        }
        if let Some(info_cache) = local_state
            .pointer("/profile/info_cache")
            .and_then(Value::as_object)
        {
            names.extend(
                info_cache
                    .keys()
                    .filter(|name| valid_profile_name(name))
                    .cloned(),
            );
        }
    }
    names.push("Default".to_owned());
    let mut seen = HashSet::new();
    names.retain(|name| seen.insert(name.clone()));
    names
}

fn hid_permission_entry(preferences: &Value) -> Option<&Value> {
    preferences
        .pointer("/profile/content_settings/exceptions/hid_chooser_data")?
        .as_object()?
        .get(HUB_PERMISSION_ORIGIN)
}

fn clean_text(value: &str, maximum: usize) -> String {
    value
        .chars()
        .filter(|character| !character.is_control() && *character != '\u{fffd}')
        .take(maximum)
        .collect::<String>()
        .trim()
        .to_owned()
}

fn validated_grants(entry: &Value) -> Vec<HidGrant> {
    let mut grants = Vec::new();
    let mut seen = HashSet::new();
    let Some(objects) = entry
        .pointer("/setting/chosen-objects")
        .and_then(Value::as_array)
    else {
        return grants;
    };
    for value in objects.iter().take(MAX_HID_GRANTS) {
        let Ok(mut grant) = serde_json::from_value::<HidGrant>(value.clone()) else {
            continue;
        };
        grant.name = clean_text(&grant.name, 128);
        grant.serial_number = clean_text(&grant.serial_number, 256);
        if !grant.name.is_empty() && seen.insert(grant.clone()) {
            grants.push(grant);
        }
    }
    grants
}

fn ensure_object_child<'a>(
    parent: &'a mut Map<String, Value>,
    key: &str,
) -> &'a mut Map<String, Value> {
    parent
        .entry(key.to_owned())
        .or_insert_with(|| Value::Object(Map::new()));
    if !parent.get(key).is_some_and(Value::is_object) {
        parent.insert(key.to_owned(), Value::Object(Map::new()));
    }
    parent.get_mut(key).and_then(Value::as_object_mut).unwrap()
}

fn merge_hid_grants(source_entry: &Value, target: &mut Value) -> usize {
    let source_grants = validated_grants(source_entry);
    if source_grants.is_empty() {
        return 0;
    }
    if !target.is_object() {
        *target = Value::Object(Map::new());
    }
    let root = target.as_object_mut().unwrap();
    let profile = ensure_object_child(root, "profile");
    let content_settings = ensure_object_child(profile, "content_settings");
    let exceptions = ensure_object_child(content_settings, "exceptions");
    let chooser_data = ensure_object_child(exceptions, "hid_chooser_data");
    let entry = chooser_data
        .entry(HUB_PERMISSION_ORIGIN.to_owned())
        .or_insert_with(|| {
            json!({
                "setting": {
                    "chosen-objects": []
                }
            })
        });
    if !entry.is_object() {
        *entry = json!({"setting": {"chosen-objects": []}});
    }
    let existing = validated_grants(entry);
    let mut known = existing.iter().cloned().collect::<HashSet<_>>();
    let imported = source_grants
        .into_iter()
        .filter(|grant| known.insert(grant.clone()))
        .take(MAX_HID_GRANTS.saturating_sub(existing.len()))
        .collect::<Vec<_>>();
    if imported.is_empty() {
        return 0;
    }
    let mut merged = existing;
    merged.extend(imported.iter().cloned());
    merged.truncate(MAX_HID_GRANTS);
    entry["setting"]["chosen-objects"] = serde_json::to_value(merged).unwrap();
    if let Some(last_modified) = source_entry
        .get("last_modified")
        .and_then(Value::as_str)
        .filter(|value| {
            value.len() <= 32 && value.chars().all(|character| character.is_ascii_digit())
        })
    {
        entry["last_modified"] = Value::String(last_modified.to_owned());
    }
    imported.len()
}

fn edge_preferences(local_app_data: &Path) -> Option<(Value, PathBuf)> {
    let edge_root = local_app_data
        .join("Microsoft")
        .join("Edge")
        .join("User Data");
    edge_profile_names(&edge_root)
        .into_iter()
        .find_map(|profile| {
            let path = edge_root.join(profile).join("Preferences");
            let preferences = read_json(&path).ok()?;
            hid_permission_entry(&preferences)?;
            Some((preferences, path))
        })
}

pub fn import_edge_hid_grants(app: &AppHandle) -> Result<usize, String> {
    let local_app_data = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| "无法获取本地应用数据目录".to_owned())?;
    let (source, _) = edge_preferences(&local_app_data)
        .ok_or_else(|| "Edge 中没有 ATK HUB 的 HID 授权".to_owned())?;
    let source_entry =
        hid_permission_entry(&source).ok_or_else(|| "Edge HID 授权数据无效".to_owned())?;
    let target_path = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join("EBWebView")
        .join("Default")
        .join("Preferences");
    let mut target = if target_path.exists() {
        read_json(&target_path)?
    } else {
        json!({})
    };
    let imported = merge_hid_grants(source_entry, &mut target);
    if imported == 0 {
        return Ok(0);
    }
    let directory = target_path
        .parent()
        .ok_or_else(|| "WebView2 配置路径无效".to_owned())?;
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let contents = serde_json::to_vec(&target).map_err(|error| error.to_string())?;
    fs::write(target_path, contents).map_err(|error| error.to_string())?;
    Ok(imported)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{merge_hid_grants, validated_grants, HUB_PERMISSION_ORIGIN};

    fn source() -> serde_json::Value {
        json!({
            "last_modified": "13420995267850268",
            "setting": {
                "chosen-objects": [{
                    "name": "ATK A9",
                    "product-id": 4594,
                    "serial-number": "ABC",
                    "vendor-id": 14139
                }]
            }
        })
    }

    #[test]
    fn imports_only_valid_hid_grants() {
        let entry = json!({
            "setting": {
                "chosen-objects": [
                    {"name": "ATK A9", "product-id": 4594, "serial-number": "ABC", "vendor-id": 14139},
                    {"name": "", "product-id": 1, "serial-number": "ABC", "vendor-id": 2},
                    {"name": "invalid", "product-id": 99999, "serial-number": "ABC", "vendor-id": 2}
                ]
            }
        });
        assert_eq!(validated_grants(&entry).len(), 1);
    }

    #[test]
    fn merges_grants_idempotently() {
        let mut target = json!({});
        assert_eq!(merge_hid_grants(&source(), &mut target), 1);
        assert_eq!(merge_hid_grants(&source(), &mut target), 0);
        let entry = &target["profile"]["content_settings"]["exceptions"]["hid_chooser_data"]
            [HUB_PERMISSION_ORIGIN];
        assert_eq!(validated_grants(entry).len(), 1);
        assert_eq!(entry["last_modified"], "13420995267850268");
    }

    #[test]
    fn preserves_existing_grants() {
        let mut target = json!({
            "profile": {"content_settings": {"exceptions": {"hid_chooser_data": {
                (HUB_PERMISSION_ORIGIN): {
                    "setting": {"chosen-objects": [{
                        "name": "Existing",
                        "product-id": 2,
                        "serial-number": "XYZ",
                        "vendor-id": 1
                    }]}
                }
            }}}}
        });
        assert_eq!(merge_hid_grants(&source(), &mut target), 1);
        let entry = &target["profile"]["content_settings"]["exceptions"]["hid_chooser_data"]
            [HUB_PERMISSION_ORIGIN];
        assert_eq!(validated_grants(entry).len(), 2);
    }
}
