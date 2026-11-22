use chrono::DateTime;

use crate::models::BatterySnapshot;

pub fn estimate_minutes(
    discharge: &mut Option<BatterySnapshot>,
    charge: &mut Option<BatterySnapshot>,
    sample: &BatterySnapshot,
    charging: bool,
    full: bool,
) -> Option<u32> {
    let percent = sample.percent;
    if full {
        *discharge = None;
        *charge = None;
        return None;
    }
    let (anchor, remaining, min_delta, min_minutes) = if charging {
        *discharge = None;
        (charge, 100 - percent, 2, 5)
    } else {
        *charge = None;
        (discharge, percent, 3, 30)
    };
    let anchor = anchor.get_or_insert_with(|| sample.clone());
    // 读数会有 ±1 抖动，只有越过锚点（放电时回升、充电时回落）才视为新周期。
    let reversed = if charging {
        percent < anchor.percent
    } else {
        percent > anchor.percent
    };
    let elapsed = DateTime::parse_from_rfc3339(&anchor.sampled_at)
        .ok()
        .and_then(|start| {
            DateTime::parse_from_rfc3339(&sample.sampled_at)
                .ok()
                .map(|now| (now - start).num_seconds())
        });
    if reversed || elapsed.is_none_or(|seconds| seconds < 0) {
        *anchor = sample.clone();
        return None;
    }
    let elapsed = elapsed?;
    let delta = if charging {
        percent.saturating_sub(anchor.percent)
    } else {
        anchor.percent.saturating_sub(percent)
    };
    if percent == 100 || delta < min_delta || elapsed < min_minutes * 60 {
        return None;
    }
    let denominator = 60 * i64::from(delta);
    let minutes = (i64::from(remaining) * elapsed + denominator / 2) / denominator;
    Some(minutes.min(999 * 60) as u32)
}

pub fn should_notify(alerted: &mut [bool; 2], percent: u8, powered: bool, enabled: bool) -> bool {
    let mut notify = false;
    for (sent, threshold) in alerted.iter_mut().zip([20, 10]) {
        if powered || percent >= threshold + 5 {
            *sent = false;
        } else if enabled && !*sent && percent <= threshold {
            *sent = true;
            notify = true;
        }
    }
    notify
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(percent: u8, minute: i64) -> BatterySnapshot {
        BatterySnapshot {
            percent,
            sampled_at: DateTime::from_timestamp(minute * 60, 0)
                .unwrap()
                .to_rfc3339(),
        }
    }

    #[test]
    fn discharge_requires_both_thresholds_and_resets_on_rebound() {
        let (mut d, mut c) = (None, None);
        for (percent, minute, expected) in [
            (80, 0, None),
            (77, 29, None),
            (77, 30, Some(770)),
            (78, 31, None),
            (76, 61, Some(1159)),
            (81, 62, None),
            (78, 92, Some(780)),
        ] {
            assert_eq!(
                estimate_minutes(
                    &mut d,
                    &mut c,
                    &sample(percent, minute),
                    false,
                    false
                ),
                expected
            );
        }
    }

    #[test]
    fn charge_and_discharge_have_separate_anchors() {
        let (mut d, mut c) = (Some(sample(90, 0)), None);
        for (percent, minute, charging, full, expected) in [
            (80, 30, true, false, None),
            (82, 34, true, false, None),
            (82, 35, true, false, Some(45)),
            (99, 70, false, true, None),
            (100, 71, false, false, None),
            (97, 101, false, false, Some(970)),
        ] {
            assert_eq!(
                estimate_minutes(
                    &mut d,
                    &mut c,
                    &sample(percent, minute),
                    charging,
                    full
                ),
                expected
            );
        }
    }

    #[test]
    fn long_discharge_is_capped_and_charging_at_100_has_no_estimate() {
        let (mut d, mut c) = (Some(sample(98, 0)), None);
        assert_eq!(
            estimate_minutes(&mut d, &mut c, &sample(95, 10_000), false, false),
            Some(999 * 60)
        );
        assert_eq!(
            estimate_minutes(&mut d, &mut c, &sample(95, 10_010), true, false),
            None
        );
        assert_eq!(
            estimate_minutes(&mut d, &mut c, &sample(96, 10_016), true, false),
            None
        );
        assert_eq!(
            estimate_minutes(&mut d, &mut c, &sample(100, 10_020), true, false),
            None
        );
    }

    #[test]
    fn notification_thresholds_rearm_independently() {
        let mut alerted = [false; 2];
        for (percent, powered, enabled, expected) in [
            (20, false, false, false),
            (20, false, true, true),
            (18, false, true, false),
            (10, false, true, true),
            (14, false, true, false),
            (10, false, true, false),
            (15, false, true, false),
            (10, false, true, true),
            (25, false, true, false),
            (8, false, true, true),
            (8, false, true, false),
            (8, true, false, false),
            (8, false, true, true),
        ] {
            assert_eq!(
                should_notify(&mut alerted, percent, powered, enabled),
                expected
            );
        }
    }
}
