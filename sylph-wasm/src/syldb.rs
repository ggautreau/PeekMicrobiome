// Reading a `.syldb` into memory, and refusing the ones profiling cannot use.
//
// Kept out of wasm.rs, which only compiles for wasm targets, so that the checks
// the browser depends on run under `cargo test` like the rest of the crate.

use crate::types::GenomeSketch;

/// Decode a `.syldb` the way upstream does — bincode 1 defaults: fixed-width
/// integers, little endian, trailing bytes allowed — but from the slice.
///
/// Upstream reads through `bincode::deserialize_from`, an `io::Read` decoder,
/// which sizes its buffer from a length prefix before reading a byte behind it:
/// a forged string length in a database file made the browser build allocate
/// that many bytes first (2 GiB on wasm32 panicked "capacity overflow"; a
/// smaller one pinned the memory for the life of the worker, since wasm never
/// gives linear memory back). Decoding the slice in place, every length is
/// checked against the bytes actually there, so the same file is an ordinary
/// error. Same format, same result on every well-formed file.
pub fn decode_database(syldb: &[u8]) -> Result<Vec<GenomeSketch>, String> {
    use bincode::Options;
    bincode::DefaultOptions::new()
        .with_fixint_encoding()
        .allow_trailing_bytes()
        .deserialize::<Vec<GenomeSketch>>(syldb)
        .map_err(|e| match *e {
            // The slice reader's end-of-input error carries no message at all.
            bincode::ErrorKind::Io(ref io) if io.kind() == std::io::ErrorKind::UnexpectedEof => {
                "syldb decode failed: the file ends before the data it declares \
                 (truncated, or not a .syldb)"
                    .to_string()
            }
            other => format!("syldb decode failed: {}", other),
        })
}

