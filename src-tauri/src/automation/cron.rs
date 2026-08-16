use jiff::{civil::DateTime, tz::TimeZone, Timestamp, ToSpan};
use serde::{Deserialize, Serialize};
use std::fmt;

use super::store::StoreError;

// The search advances at the coarsest field that cannot match. In particular,
// a sparse six-field expression never walks one second at a time across the
// whole search horizon. This guard is only a final protection against an
// invalid/unrepresentable civil-time sequence; ordinary searches terminate
// after a few thousand field jumps.
const MAX_SEARCH_ITERATIONS: usize = 1_000_000;
const MAX_SEARCH_YEARS: i64 = 8;

/// Parsed standard cron expression. Five fields are minute, hour, day of
/// month, month, day of week; six fields prepend seconds. Names are accepted
/// for months and weekdays (e.g. `MON-FRI`), and `*/n`, ranges, and lists are
/// supported. Day-of-month and day-of-week follow standard cron OR semantics
/// when both fields are restricted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CronExpression {
    source: String,
    seconds: Field,
    minutes: Field,
    hours: Field,
    days_of_month: Field,
    months: Field,
    days_of_week: Field,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Field {
    values: Vec<u8>,
    min: u8,
    max: u8,
    unrestricted: bool,
}

impl CronExpression {
    pub fn parse(expression: &str) -> Result<Self, StoreError> {
        let source = expression.trim();
        let parts: Vec<&str> = source.split_whitespace().collect();
        if parts.len() != 5 && parts.len() != 6 {
            return Err(StoreError::InvalidCron {
                expression: source.to_string(),
                reason: "expected five or six whitespace-separated fields".into(),
            });
        }
        let (seconds_text, fields) = if parts.len() == 6 {
            (parts[0], &parts[1..])
        } else {
            ("0", &parts[..])
        };
        Ok(Self {
            source: source.to_string(),
            seconds: parse_field(seconds_text, 0, 59, None)?,
            minutes: parse_field(fields[0], 0, 59, None)?,
            hours: parse_field(fields[1], 0, 23, None)?,
            days_of_month: parse_field(fields[2], 1, 31, None)?,
            months: parse_field(fields[3], 1, 12, Some(&MONTH_NAMES))?,
            days_of_week: parse_field(fields[4], 0, 7, Some(&WEEKDAY_NAMES))?,
        })
    }

    pub fn as_str(&self) -> &str {
        &self.source
    }

    fn matches(&self, dt: DateTime) -> bool {
        let month = dt.month() as u8;
        let day = dt.day() as u8;
        let weekday = dt.weekday().to_sunday_zero_offset() as u8;
        let weekday_alt = if weekday == 0 { 7 } else { weekday };
        let dom = self.days_of_month.contains(day);
        let dow = self.days_of_week.contains(weekday) || self.days_of_week.contains(weekday_alt);
        let day_matches = match (
            self.days_of_month.unrestricted,
            self.days_of_week.unrestricted,
        ) {
            (true, true) => true,
            (false, true) => dom,
            (true, false) => dow,
            (false, false) => dom || dow,
        };
        self.seconds.contains(dt.second() as u8)
            && self.minutes.contains(dt.minute() as u8)
            && self.hours.contains(dt.hour() as u8)
            && self.months.contains(month)
            && day_matches
    }
}

impl fmt::Display for CronExpression {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.source)
    }
}

impl std::str::FromStr for CronExpression {
    type Err = StoreError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::parse(value)
    }
}

const MONTH_NAMES: [(&str, u8); 12] = [
    ("JAN", 1),
    ("FEB", 2),
    ("MAR", 3),
    ("APR", 4),
    ("MAY", 5),
    ("JUN", 6),
    ("JUL", 7),
    ("AUG", 8),
    ("SEP", 9),
    ("OCT", 10),
    ("NOV", 11),
    ("DEC", 12),
];
const WEEKDAY_NAMES: [(&str, u8); 7] = [
    ("SUN", 0),
    ("MON", 1),
    ("TUE", 2),
    ("WED", 3),
    ("THU", 4),
    ("FRI", 5),
    ("SAT", 6),
];

