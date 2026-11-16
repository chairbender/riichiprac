//! Optional, versioned Q→point calibration (L2).
//!
//! Mortal's per-action Q values are **model utility**, not mahjong points: the
//! network is trained on a kyoku reward/rank utility controlled by `gamma`/`pts`,
//! and its own examples are values like `-1.19`, `-1.56`. A Q gap therefore
//! cannot be quoted as "about 400 points" without a fitted mapping
//! (replay-strategy §6.5.2, replay-implementation-plan §8 risk 6).
//!
//! This module is the **hook**, not a calibration. It defines:
//!
//! - [`QPointCalibration`], a separate versioned document
//!   (`riichiprac.q-point-calibration` v1) holding a monotone piecewise-linear
//!   mapping from a Q gap to an expected point difference, with its id, fit
//!   method and provenance;
//! - [`ExpectedPointDiffs`], the separate field a calibrated label carries. The
//!   raw `q_values`, the ranking and every Q gap stay exactly as the model
//!   produced them: a calibration is applied **beside** them, never over them;
//! - [`ModelLabel::apply_calibration`], which derives the point estimates from
//!   the stored Q values (so a cached label can be calibrated without a forward
//!   pass and a recalibration never invalidates the cache).
//!
//! No calibration ships with the app, and no field claims points unless the
//! caller explicitly applied one. The mapping clamps at its last breakpoint
//! rather than extrapolating beyond the range it was fitted on; a Q gap outside
//! the calibration's data must not silently become an invented number.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::ModelLabel;

/// Schema name for a Q→point calibration document.
pub const CALIBRATION_SCHEMA: &str = "riichiprac.q-point-calibration";

/// Schema version this build reads. A reader rejects any other version rather
/// than guessing what changed.
pub const CALIBRATION_VERSION: u32 = 1;

/// Units of a calibrated difference.
pub const POINT_UNITS: &str = "points";

/// Note carried in every [`ExpectedPointDiffs`].
pub const CALIBRATION_NOTE: &str = "Point estimates come from a versioned Q→point calibration; the raw Q values are unchanged \
     and are model utility, not points.";

/// A Q→point calibration failure: an unreadable file, a document this build
/// does not understand, or a label that cannot be calibrated.
#[derive(Debug, Error)]
pub enum CalibrationError {
    /// The calibration file could not be read.
    #[error("cannot read calibration `{path}`: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    /// The calibration file is not valid JSON for the document.
    #[error("calibration JSON error: {0}")]
    Json(#[from] serde_json::Error),
    /// The document names another schema.
    #[error("calibration schema is `{found}`, expected `{expected}`")]
    Schema {
        found: String,
        expected: &'static str,
    },
    /// The document is a version this build does not read.
    #[error("calibration version {found} is not supported (this build reads {supported})")]
    Version { found: u32, supported: u32 },
    /// The units are not model utility → points.
    #[error(
        "calibration units are q=`{q_units}`, points=`{point_units}`; \
         expected `model_utility` and `points`"
    )]
    Units {
        q_units: String,
        point_units: String,
    },
    /// The calibration has no id to record on a label.
    #[error("calibration id is empty")]
    EmptyId,
    /// A mapping needs at least one segment.
    #[error("calibration needs at least two breakpoints, found {found}")]
    TooFewBreakpoints { found: usize },
    /// A breakpoint value is not finite.
    #[error("calibration breakpoint {index} is not finite")]
    NonFinite { index: usize },
    /// A Q gap cannot be negative.
    #[error("calibration breakpoint {index} has a negative Q gap ({q_gap})")]
    NegativeGap { index: usize, q_gap: f32 },
    /// Q gaps must strictly increase so the mapping is a function.
    #[error("calibration breakpoints are not strictly increasing at index {index}")]
    NotIncreasing { index: usize },
    /// Point differences must not decrease: more utility is never worth fewer
    /// points.
    #[error("calibration point differences decrease at index {index}")]
    NotMonotone { index: usize },
    /// A difference mapping must pass through (0, 0).
    #[error(
        "calibration must start at Q gap 0 with a 0-point difference, found ({q_gap}, {point_diff})"
    )]
    NotAnchored { q_gap: f32, point_diff: f32 },
    /// A label without raw Q values cannot be calibrated.
    #[error("a label with no raw Q values cannot be calibrated")]
    NoQValues,
}

