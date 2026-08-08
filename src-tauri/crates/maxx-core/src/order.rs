//! Port of `RuntimeContract.ordered` / `terminalEvents`: canonical replay
//! ordering. Sequence numbers are authoritative inside a turn; turn blocks are
//! ordered chronologically; duplicate event IDs keep the earliest occurrence.

use crate::contract::{ProviderRuntimeEvent, RuntimeEventKind};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

pub fn ordered(events: &[ProviderRuntimeEvent]) -> Vec<ProviderRuntimeEvent> {
    #[derive(PartialEq, Eq, Hash, Clone, Copy)]
    struct TurnKey {
        provider_instance_id: Uuid,
        thread_id: Uuid,
        turn_id: Uuid,
    }

    let mut turns: HashMap<TurnKey, Vec<ProviderRuntimeEvent>> = HashMap::new();
    for event in events {
        let key = TurnKey {
            provider_instance_id: event.provider_instance_id,
            thread_id: event.thread_id,
            turn_id: event.turn_id,
        };
        turns.entry(key).or_default().push(event.clone());
    }

    let mut blocks: Vec<(TurnKey, f64, Vec<ProviderRuntimeEvent>)> = turns
        .into_iter()
        .map(|(key, mut events)| {
            let min_date = events
                .iter()
                .map(|e| e.occurred_at.0)
                .fold(f64::INFINITY, f64::min);
            let min_date = if min_date.is_finite() {
                min_date
            } else {
                f64::NEG_INFINITY
            };
            events.sort_by(|a, b| {
                a.sequence
                    .cmp(&b.sequence)
                    .then_with(|| a.occurred_at.total_cmp(&b.occurred_at))
                    .then_with(|| a.id.to_string().cmp(&b.id.to_string()))
            });
            (key, min_date, events)
        })
        .collect();

    blocks.sort_by(|a, b| {
        a.1.total_cmp(&b.1)
            .then_with(|| a.0.thread_id.to_string().cmp(&b.0.thread_id.to_string()))
            .then_with(|| a.0.turn_id.to_string().cmp(&b.0.turn_id.to_string()))
            .then_with(|| {
                a.0.provider_instance_id
                    .to_string()
                    .cmp(&b.0.provider_instance_id.to_string())
            })
    });

    let mut seen: HashSet<Uuid> = HashSet::new();
    blocks
        .into_iter()
        .flat_map(|(_, _, events)| events)
        .filter(|event| seen.insert(event.id))
        .collect()
}

pub fn terminal_events(
    events: &[ProviderRuntimeEvent],
    turn_id: Uuid,
) -> Vec<ProviderRuntimeEvent> {
    events
        .iter()
        .filter(|e| e.turn_id == turn_id && e.kind.is(RuntimeEventKind::TURN_TERMINAL))
        .cloned()
        .collect()
}
