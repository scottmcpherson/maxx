fn main() {
    for v in ["req-1", "codex-approval-42", "维-unicode-✓"] {
        println!(
            "{}",
            maxx_core::ids::stable_uuid("provider.native.request", v)
        );
    }
}