/// One breakpoint of the piecewise-linear mapping.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CalibrationBreakpoint {
    /// A non-negative Q gap (`q(best) - q(action)`), in model-utility units.
    pub q_gap: f32,
    /// The expected point difference for that gap.
    pub point_diff: f32,
}

/// A versioned mapping from a Q gap to an expected point difference.
///
/// The document is deliberately separate from a label and separate from the
/// model: recalibrating does not touch the checkpoint, the Q values or the
/// cache. Fit provenance (`method`, `fitted_at`, `source`) is required so a
/// point estimate can be traced back to how it was produced.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QPointCalibration {
    /// `riichiprac.q-point-calibration`.
    pub schema: String,
    /// Document version; a reader supports exactly [`CALIBRATION_VERSION`].
    pub version: u32,
    /// Stable id recorded on every label that uses this mapping.
    pub calibration_id: String,
    /// How the mapping was fitted, e.g. `piecewise-linear least squares on
    /// self-play outcomes`.
    pub method: String,
    /// When the fit was produced (RFC 3339), for provenance.
    pub fitted_at: String,
    /// Where the fit data came from, for provenance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// Units of the input gap. Must be `model_utility`.
    pub q_units: String,
    /// Units of the output difference. Must be `points`.
    pub point_units: String,
    /// Breakpoints, strictly increasing in `q_gap` and non-decreasing in
    /// `point_diff`, anchored at `(0, 0)`.
    pub breakpoints: Vec<CalibrationBreakpoint>,
}

impl QPointCalibration {
    /// Read and validate a calibration document from disk.
    pub fn read(path: &Path) -> Result<Self, CalibrationError> {
        let text = std::fs::read_to_string(path).map_err(|source| CalibrationError::Io {
            path: path.display().to_string(),
            source,
        })?;
        let calibration: Self = serde_json::from_str(&text)?;
        calibration.validate()?;
        Ok(calibration)
    }

    /// Parse and validate a calibration document from a JSON string.
    pub fn from_json(text: &str) -> Result<Self, CalibrationError> {
        let calibration: Self = serde_json::from_str(text)?;
        calibration.validate()?;
        Ok(calibration)
    }

    /// Check every invariant this build depends on.
    pub fn validate(&self) -> Result<(), CalibrationError> {
        if self.schema != CALIBRATION_SCHEMA {
            return Err(CalibrationError::Schema {
                found: self.schema.clone(),
                expected: CALIBRATION_SCHEMA,
            });
        }
        if self.version != CALIBRATION_VERSION {
            return Err(CalibrationError::Version {
                found: self.version,
                supported: CALIBRATION_VERSION,
            });
        }
        if self.q_units != super::Q_UNITS || self.point_units != POINT_UNITS {
            return Err(CalibrationError::Units {
                q_units: self.q_units.clone(),
                point_units: self.point_units.clone(),
            });
        }
        if self.calibration_id.trim().is_empty() {
            return Err(CalibrationError::EmptyId);
        }
        if self.breakpoints.len() < 2 {
            return Err(CalibrationError::TooFewBreakpoints {
                found: self.breakpoints.len(),
            });
        }
        let first = self.breakpoints[0];
        if first.q_gap != 0.0 || first.point_diff != 0.0 {
            return Err(CalibrationError::NotAnchored {
                q_gap: first.q_gap,
                point_diff: first.point_diff,
            });
        }
        for (index, point) in self.breakpoints.iter().enumerate() {
            if !point.q_gap.is_finite() || !point.point_diff.is_finite() {
                return Err(CalibrationError::NonFinite { index });
            }
            if point.q_gap < 0.0 {
                return Err(CalibrationError::NegativeGap {
                    index,
                    q_gap: point.q_gap,
                });
            }
            if index == 0 {
                continue;
            }
            let previous = self.breakpoints[index - 1];
            if point.q_gap <= previous.q_gap {
                return Err(CalibrationError::NotIncreasing { index });
            }
            if point.point_diff < previous.point_diff {
                return Err(CalibrationError::NotMonotone { index });
            }
        }
        Ok(())
    }

