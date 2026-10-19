//! Loudness readings for the recorder's meter (M6 §2): RMS and peak of each
//! 50 ms window of samples.

/// One reading, both in 0.0–1.0 of full scale.
#[derive(Debug, Clone, Copy, PartialEq, Default, serde::Serialize)]
pub struct Level {
    pub rms: f32,
    pub peak: f32,
}

/// The level of `samples` (interleaved channels count alike).
pub fn level(samples: &[f32]) -> Level {
    let mut meter = Meter::new(samples.len());
    let mut out = Level::default();
    meter.push(samples, |l| out = l);
    out
}

/// Cuts a stream of samples into windows of `window` samples and reports each.
#[derive(Debug, Default)]
pub(crate) struct Meter {
    window: usize,
    sum_sq: f64,
    peak: f32,
    count: usize,
}

impl Meter {
    pub(crate) fn new(window: usize) -> Meter {
        Meter {
            window: window.max(1),
            ..Meter::default()
        }
    }

    pub(crate) fn push(&mut self, samples: &[f32], mut report: impl FnMut(Level)) {
        for &s in samples {
            let s = s.clamp(-1.0, 1.0);
            self.sum_sq += f64::from(s) * f64::from(s);
            self.peak = self.peak.max(s.abs());
            self.count += 1;
            if self.count == self.window {
                report(Level {
                    rms: (self.sum_sq / self.count as f64).sqrt() as f32,
                    peak: self.peak,
                });
                *self = Meter::new(self.window);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn m6_silence_reads_zero() {
        assert_eq!(
            level(&[0.0; 64]),
            Level {
                rms: 0.0,
                peak: 0.0
            }
        );
        assert_eq!(level(&[]), Level::default());
    }

    #[test]
    fn m6_a_full_scale_square_wave_reads_one() {
        let square: Vec<f32> = (0..64)
            .map(|i| if i % 2 == 0 { 1.0 } else { -1.0 })
            .collect();
        let l = level(&square);
        assert!(
            (l.rms - 1.0).abs() < 1e-6 && (l.peak - 1.0).abs() < 1e-6,
            "{l:?}"
        );
    }

    #[test]
    fn m6_the_meter_reports_once_per_full_window() {
        let mut meter = Meter::new(4);
        let mut seen = Vec::new();
        meter.push(&[0.5, -0.5, 0.5], |l| seen.push(l));
        assert!(seen.is_empty());
        meter.push(&[-0.5, 1.0, 0.0, 0.0, 0.0, 0.0], |l| seen.push(l));
        assert_eq!(seen.len(), 2);
        assert!((seen[0].rms - 0.5).abs() < 1e-6 && (seen[0].peak - 0.5).abs() < 1e-6);
        assert!((seen[1].peak - 1.0).abs() < 1e-6);
    }
}
