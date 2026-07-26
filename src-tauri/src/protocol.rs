use std::time::{Duration, Instant};

use hidapi::HidDevice;

const HID_READ_TIMEOUT_MS: i32 = 3000;
const HID_FAST_READ_TIMEOUT_MS: i32 = 220;
const COMPX_REPORT_ID: u8 = 8;
const HECHI_REPORT_ID: u8 = 11;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtocolKind {
    Compx,
    Hechi,
}

impl ProtocolKind {
    pub fn label(self) -> &'static str {
        match self {
            Self::Compx => "COMPX 直连",
            Self::Hechi => "HECHI 直连",
        }
    }
}

#[derive(Debug, Clone)]
pub struct BatteryReading {
    pub battery_percent: u8,
    pub charging: bool,
    pub charge_status: &'static str,
    pub protocol: ProtocolKind,
}

fn normalize_charge_state(
    battery_percent: u8,
    charging_flag: u8,
) -> Result<(u8, bool, &'static str), String> {
    if battery_percent > 100 {
        return Err("返回了无效电量".to_owned());
    }
    if charging_flag & 2 == 2 {
        return Ok((100, false, "full"));
    }
    if charging_flag & 1 != 0 {
        return Ok((battery_percent, true, "charging"));
    }
    Ok((battery_percent, false, "idle"))
}

fn normalized_report(report: &[u8], report_id: u8) -> &[u8] {
    if report.first() == Some(&report_id) {
        &report[1..]
    } else {
        report
    }
}

fn read_input_until(
    device: &HidDevice,
    report_id: u8,
    timeout_ms: i32,
    matcher: fn(&[u8]) -> bool,
) -> Result<Vec<u8>, String> {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms as u64);
    let mut buffer = [0u8; 128];
    while Instant::now() < deadline {
        let remaining = deadline.saturating_duration_since(Instant::now());
        let wait = remaining.as_millis().clamp(1, i32::MAX as u128) as i32;
        let length = device
            .read_timeout(&mut buffer, wait)
            .map_err(|error| error.to_string())?;
        if length == 0 {
            continue;
        }
        let data = normalized_report(&buffer[..length], report_id);
        if matcher(data) {
            return Ok(data.to_vec());
        }
    }
    Err("等待输入报告超时".to_owned())
}

fn by_output(
    device: &HidDevice,
    report_id: u8,
    request: &[u8],
    timeout_ms: i32,
    matcher: fn(&[u8]) -> bool,
) -> Result<Vec<u8>, String> {
    let mut payload = Vec::with_capacity(request.len() + 1);
    payload.push(report_id);
    payload.extend_from_slice(request);
    device.write(&payload).map_err(|error| error.to_string())?;
    read_input_until(device, report_id, timeout_ms, matcher)
}

fn by_feature(
    device: &HidDevice,
    report_id: u8,
    request: &[u8],
    feature_length: usize,
    matcher: fn(&[u8]) -> bool,
) -> Result<Vec<u8>, String> {
    let mut payload = Vec::with_capacity(request.len() + 1);
    payload.push(report_id);
    payload.extend_from_slice(request);
    device
        .send_feature_report(&payload)
        .map_err(|error| error.to_string())?;
    let mut response = vec![0u8; feature_length];
    response[0] = report_id;
    let length = device
        .get_feature_report(&mut response)
        .map_err(|error| error.to_string())?;
    let data = normalized_report(&response[..length], report_id);
    if matcher(data) {
        Ok(data.to_vec())
    } else {
        Err("Feature Report 返回内容不匹配".to_owned())
    }
}

fn exchange(
    device: &HidDevice,
    report_id: u8,
    request: &[u8],
    feature_length: usize,
    fast: bool,
    matcher: fn(&[u8]) -> bool,
) -> Result<Vec<u8>, String> {
    type Attempt<'a> = (&'a str, &'a dyn Fn() -> Result<Vec<u8>, String>);

    let timeout = if fast {
        HID_FAST_READ_TIMEOUT_MS
    } else {
        HID_READ_TIMEOUT_MS
    };
    let feature = || by_feature(device, report_id, request, feature_length, matcher);
    let output = || by_output(device, report_id, request, timeout, matcher);
    let attempts: [Attempt<'_>; 2] = if fast {
        [("Feature Report", &feature), ("Output Report", &output)]
    } else {
        [("Output Report", &output), ("Feature Report", &feature)]
    };
    let mut errors = Vec::new();
    for (label, read) in attempts {
        match read() {
            Ok(response) => return Ok(response),
            Err(error) => errors.push(format!("{label}: {error}")),
        }
    }
    Err(errors.join(" | "))
}

fn build_compx_request() -> [u8; 16] {
    let mut request = [0u8; 16];
    request[0] = 4;
    let sum = request[..15]
        .iter()
        .fold(COMPX_REPORT_ID, |sum, value| sum.wrapping_add(*value));
    request[15] = 85u8.wrapping_sub(sum);
    request
}