/// Refuse, with a sentence, every database the profile code would otherwise
/// crash on, and return the `(c, k)` reads must be sketched at.
///
/// The inference was written for the CLI, where a bad database ends the process:
/// `get_stats` calls `process::exit(1)` when a genome's `k` differs from the
/// reads' or its `c` is smaller, and `c = 0` divides by zero in the seeding. In
/// a worker each of those is a trap that leaves the `Profiler` unusable
/// ("recursive use of an object detected") — and the database is often a file
/// the reader picked from their own disk, so it gets checked here, once, before
/// anything relies on it.
///
/// `c` may differ between genomes: sylph only requires the reads' `c` to be no
/// larger than any genome's, so reads are sketched at the smallest `c` in the
/// database. For every database built by `sylph sketch` or `syldb-reduce`,
/// which use one `c` throughout, that is the `c` of the first genome, as it
/// always was. `k` has no such slack: hashes of 21-mers and 31-mers never
/// meet, so it must be one value, and one of the two sylph sketches with.
pub fn check_database(genome_sketches: &[GenomeSketch]) -> Result<(usize, usize), String> {
    let first = genome_sketches
        .first()
        .ok_or_else(|| "syldb contained no genome sketches".to_string())?;
    if first.pseudotax_tracked_nonused_kmers.is_none() {
        return Err(
            "syldb was sketched without pseudotax tracking; profile() needs --enable-pseudotax"
                .to_string(),
        );
    }
    let k = first.k;
    if k != 21 && k != 31 {
        return Err(format!(
            "syldb declares k = {} for {}; sylph sketches with k = 21 or k = 31 only",
            k, first.file_name
        ));
    }
    let mut c = usize::MAX;
    for g in genome_sketches {
        if g.k != k {
            return Err(format!(
                "syldb mixes k = {} ({}) and k = {} ({}); a database must use one k",
                k, first.file_name, g.k, g.file_name
            ));
        }
        if g.c == 0 {
            return Err(format!("syldb declares c = 0 for {}; c must be at least 1", g.file_name));
        }
        c = c.min(g.c);
    }
    Ok((c, k))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn genome(name: &str, c: usize, k: usize, pseudotax: bool) -> GenomeSketch {
        GenomeSketch {
            genome_kmers: vec![1, 2, 3],
            pseudotax_tracked_nonused_kmers: if pseudotax { Some(vec![4]) } else { None },
            file_name: name.to_string(),
            first_contig_name: format!("{}_contig", name),
            c,
            k,
            gn_size: 1000,
            min_spacing: 30,
        }
    }

    fn encode(sketches: &Vec<GenomeSketch>) -> Vec<u8> {
        // The free function is what `sylph sketch` writes with.
        bincode::serialize(sketches).expect("encode")
    }

    #[test]
    fn decodes_what_upstream_writes_and_what_upstream_reads() {
        let db = vec![genome("a.fna", 200, 31, true), genome("b.fna", 200, 31, true)];
        let bytes = encode(&db);
        assert_eq!(decode_database(&bytes).expect("decode"), db);
        // The shipped smoke-test database, read both ways: the limited decoder
        // must see exactly what upstream's unlimited one sees.
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../web/db/gut_mini.syldb");
        let raw = std::fs::read(path).expect("web/db/gut_mini.syldb");
        let ours = decode_database(&raw).expect("decode gut_mini");
        let upstream: Vec<GenomeSketch> =
            bincode::deserialize_from(std::io::Cursor::new(&raw)).expect("upstream decode");
        assert_eq!(ours, upstream);
        assert_eq!(ours.len(), 50);
        assert_eq!(check_database(&ours), Ok((200, 31)));
    }

    #[test]
    fn refuses_what_would_trap_the_worker() {
        let ok = genome("a.fna", 200, 31, true);
        let cases: Vec<(Vec<GenomeSketch>, &str)> = vec![
            (vec![], "no genome sketches"),
            (vec![genome("a.fna", 200, 31, false)], "pseudotax"),
            (vec![genome("a.fna", 0, 31, true)], "c = 0"),
            (vec![ok.clone(), genome("b.fna", 0, 31, true)], "c = 0 for b.fna"),
            (vec![genome("a.fna", 200, 25, true)], "k = 25"),
            (vec![ok.clone(), genome("b.fna", 200, 21, true)], "mixes k = 31 (a.fna) and k = 21 (b.fna)"),
        ];
        for (db, why) in cases {
            let err = check_database(&db).expect_err(why);
            assert!(err.contains(why), "expected {:?} in {:?}", why, err);
        }
    }

    #[test]
    fn mixed_c_sketches_reads_at_the_smallest() {
        // sylph needs the reads' c to be no larger than any genome's. Reading
        // c off the first genome trapped on [200, 100]; the smallest never does.
        let db = vec![genome("a.fna", 200, 31, true), genome("b.fna", 100, 31, true)];
        assert_eq!(check_database(&db), Ok((100, 31)));
        let db = vec![genome("a.fna", 100, 21, true), genome("b.fna", 1000, 21, true)];
        assert_eq!(check_database(&db), Ok((100, 21)));
    }

    #[test]
    fn a_forged_length_is_a_decode_error_not_an_allocation() {
        let db = vec![genome("a.fna", 200, 31, true)];
        let mut bytes = encode(&db);
        // Layout: Vec len (8) | genome_kmers len (8) + 3 x u64 (24) |
        // Option tag (1) + pseudotax len (8) + 1 x u64 (8) | file_name len (8)...
        let at = 8 + 8 + 24 + 1 + 8 + 8;
        assert_eq!(u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap()), 5);
        bytes[at..at + 8].copy_from_slice(&(2u64 << 30).to_le_bytes());
        let err = decode_database(&bytes).expect_err("forged length must fail");
        assert!(err.contains("ends before the data it declares"), "{}", err);
    }

    #[test]
    fn a_truncated_file_is_a_decode_error() {
        // Not "fewer genomes": the Vec is length-prefixed, so a cut anywhere is
        // an error.
        let db = vec![genome("a.fna", 200, 31, true), genome("b.fna", 200, 31, true)];
        let bytes = encode(&db);
        for cut in [1, bytes.len() / 2, bytes.len() - 1] {
            let err = decode_database(&bytes[..cut]).expect_err("truncated must fail");
            assert!(err.contains("ends before the data it declares"), "cut at {}: {}", cut, err);
        }
    }
}
