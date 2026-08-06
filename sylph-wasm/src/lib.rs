pub mod sketch;
pub mod constants;
pub mod types;
pub mod seeding;
pub mod cmdline;
pub mod contain;
pub mod inference;
pub mod inspect;
pub mod par;

// target_family, not target_arch: wasm64-unknown-unknown reports
// target_arch = "wasm64", and gating on "wasm32" would quietly compile a
// cdylib with no wasm-bindgen exports at all.
#[cfg(target_family = "wasm")]
pub mod wasm;

#[cfg(target_arch = "x86_64")]
pub mod avx2_seeding;