fn parse_compx(response: &[u8]) -> Result<BatteryReading, String> {
    if response.len() < 7 || response[0] != 4 {
        return Err("COMPX 返回内容不匹配".to_owned());
    }
    if response[1] == 255 {
        return Err("COMPX 返回失败状态".to_owned());
    }
    let (battery_percent, charging, charge_status) =
        normalize_charge_state(response[5], response[6])
            .map_err(|error| format!("COMPX {error}"))?;
    Ok(BatteryReading {
        battery_percent,
        charging,
        charge_status,
        protocol: ProtocolKind::Compx,
    })
}

fn read_compx(device: &HidDevice, fast: bool) -> Result<BatteryReading, String> {
    let request = build_compx_request();
    let response = exchange(device, COMPX_REPORT_ID, &request, 18, fast, |data| {
        data.len() >= 7 && data[0] == 4
    })?;
    parse_compx(&response)
}

fn parse_hechi(response: &[u8]) -> Result<BatteryReading, String> {
    if response.len() < 18 || response[0] != 19 {
        return Err("HECHI 返回内容不匹配".to_owned());
    }
    if response[2] == 255 {
        return Err("HECHI 返回失败状态".to_owned());
    }
    let (battery_percent, charging, charge_status) =
        normalize_charge_state(response[17], response[16])
            .map_err(|error| format!("HECHI {error}"))?;
    Ok(BatteryReading {
        battery_percent,
        charging,
        charge_status,
        protocol: ProtocolKind::Hechi,
    })
}

fn read_hechi(device: &HidDevice, fast: bool) -> Result<BatteryReading, String> {
    let mut request = [0u8; 63];
    request[0] = 19;
    let response = exchange(device, HECHI_REPORT_ID, &request, 65, fast, |data| {
        data.len() >= 18 && data[0] == 19
    })?;
    parse_hechi(&response)
}

pub fn read_battery(
    device: &HidDevice,
    preferred: Option<ProtocolKind>,
    allow_fallback: bool,
    fast: bool,
) -> Result<BatteryReading, String> {
    let protocols = match (preferred, allow_fallback) {
        (Some(ProtocolKind::Compx), false) => vec![ProtocolKind::Compx],
        (Some(ProtocolKind::Hechi), false) => vec![ProtocolKind::Hechi],
        (Some(ProtocolKind::Compx), true) => vec![ProtocolKind::Compx, ProtocolKind::Hechi],
        (Some(ProtocolKind::Hechi), true) => vec![ProtocolKind::Hechi, ProtocolKind::Compx],
        (None, _) => vec![ProtocolKind::Compx, ProtocolKind::Hechi],
    };
    let mut errors = Vec::new();
    for protocol in protocols {
        let result = match protocol {
            ProtocolKind::Compx => read_compx(device, fast),
            ProtocolKind::Hechi => read_hechi(device, fast),
        };
        match result {
            Ok(reading) => return Ok(reading),
            Err(error) => errors.push(format!("{}: {error}", protocol.label())),
        }
    }
    Err(if errors.is_empty() {
        "没有可用的直连协议".to_owned()
    } else {
        errors.join(" | ")
    })
}

pub fn is_protocol_failure(error: &str) -> bool {
    [
        "返回失败状态",
        "无效电量",
        "没有可用的直连协议",
        "unsupported",
        "not supported",
    ]
    .iter()
    .any(|needle| {
        error
            .to_ascii_lowercase()
            .contains(&needle.to_ascii_lowercase())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_charge_flags() {
        assert_eq!(normalize_charge_state(80, 1), Ok((80, true, "charging")));
        assert_eq!(normalize_charge_state(80, 2), Ok((100, false, "full")));
        assert!(normalize_charge_state(101, 0).is_err());
    }

    #[test]
    fn builds_compx_checksum() {
        let request = build_compx_request();
        let checksum = request[..15]
            .iter()
            .fold(COMPX_REPORT_ID, |sum, value| sum.wrapping_add(*value))
            .wrapping_add(request[15]);
        assert_eq!(request[0], 4);
        assert_eq!(checksum, 85);
    }

    #[test]
    fn parses_protocol_responses() {
        let mut compx = [0u8; 7];
        compx[0] = 4;
        compx[5] = 76;
        compx[6] = 1;
        let reading = parse_compx(&compx).unwrap();
        assert_eq!(reading.battery_percent, 76);
        assert!(reading.charging);

        let mut hechi = [0u8; 18];
        hechi[0] = 19;
        hechi[16] = 2;
        hechi[17] = 99;
        let reading = parse_hechi(&hechi).unwrap();
        assert_eq!(reading.battery_percent, 100);
        assert_eq!(reading.charge_status, "full");
    }

    #[test]
    fn rejects_invalid_protocol_responses() {
        assert!(parse_compx(&[4, 0]).is_err());
        let mut response = [0u8; 18];
        response[0] = 19;
        response[2] = 255;
        assert!(parse_hechi(&response).is_err());
    }
}
