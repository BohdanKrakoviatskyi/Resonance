use crate::models::CrossfadeCurve;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AutoCrossfadePlan {
    pub from_duration: f64,
    pub fade_sec: f64,
    pub start_fraction: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AutoCrossfadeDecision {
    pub should_preload: bool,
    pub should_start: bool,
}

pub fn ease_in_out_sine(x: f64) -> f64 {
    let c = x.clamp(0.0, 1.0);
    -((std::f64::consts::PI * c).cos() - 1.0) / 2.0
}

pub fn compute_crossfade_pair(progress: f64, curve: CrossfadeCurve) -> (f32, f32) {
    let t = progress.clamp(0.0, 1.0);
    match curve {
        CrossfadeCurve::Linear => ((1.0 - t) as f32, t as f32),
        CrossfadeCurve::EqualPower => {
            let angle = t * 0.5 * std::f64::consts::PI;
            (angle.cos() as f32, angle.sin() as f32)
        }
        CrossfadeCurve::SCurve => {
            let shaped = ease_in_out_sine(t);
            let angle = shaped * 0.5 * std::f64::consts::PI;
            (angle.cos() as f32, angle.sin() as f32)
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn evaluate_auto_crossfade_trigger(
    duration: f64,
    current_time: f64,
    fade_sec: f64,
    paused: bool,
    ended: bool,
    preloaded_already: bool,
    preparing_already: bool,
    preload_ahead_sec: f64,
) -> AutoCrossfadeDecision {
    if paused
        || ended
        || !duration.is_finite()
        || duration <= 0.0
        || !current_time.is_finite()
        || current_time < 1.0
        || fade_sec <= 0.0
    {
        return AutoCrossfadeDecision {
            should_preload: false,
            should_start: false,
        };
    }
    let remaining = duration - current_time;
    let should_preload = !preloaded_already
        && remaining > fade_sec + 0.5
        && remaining <= (fade_sec + 8.0).max(preload_ahead_sec);
    let should_start = !preparing_already && remaining > 0.25 && remaining <= fade_sec + 0.35;
    AutoCrossfadeDecision {
        should_preload,
        should_start,
    }
}

pub fn plan_auto_crossfade(
    base_fade_sec: f64,
    el_duration: f64,
    meta_duration: f64,
    current_time: f64,
) -> AutoCrossfadePlan {
    let valid_el = if el_duration.is_finite() && el_duration > 0.0 { el_duration } else { 0.0 };
    let valid_meta = if meta_duration.is_finite() && meta_duration > 0.0 { meta_duration } else { 0.0 };
    let from_duration = if valid_el > 0.0 && valid_meta > 0.0 && valid_el >= valid_meta * 1.7 {
        valid_meta
    } else if valid_el > 0.0 {
        valid_el
    } else {
        valid_meta
    };
    let remaining = if from_duration > 0.0 {
        (from_duration - current_time.max(0.0)).max(0.2)
    } else {
        base_fade_sec
    };
    let fade_sec = base_fade_sec.min(remaining).max(0.2);
    let start_fraction = if from_duration > 0.0 {
        (current_time / from_duration).clamp(0.05, 1.0)
    } else {
        0.92
    };
    AutoCrossfadePlan {
        from_duration,
        fade_sec,
        start_fraction,
    }
}

pub fn volume_to_pos(v: f32) -> f32 {
    v.clamp(0.0, 1.0).cbrt()
}

pub fn pos_to_volume(p: f32) -> f32 {
    let c = p.clamp(0.0, 1.0);
    c * c * c
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equal_power_has_constant_power_at_midpoint() {
        let (a, b) = compute_crossfade_pair(0.5, CrossfadeCurve::EqualPower);
        assert!(((a * a + b * b) - 1.0).abs() < 1e-5);
    }

    #[test]
    fn trigger_respects_windows() {
        let d = evaluate_auto_crossfade_trigger(120.0, 110.0, 4.0, false, false, false, false, 14.0);
        assert!(d.should_preload);
        assert!(!d.should_start);
        let d2 = evaluate_auto_crossfade_trigger(120.0, 116.2, 4.0, false, false, true, false, 14.0);
        assert!(d2.should_start);
    }
}