    /// Map one Q gap to an expected point difference.
    ///
    /// Negative gaps clamp to the anchor; gaps past the last breakpoint clamp to
    /// the last fitted value instead of extrapolating beyond the calibration's
    /// data. Callers should not present a clamped estimate as if it were inside
    /// the fitted range.
    #[must_use]
    pub fn estimate(&self, q_gap: f32) -> f32 {
        let Some(first) = self.breakpoints.first() else {
            return 0.0;
        };
        if !q_gap.is_finite() || q_gap <= first.q_gap {
            return first.point_diff;
        }
        for window in self.breakpoints.windows(2) {
            let (low, high) = (window[0], window[1]);
            if q_gap <= high.q_gap {
                let span = high.q_gap - low.q_gap;
                if span <= 0.0 {
                    return high.point_diff;
                }
                let fraction = (q_gap - low.q_gap) / span;
                return low.point_diff + fraction * (high.point_diff - low.point_diff);
            }
        }
        self.breakpoints
            .last()
            .map_or(0.0, |point| point.point_diff)
    }
}

/// Point estimates derived from a calibration, kept beside the raw Q values.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExpectedPointDiffs {
    /// The calibration this was derived from.
    pub calibration_id: String,
    /// The calibration document's schema version.
    pub calibration_version: u32,
    /// Units of [`Self::diffs`]; always [`POINT_UNITS`].
    pub point_units: String,
    /// Expected point difference per action, keyed like `q_values`.
    ///
    /// The best action's entry is `0.0` (a gap of zero maps to the anchor); a
    /// larger Q gap can never map to a smaller point difference.
    pub diffs: BTreeMap<String, f32>,
    /// Unit/provenance reminder carried in the payload itself.
    pub note: String,
}

impl ModelLabel {
    /// Attach point estimates from a calibration without touching the Q values.
    ///
    /// The estimate for each action is `calibration.estimate(q(best) - q(action))`
    /// using the stored [`Self::q_values`]. The raw map, the ranking, the Q gaps
    /// and the book half are left exactly as they were.
    ///
    /// Calibration is deliberately not part of the cache key: it is a pure
    /// function of the cached Q values, so a cached label can be recalibrated
    /// without re-running the model, and changing the calibration never
    /// invalidates a cached evaluation.
    pub fn apply_calibration(
        &mut self,
        calibration: &QPointCalibration,
    ) -> Result<(), CalibrationError> {
        calibration.validate()?;
        if self.q_values.is_empty() {
            return Err(CalibrationError::NoQValues);
        }
        let top_q = self
            .q_values
            .get(&self.top_action)
            .copied()
            .unwrap_or_else(|| {
                self.q_values
                    .values()
                    .copied()
                    .fold(f32::NEG_INFINITY, f32::max)
            });
        let diffs = self
            .q_values
            .iter()
            .map(|(action, q)| {
                let gap = (top_q - q).max(0.0);
                (action.clone(), calibration.estimate(gap))
            })
            .collect();
        self.calibration_version = Some(calibration.calibration_id.clone());
        self.expected_point_diffs = Some(ExpectedPointDiffs {
            calibration_id: calibration.calibration_id.clone(),
            calibration_version: calibration.version,
            point_units: POINT_UNITS.to_string(),
            diffs,
            note: CALIBRATION_NOTE.to_string(),
        });
        Ok(())
    }