fn parse_field(
    text: &str,
    min: u8,
    max: u8,
    names: Option<&[(&str, u8)]>,
) -> Result<Field, StoreError> {
    if text.is_empty() {
        return Err(invalid_field(text, "field is empty"));
    }
    let unrestricted = text == "*";
    let mut values = Vec::new();
    for item in text.split(',') {
        let (base, step) = item.split_once('/').map_or((item, 1), |(base, step)| {
            (base, step.parse::<u8>().unwrap_or(0))
        });
        if step == 0 {
            return Err(invalid_field(item, "step must be a positive integer"));
        }
        let (start, end) = if base == "*" {
            (min, max)
        } else if let Some((left, right)) = base.split_once('-') {
            (parse_value(left, names)?, parse_value(right, names)?)
        } else {
            let value = parse_value(base, names)?;
            // In cron, `5/10` means 5, 15, 25 ... through the field's
            // upper bound, not merely the singleton value 5.
            (value, if item.contains('/') { max } else { value })
        };
        if start < min || end > max || start > end {
            return Err(invalid_field(item, "value is outside the field range"));
        }
        values.extend((start..=end).step_by(step as usize));
    }
    values.sort_unstable();
    values.dedup();
    if values.is_empty() {
        return Err(invalid_field(text, "field has no values"));
    }
    Ok(Field {
        values,
        min,
        max,
        unrestricted,
    })
}

fn parse_value(text: &str, names: Option<&[(&str, u8)]>) -> Result<u8, StoreError> {
    if let Ok(value) = text.parse::<u8>() {
        return Ok(value);
    }
    let upper = text.to_ascii_uppercase();
    names
        .and_then(|values| {
            values
                .iter()
                .find(|(name, _)| *name == upper)
                .map(|(_, v)| *v)
        })
        .ok_or_else(|| invalid_field(text, "expected an integer or supported name"))
}

fn invalid_field(field: &str, reason: &str) -> StoreError {
    StoreError::InvalidCron {
        expression: field.to_string(),
        reason: reason.to_string(),
    }
}

/// Calculate the next matching instant strictly after `after_ms`.
pub fn next_cron_run_ms(
    expression: &CronExpression,
    after_ms: i64,
    timezone: &str,
) -> Result<Option<i64>, StoreError> {
    let tz = TimeZone::get(timezone).map_err(|error| StoreError::InvalidTimezone {
        timezone: timezone.to_string(),
        reason: error.to_string(),
    })?;
    let after =
        Timestamp::from_millisecond(after_ms).map_err(|error| StoreError::InvalidTimestamp {
            value: after_ms.to_string(),
            reason: error.to_string(),
        })?;
    let zoned = after.to_zoned(tz.clone());
    let has_seconds = expression.seconds.values != [0];
    let mut candidate = zoned.datetime();
    candidate = candidate
        .with()
        .nanosecond(0)
        .second(if has_seconds { candidate.second() } else { 0 })
        .build()
        .map_err(|error| StoreError::TimeCalculation(error.to_string()))?;
    let step = if has_seconds { 1.second() } else { 1.minute() };
    candidate = candidate
        .checked_add(step)
        .map_err(|error| StoreError::TimeCalculation(error.to_string()))?;
    let max_candidate = candidate
        .checked_add(MAX_SEARCH_YEARS.years())
        .map_err(|error| StoreError::TimeCalculation(error.to_string()))?;

    for _ in 0..MAX_SEARCH_ITERATIONS {
        if candidate > max_candidate {
            return Ok(None);
        }
        // Skip whole civil-time units as soon as a higher-order field cannot
        // match. This is what keeps e.g. `0 0 0 1 1 *` bounded by years, not
        // by the number of seconds in those years.
        if !expression.months.contains(candidate.month() as u8) {
            candidate = next_month(candidate, &expression.months)?;
            continue;
        }
        if !expression.matches_day(candidate) {
            candidate = next_day(candidate)?;
            continue;
        }
        if !expression.hours.contains(candidate.hour() as u8) {
            candidate = next_hour(candidate, &expression.hours)?;
            continue;
        }
        if !expression.minutes.contains(candidate.minute() as u8) {
            candidate = next_minute(candidate, &expression.minutes)?;
            continue;
        }
        if !expression.seconds.contains(candidate.second() as u8) {
            candidate = next_second(candidate, &expression.seconds)?;
            continue;
        }
        if expression.matches(candidate) {
            let resolved = candidate
                .to_zoned(tz.clone())
                .map_err(|error| StoreError::TimeCalculation(error.to_string()))?;
            let timestamp = resolved.timestamp().as_millisecond();
            if timestamp > after_ms {
                return Ok(Some(timestamp));
            }
        }
        candidate = candidate
            .checked_add(step)
            .map_err(|error| StoreError::TimeCalculation(error.to_string()))?;
    }
    Ok(None)
}

