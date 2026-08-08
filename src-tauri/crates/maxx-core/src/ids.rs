//! Bit-for-bit port of `RuntimeStableID` (FNV-1a over "namespace:value").
//! Replayed native request IDs must map to the same UUIDs the Swift app produced.

use uuid::Uuid;

const FORWARD_SEED: u64 = 0xcbf2_9ce4_8422_2325;
const REVERSE_SEED: u64 = 0x8422_2325_cbf2_9ce4;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

pub fn stable_uuid(namespace: &str, value: &str) -> Uuid {
    let input = format!("{namespace}:{value}").into_bytes();
    let high = fnv1a(input.iter().copied(), FORWARD_SEED);
    let low = fnv1a(input.iter().rev().copied(), REVERSE_SEED);
    Uuid::from_u64_pair(high, low)
}

fn fnv1a(bytes: impl Iterator<Item = u8>, seed: u64) -> u64 {
    bytes.fold(seed, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(FNV_PRIME)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_and_distinct() {
        let a = stable_uuid("provider.native.request", "req-1");
        let b = stable_uuid("provider.native.request", "req-1");
        let c = stable_uuid("provider.native.request", "req-2");
        assert_eq!(a, b);
        assert_ne!(a, c);
    }
}