    /// Drop any calibrated point estimates, leaving the raw Q values intact.
    pub fn clear_calibration(&mut self) {
        self.calibration_version = None;
        self.expected_point_diffs = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn calibration() -> QPointCalibration {
        QPointCalibration {
            schema: CALIBRATION_SCHEMA.to_string(),
            version: CALIBRATION_VERSION,
            calibration_id: "test-calibration-2026-11".to_string(),
            method: "piecewise-linear test fixture".to_string(),
            fitted_at: "2026-11-16T00:00:00Z".to_string(),
            source: None,
            q_units: super::super::Q_UNITS.to_string(),
            point_units: POINT_UNITS.to_string(),
            breakpoints: vec![
                CalibrationBreakpoint {
                    q_gap: 0.0,
                    point_diff: 0.0,
                },
                CalibrationBreakpoint {
                    q_gap: 0.5,
                    point_diff: 1_000.0,
                },
                CalibrationBreakpoint {
                    q_gap: 2.0,
                    point_diff: 8_000.0,
                },
            ],
        }
    }

    fn label_with_q_values() -> ModelLabel {
        let mut label = ModelLabel {
            schema: crate::miner::MODEL_LABEL_SCHEMA.to_string(),
            version: crate::miner::JSON_SCHEMA_VERSION,
            classifier_version: super::super::CLASSIFIER_VERSION.to_string(),
            model: "mortal_298k.safetensors".to_string(),
            model_sha256: "a".repeat(64),
            gamma: None,
            pts: None,
            q_units: super::super::Q_UNITS.to_string(),
            value_units: super::super::VALUE_UNITS.to_string(),
            expected_value: 0.0,
            top_action: "Discard_1z".to_string(),
            top_probability: 0.6,
            probability_margin: 0.3,
            q_gap_top2: Some(0.25),
            q_gap_safe: None,
            safe_action: None,
            riichi_discard: None,
            ranking: Vec::new(),
            q_values: BTreeMap::new(),
            book: None,
            book_conflict: None,
            consensus: None,
            generator: None,
            note: super::super::Q_UNITS_NOTE.to_string(),
            label_kind: None,
            stability: None,
            calibration_version: None,
            expected_point_diffs: None,
        };
        label.q_values.insert("Discard_1z".to_string(), -0.10);
        label.q_values.insert("Discard_5m".to_string(), -0.35);
        label.q_values.insert("Discard_9p".to_string(), -1.10);
        label
    }

    #[test]
    fn an_uncalibrated_label_has_no_point_fields() {
        let label = label_with_q_values();
        let json = serde_json::to_value(&label).expect("label serializes");
        assert!(json.get("expected_point_diffs").is_none());
        assert!(json.get("calibration_version").is_none());
        assert_eq!(json["q_units"], "model_utility");
        assert!(label.expected_point_diffs.is_none());
        assert!(label.calibration_version.is_none());
    }

    #[test]
    fn calibration_adds_point_estimates_and_leaves_the_raw_q_values_alone() {
        let mut label = label_with_q_values();
        let raw = label.q_values.clone();
        let calibration = calibration();
        label.apply_calibration(&calibration).expect("calibrates");

        assert_eq!(
            label.q_values, raw,
            "the calibration must never overwrite the Q values"
        );
        assert_eq!(
            label.calibration_version.as_deref(),
            Some("test-calibration-2026-11")
        );
        let diffs = label.expected_point_diffs.as_ref().expect("point diffs");
        assert_eq!(diffs.point_units, "points");
        assert_eq!(diffs.calibration_version, CALIBRATION_VERSION);
        assert_eq!(diffs.diffs["Discard_1z"], 0.0);
        // q gap 0.25 is halfway across the (0,0)-(0.5,1000) segment.
        assert!((diffs.diffs["Discard_5m"] - 500.0).abs() < 1e-3);
        // q gap 1.0 is 1/3 across the (0.5,1000)-(2.0,8000) segment.
        assert!((diffs.diffs["Discard_9p"] - (1_000.0 + 7_000.0 / 3.0)).abs() < 1e-2);

        let json = serde_json::to_value(&label).expect("label serializes");
        assert_eq!(json["q_units"], "model_utility");
        assert_eq!(json["expected_point_diffs"]["point_units"], "points");
        assert!(
            json["expected_point_diffs"]["note"]
                .as_str()
                .expect("note")
                .contains("model utility")
        );
        assert!((json["q_values"]["Discard_5m"].as_f64().expect("q value") + 0.35).abs() < 1e-6);

        // Clearing returns the label to its raw form.
        let mut cleared = label.clone();
        cleared.clear_calibration();
        assert!(cleared.expected_point_diffs.is_none());
        assert_eq!(cleared.q_values, raw);
    }

    #[test]
    fn the_mapping_clamps_instead_of_extrapolating() {
        let calibration = calibration();
        assert_eq!(calibration.estimate(-1.0), 0.0);
        assert_eq!(calibration.estimate(0.0), 0.0);
        assert_eq!(calibration.estimate(99.0), 8_000.0);
        assert!(calibration.estimate(f32::NAN).is_finite());
    }

    #[test]
    fn a_label_without_q_values_cannot_be_calibrated() {
        let mut label = label_with_q_values();
        label.q_values.clear();
        let error = label
            .apply_calibration(&calibration())
            .expect_err("no Q values");
        assert!(matches!(error, CalibrationError::NoQValues));
    }

    #[test]
    fn calibration_documents_are_versioned_and_validated() {
        let good = calibration();
        good.validate().expect("the fixture is valid");
        let json = serde_json::to_string(&good).expect("serializes");
        let parsed = QPointCalibration::from_json(&json).expect("round-trips");
        assert_eq!(parsed, good);

        let mut wrong_schema = good.clone();
        wrong_schema.schema = "something-else".to_string();
        assert!(matches!(
            wrong_schema.validate(),
            Err(CalibrationError::Schema { .. })
        ));

        let mut wrong_version = good.clone();
        wrong_version.version = 99;
        assert!(matches!(
            wrong_version.validate(),
            Err(CalibrationError::Version { .. })
        ));

        let mut wrong_units = good.clone();
        wrong_units.q_units = "points".to_string();
        assert!(matches!(
            wrong_units.validate(),
            Err(CalibrationError::Units { .. })
        ));

        let mut empty_id = good.clone();
        empty_id.calibration_id.clear();
        assert!(matches!(
            empty_id.validate(),
            Err(CalibrationError::EmptyId)
        ));

        let mut too_few = good.clone();
        too_few.breakpoints.truncate(1);
        assert!(matches!(
            too_few.validate(),
            Err(CalibrationError::TooFewBreakpoints { .. })
        ));

        let mut not_anchored = good.clone();
        not_anchored.breakpoints[0].point_diff = 5.0;
        assert!(matches!(
            not_anchored.validate(),
            Err(CalibrationError::NotAnchored { .. })
        ));

        let mut not_increasing = good.clone();
        not_increasing.breakpoints[2].q_gap = not_increasing.breakpoints[1].q_gap;
        assert!(matches!(
            not_increasing.validate(),
            Err(CalibrationError::NotIncreasing { .. })
        ));

        let mut not_monotone = good.clone();
        not_monotone.breakpoints[2].point_diff = 500.0;
        assert!(matches!(
            not_monotone.validate(),
            Err(CalibrationError::NotMonotone { .. })
        ));

        let mut negative = good.clone();
        negative.breakpoints.insert(
            1,
            CalibrationBreakpoint {
                q_gap: -0.1,
                point_diff: -1.0,
            },
        );
        assert!(matches!(
            negative.validate(),
            Err(CalibrationError::NotMonotone { .. }) | Err(CalibrationError::NegativeGap { .. })
        ));
    }

    #[test]
    fn a_calibration_file_is_read_and_validated() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("calibration.json");
        std::fs::write(&path, serde_json::to_string(&calibration()).expect("json")).expect("write");
        assert_eq!(
            QPointCalibration::read(&path).expect("reads"),
            calibration()
        );

        std::fs::write(&path, "{not json").expect("write");
        assert!(matches!(
            QPointCalibration::read(&path),
            Err(CalibrationError::Json(_))
        ));

        assert!(matches!(
            QPointCalibration::read(&dir.path().join("missing.json")),
            Err(CalibrationError::Io { .. })
        ));

        let mut wrong = calibration();
        wrong.version = 7;
        std::fs::write(&path, serde_json::to_string(&wrong).expect("json")).expect("write");
        assert!(matches!(
            QPointCalibration::read(&path),
            Err(CalibrationError::Version { .. })
        ));
    }

    #[test]
    fn applying_the_same_calibration_twice_is_deterministic() {
        let mut label = label_with_q_values();
        let calibration = calibration();
        label.apply_calibration(&calibration).expect("first");
        let first = label.expected_point_diffs.clone();
        label.apply_calibration(&calibration).expect("second");
        assert_eq!(label.expected_point_diffs, first);
    }
}
