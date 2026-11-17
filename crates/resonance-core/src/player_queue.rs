use crate::models::RepeatMode;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QueueStepResult {
    Index(usize),
    RepeatOne,
    EndShuffle,
}

pub const ERROR_ADVANCE_LIMIT: usize = 3;

pub fn should_advance_after_error(error_count: usize) -> bool {
    error_count < ERROR_ADVANCE_LIMIT
}

#[allow(clippy::too_many_arguments)]
pub fn step_queue_index<F>(
    queue: &[String],
    index: isize,
    dir: isize,
    auto: bool,
    repeat: RepeatMode,
    shuffle: bool,
    is_disliked: F,
    can_extend_shuffle: bool,
) -> Option<QueueStepResult>
where
    F: Fn(&str) -> bool,
{
    let n = queue.len();
    if n == 0 {
        return None;
    }
    if auto && repeat == RepeatMode::One {
        return Some(QueueStepResult::RepeatOne);
    }
    let mut i = index;
    for _ in 0..n {
        i += dir;
        if i >= n as isize {
            if shuffle && can_extend_shuffle {
                return Some(QueueStepResult::EndShuffle);
            }
            if auto && repeat == RepeatMode::Off {
                return None;
            }
            i = 0;
        }
        if i < 0 {
            i = n as isize - 1;
        }
        let idx = i as usize;
        if !is_disliked(&queue[idx]) {
            return Some(QueueStepResult::Index(idx));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_disliked_and_stops_at_end() {
        let q = vec!["a".into(), "b".into(), "c".into()];
        let r = step_queue_index(&q, 0, 1, true, RepeatMode::Off, false, |id| id == "b", false);
        assert_eq!(r, Some(QueueStepResult::Index(2)));
        let r2 = step_queue_index(&q, 2, 1, true, RepeatMode::Off, false, |_| false, false);
        assert_eq!(r2, None);
    }

    #[test]
    fn repeat_one_and_shuffle_extension() {
        let q = vec!["a".into(), "b".into()];
        assert_eq!(
            step_queue_index(&q, 0, 1, true, RepeatMode::One, false, |_| false, false),
            Some(QueueStepResult::RepeatOne)
        );
        assert_eq!(
            step_queue_index(&q, 1, 1, true, RepeatMode::Off, true, |_| false, true),
            Some(QueueStepResult::EndShuffle)
        );
    }
}