impl CronExpression {
    fn matches_day(&self, dt: DateTime) -> bool {
        let day = dt.day() as u8;
        let weekday = dt.weekday().to_sunday_zero_offset() as u8;
        let weekday_alt = if weekday == 0 { 7 } else { weekday };
        let dom = self.days_of_month.contains(day);
        let dow = self.days_of_week.contains(weekday) || self.days_of_week.contains(weekday_alt);
        match (
            self.days_of_month.unrestricted,
            self.days_of_week.unrestricted,
        ) {
            (true, true) => true,
            (false, true) => dom,
            (true, false) => dow,
            (false, false) => dom || dow,
        }
    }
}

fn next_month(candidate: DateTime, months: &Field) -> Result<DateTime, StoreError> {
    let next = months
        .values
        .iter()
        .copied()
        .find(|month| *month > candidate.month() as u8);
    let (year, month) = match next {
        Some(month) => (candidate.year(), month),
        None => (
            candidate
                .year()
                .checked_add(1)
                .ok_or_else(|| StoreError::TimeCalculation("year overflow".into()))?,
            months.values[0],
        ),
    };
    candidate
        .with()
        .year(year)
        .month(month as i8)
        .day(1)
        .hour(0)
        .minute(0)
        .second(0)
        .nanosecond(0)
        .build()
        .map_err(|error| StoreError::TimeCalculation(error.to_string()))
}

fn next_day(candidate: DateTime) -> Result<DateTime, StoreError> {
    candidate
        .checked_add(1.day())
        .map_err(|error| StoreError::TimeCalculation(error.to_string()))?
        .with()
        .hour(0)
        .minute(0)
        .second(0)
        .nanosecond(0)
        .build()
        .map_err(|error| StoreError::TimeCalculation(error.to_string()))
}

fn next_hour(candidate: DateTime, hours: &Field) -> Result<DateTime, StoreError> {
    let next = hours
        .values
        .iter()
        .copied()
        .find(|hour| *hour > candidate.hour() as u8);
    match next {
        Some(hour) => candidate
            .with()
            .hour(hour as i8)
            .minute(0)
            .second(0)
            .nanosecond(0)
            .build()
            .map_err(|error| StoreError::TimeCalculation(error.to_string())),
        None => next_day(candidate)?
            .with()
            .hour(hours.values[0] as i8)
            .build()
            .map_err(|error| StoreError::TimeCalculation(error.to_string())),
    }
}

fn next_minute(candidate: DateTime, minutes: &Field) -> Result<DateTime, StoreError> {
    let next = minutes
        .values
        .iter()
        .copied()
        .find(|minute| *minute > candidate.minute() as u8);
    match next {
        Some(minute) => candidate
            .with()
            .minute(minute as i8)
            .second(0)
            .nanosecond(0)
            .build()
            .map_err(|error| StoreError::TimeCalculation(error.to_string())),
        None => next_hour(candidate, &Field::all(0, 23))?
            .with()
            .minute(minutes.values[0] as i8)
            .build()
            .map_err(|error| StoreError::TimeCalculation(error.to_string())),
    }
}

