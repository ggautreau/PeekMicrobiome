// Parallelism shim.
//
// Under feature = "native" this re-exports rayon's prelude unchanged, so the
// algorithm code runs in parallel. Under any other build (e.g. wasm32) the
// `.into_par_iter()` / `.par_iter()` methods are provided as sequential aliases
// for `.into_iter()` / `.iter()` — same call sites compile, single-threaded
// execution. We don't bother polyfilling other rayon methods (par_bridge,
// par_chunks, etc.) because sylph doesn't use them.

#[cfg(feature = "native")]
pub use rayon::prelude::*;

#[cfg(not(feature = "native"))]
pub use fallback::*;

#[cfg(not(feature = "native"))]
mod fallback {
    /// Adds `.into_par_iter()` as an alias for `.into_iter()`.
    pub trait IntoParallelIteratorCompat: IntoIterator + Sized {
        fn into_par_iter(self) -> Self::IntoIter {
            self.into_iter()
        }
    }
    impl<T: IntoIterator> IntoParallelIteratorCompat for T {}

    /// Adds `.par_iter()` as an alias for `.iter()`. Implemented for the
    /// containers sylph actually calls `par_iter()` on.
    pub trait IntoParallelRefIteratorCompat<'a> {
        type Item;
        type Iter: Iterator<Item = Self::Item>;
        fn par_iter(&'a self) -> Self::Iter;
    }
    impl<'a, T: 'a> IntoParallelRefIteratorCompat<'a> for Vec<T> {
        type Item = &'a T;
        type Iter = std::slice::Iter<'a, T>;
        fn par_iter(&'a self) -> Self::Iter {
            self.iter()
        }
    }
    impl<'a, T: 'a> IntoParallelRefIteratorCompat<'a> for [T] {
        type Item = &'a T;
        type Iter = std::slice::Iter<'a, T>;
        fn par_iter(&'a self) -> Self::Iter {
            self.iter()
        }
    }
}