fn next_second(candidate: DateTime, seconds: &Field) -> Result<DateTime, StoreError> {
    let next = seconds
        .values
        .iter()
        .copied()
        .find(|second| *second > candidate.second() as u8);
    match next {
        Some(second) => candidate
            .with()
            .second(second as i8)
            .nanosecond(0)
            .build()
            .map_err(|error| StoreError::TimeCalculation(error.to_string())),
        None => candidate
            .checked_add(1.minute())
            .map_err(|error| StoreError::TimeCalculation(error.to_string()))?
            .with()
            .second(seconds.values[0] as i8)
            .nanosecond(0)
            .build()
            .map_err(|error| StoreError::TimeCalculation(error.to_string())),
    }
}

impl Field {
    fn contains(&self, value: u8) -> bool {
        self.values.binary_search(&value).is_ok()
    }

    fn all(min: u8, max: u8) -> Self {
        Self {
            values: (min..=max).collect(),
            min,
            max,
            unrestricted: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(value: &str) -> i64 {
        value.parse::<Timestamp>().unwrap().as_millisecond()
    }

    #[test]
    fn parses_standard_lists_ranges_steps_and_names() {
        let cron = CronExpression::parse("*/15 9-17 * JAN,MAR MON-FRI").unwrap();
        assert_eq!(cron.minutes.values, vec![0, 15, 30, 45]);
        assert_eq!(cron.hours.values, (9..=17).collect::<Vec<_>>());
        assert_eq!(cron.months.values, vec![1, 3]);
        assert_eq!(cron.days_of_week.values, vec![1, 2, 3, 4, 5]);

        let stepped = CronExpression::parse("5/10 * * * *").unwrap();
        assert_eq!(stepped.minutes.values, vec![5, 15, 25, 35, 45, 55]);
    }

    #[test]
    fn computes_next_run_in_iana_zone() {
        let cron = CronExpression::parse("0 9 * * 1-5").unwrap();
        let after = ms("2024-01-05T14:00:00Z");
        let next = next_cron_run_ms(&cron, after, "America/New_York")
            .unwrap()
            .unwrap();
        assert_eq!(
            Timestamp::from_millisecond(next).unwrap().to_string(),
            "2024-01-08T14:00:00Z"
        );
    }

    #[test]
    fn sparse_six_field_expression_jumps_over_years() {
        let cron = CronExpression::parse("0 0 0 1 1 *").unwrap();
        let after = ms("2024-01-02T00:00:00Z");
        let next = next_cron_run_ms(&cron, after, "UTC").unwrap().unwrap();
        assert_eq!(
            Timestamp::from_millisecond(next).unwrap().to_string(),
            "2025-01-01T00:00:00Z"
        );
    }

    #[test]
    fn skips_spring_forward_gap_with_compatible_timezone_resolution() {
        let cron = CronExpression::parse("30 2 * * *").unwrap();
        let after = ms("2024-03-10T06:00:00Z");
        let next = next_cron_run_ms(&cron, after, "America/New_York")
            .unwrap()
            .unwrap();
        // Jiff's compatible resolution advances the nonexistent 02:30 local
        // time to the first valid instant after the DST gap.
        assert_eq!(
            Timestamp::from_millisecond(next).unwrap().to_string(),
            "2024-03-10T07:30:00Z"
        );
    }

    #[test]
    fn fallback_fold_runs_once_using_compatible_earlier_occurrence() {
        let cron = CronExpression::parse("30 1 * * *").unwrap();
        let before_fold = ms("2024-11-03T04:00:00Z");
        let first = next_cron_run_ms(&cron, before_fold, "America/New_York")
            .unwrap()
            .unwrap();
        assert_eq!(
            Timestamp::from_millisecond(first).unwrap().to_string(),
            "2024-11-03T05:30:00Z"
        );

        // Jiff's compatible resolution chooses one side of an ambiguous local
        // time. Maxx therefore executes one wall-clock occurrence, rather than
        // delivering the same cron event twice during the fall-back fold.
        let after_first = ms("2024-11-03T05:45:00Z");
        let next = next_cron_run_ms(&cron, after_first, "America/New_York")
            .unwrap()
            .unwrap();
        assert_eq!(
            Timestamp::from_millisecond(next).unwrap().to_string(),
            "2024-11-04T06:30:00Z"
        );
    }
}
