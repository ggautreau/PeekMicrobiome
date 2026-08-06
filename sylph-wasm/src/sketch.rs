use crate::cmdline::*;
use scalable_cuckoo_filter::ScalableCuckooFilter;
use scalable_cuckoo_filter::ScalableCuckooFilterBuilder;

use fxhash::FxHashMap;
use fxhash::FxHashSet;
use fxhash::FxHasher;
#[cfg(feature = "native")]
use memory_stats::memory_stats;
use std::fs;
#[cfg(feature = "native")]
use std::thread;
#[cfg(feature = "native")]
use std::time::Duration;

use crate::constants::*;
use crate::par::*;
use crate::seeding::*;
use crate::types::*;
use log::*;
use needletail::parse_fastx_file;
use std::collections::HashMap;
use std::fs::File;
use std::io::BufWriter;
use std::io::{prelude::*, BufReader};
use std::path::Path;
use std::sync::Mutex;
type Marker = u32;

#[cfg(feature = "native")]
pub fn check_vram_and_block(max_ram: usize, file: &str) {
    if let Some(usage) = memory_stats() {
        let mut gb_usage_curr = usage.virtual_mem as f64 / 1_000_000_000 as f64;
        if (max_ram as f64) < gb_usage_curr {
            log::debug!(
                "Max memory reached. Blocking sketch for {}. Curr memory {}, max mem {}",
                file,
                gb_usage_curr,
                max_ram
            );
        }
        while (max_ram as f64) < gb_usage_curr {
            let five_second = Duration::from_secs(1);
            thread::sleep(five_second);
            if let Some(usage) = memory_stats() {
                gb_usage_curr = usage.virtual_mem as f64 / 1_000_000_000 as f64;
                if (max_ram as f64) >= gb_usage_curr {
                    log::debug!("Sketching for {} freed", file);
                }
            } else {
                break;
            }
        }
    }
}

#[cfg(not(feature = "native"))]
pub fn check_vram_and_block(_max_ram: usize, _file: &str) {
    // no-op outside the native build: memory_stats and std::thread::sleep are
    // not available on wasm32.
}

pub fn extract_markers(string: &[u8], kmer_vec: &mut Vec<u64>, c: usize, k: usize) {
    #[cfg(any(target_arch = "x86_64"))]
    {
        if is_x86_feature_detected!("avx2") {
            use crate::avx2_seeding::*;
            unsafe {
                extract_markers_avx2(string, kmer_vec, c, k);
            }
        } else {
            fmh_seeds(string, kmer_vec, c, k);
        }
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        fmh_seeds(string, kmer_vec, c, k);
    }
}

pub fn extract_markers_positions(
    string: &[u8],
    kmer_vec: &mut Vec<(usize, usize, u64)>,
    c: usize,
    k: usize,
    contig_number: usize,
) {
    #[cfg(any(target_arch = "x86_64"))]
    {
        if is_x86_feature_detected!("avx2") {
            use crate::avx2_seeding::*;
            unsafe {
                extract_markers_avx2_positions(string, kmer_vec, c, k, contig_number);
            }
        } else {
            fmh_seeds_positions(string, kmer_vec, c, k, contig_number);
        }
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        fmh_seeds_positions(string, kmer_vec, c, k, contig_number);
    }
}

pub fn is_fastq(file: &str) -> bool {
    if file.ends_with(".fq")
        || file.ends_with(".fnq")
        || file.ends_with(".fastq")
        || file.ends_with(".fq.gz")
        || file.ends_with(".fnq.gz")
        || file.ends_with(".fastq.gz")
    {
        return true;
    } else {
        return false;
    }
}

pub fn is_fasta(file: &str) -> bool {
    if file.ends_with(".fa")
        || file.ends_with(".fna")
        || file.ends_with(".fasta")
        || file.ends_with(".fa.gz")
        || file.ends_with(".fna.gz")
        || file.ends_with(".fasta.gz")
    {
        return true;
    } else {
        return false;
    }
}

fn check_args_valid(args: &SketchArgs) {
    let level;
    if args.trace {
        level = log::LevelFilter::Trace;
    } else if args.debug {
        level = log::LevelFilter::Debug;
    } else {
        level = log::LevelFilter::Info;
    }

    #[cfg(feature = "native")]
    {
        rayon::ThreadPoolBuilder::new()
            .num_threads(args.threads)
            .build_global()
            .unwrap();

        simple_logger::SimpleLogger::new()
            .with_level(level)
            .init()
            .unwrap();
    }
    #[cfg(not(feature = "native"))]
    let _ = level; // unused outside native build

    if args.files.is_empty()
        && args.list_sequence.is_none()
        && args.first_pair.is_empty()
        && args.second_pair.is_empty()
        && args.genomes.is_none()
        && args.reads.is_none()
        && args.list_genomes.is_none()
        && args.list_reads.is_none()
        && args.list_first_pair.is_none()
        && args.list_second_pair.is_none()
    {
        error!("No input sequences found; see sylph sketch -h for help. Exiting.");
        std::process::exit(1);
    }

    if args.fpr < 0. || args.fpr >= 1. {
        error!("Invalid FPR for sketching. Must be in [0,1).");
        std::process::exit(1);
    }
}

fn parse_ambiguous_files(
    args: &SketchArgs,
    read_inputs: &mut Vec<String>,
    genome_inputs: &mut Vec<String>,
) {
    let mut all_files = vec![];
    if args.list_sequence.is_some() {
        let file_list = args.list_sequence.as_ref().unwrap();
        parse_line_file(file_list, &mut all_files);
    }

    all_files.extend(args.files.clone());

    for file in all_files {
        if is_fastq(&file) {
            read_inputs.push(file);
        } else if is_fasta(&file) {
            genome_inputs.push(file);
        } else {
            warn!(
                "{} does not have a fasta/fastq/gzip type extension; skipping",
                file
            );
        }
    }
}

fn parse_reads_and_genomes(
    args: &SketchArgs,
    read_inputs: &mut Vec<String>,
    genome_inputs: &mut Vec<String>,
) {
    if let Some(genomes_syl_in) = args.genomes.clone() {
        for gn_file in genomes_syl_in {
            genome_inputs.push(gn_file);
        }
    }
    if let Some(reads_syl_in) = args.reads.clone() {
        for rd_file in reads_syl_in {
            read_inputs.push(rd_file);
        }
    }

    if args.list_reads.is_some() {
        let file_reads = args.list_reads.as_ref().unwrap();
        parse_line_file(file_reads, read_inputs);
    }

    if args.list_genomes.is_some() {
        let file_genomes = args.list_genomes.as_ref().unwrap();
        parse_line_file(file_genomes, genome_inputs);
    }
}

fn parse_paired_end_reads(
    args: &SketchArgs,
    first_pairs: &mut Vec<String>,
    second_pairs: &mut Vec<String>,
) {
    if args.first_pair.len() != args.second_pair.len() {
        error!("Different number of paired sequences. Exiting.");
        std::process::exit(1);
    }

    for f in args.first_pair.iter() {
        first_pairs.push(f.clone());
    }

    for f in args.second_pair.iter() {
        second_pairs.push(f.clone());
    }

    if args.list_first_pair.is_some() {
        let file_first_pair = args.list_first_pair.as_ref().unwrap();
        parse_line_file(file_first_pair, first_pairs);
    }

    if args.list_second_pair.is_some() {
        let file_second_pair = args.list_second_pair.as_ref().unwrap();
        parse_line_file(file_second_pair, second_pairs)
    }

    if first_pairs.len() != second_pairs.len() {
        error!("Different number of paired sequences. Exiting.");
        std::process::exit(1);
    }
}

fn parse_line_file(file_name: &str, vec: &mut Vec<String>) {
    let file = File::open(file_name).unwrap();
    let reader = BufReader::new(file);
    for line in reader.lines() {
        vec.push(line.unwrap());
    }
}

fn parse_sample_names(args: &SketchArgs) -> Option<Vec<String>> {
    if args.list_sample_names.is_none() && args.sample_names.is_none() {
        return None;
    } else {
        let mut sample_names = vec![];
        if let Some(file) = &args.list_sample_names {
            parse_line_file(file, &mut sample_names);
            return Some(sample_names);
        }
        if let Some(vec) = &args.sample_names {
            sample_names.extend(vec.clone());
        }
        return Some(sample_names);
    }
}

pub fn sketch(args: SketchArgs) {
    let mut read_inputs = vec![];
    let mut genome_inputs = vec![];
    let mut first_pairs = vec![];
    let mut second_pairs = vec![];

    check_args_valid(&args);
    parse_ambiguous_files(&args, &mut read_inputs, &mut genome_inputs);
    parse_reads_and_genomes(&args, &mut read_inputs, &mut genome_inputs);
    parse_paired_end_reads(&args, &mut first_pairs, &mut second_pairs);

    let sample_names = parse_sample_names(&args);
    if let Some(names) = &sample_names {
        if names.len() != first_pairs.len() + read_inputs.len() {
            log::error!("Sample name length is not equal to the number of reads. Exiting");
            std::process::exit(1);
        }
    }

    let mut max_ram = usize::MAX;
    if args.max_ram.is_some() {
        max_ram = args.max_ram.unwrap();
        if max_ram < 7 {
            log::error!("Max ram must be >= 7. Exiting.");
            std::process::exit(1);
        }
    }

    if genome_inputs.is_empty() && args.db_out_name != "database" {
        log::warn!(
            "-o is set but no genomes are present. -o only applies to genomes; see -d for reads"
        );
    }

    if !first_pairs.is_empty() && !second_pairs.is_empty() {
        info!("Sketching paired sequences...");
        let iter_vec: Vec<usize> = (0..first_pairs.len()).into_iter().collect();
        iter_vec.into_par_iter().for_each(|i| {
            let read_file1 = &first_pairs[i];
            let read_file2 = &second_pairs[i];

            let mut sample_name = None;
            if let Some(name) = &sample_names {
                sample_name = Some(name[i].clone());
            }
            let read_sketch_opt = sketch_pair_sequences(
                read_file1,
                read_file2,
                args.c,
                args.k,
                sample_name.clone(),
                args.no_dedup,
                args.fpr,
            );
            if read_sketch_opt.is_some() {
                let res = fs::create_dir_all(&args.sample_output_dir);
                if res.is_err() {
                    error!("Could not create directory at {}", args.sample_output_dir);
                    std::process::exit(1);
                }
                let pref = Path::new(&args.sample_output_dir);
                let read_sketch = read_sketch_opt.unwrap();

                let sketch_name;
                if sample_name.is_some() {
                    sketch_name = read_sketch.sample_name.as_ref().unwrap();
                } else {
                    sketch_name = &read_sketch.file_name;
                }

                let read_file_path = Path::new(&sketch_name).file_name().unwrap();
                let file_path = pref.join(&read_file_path);

                let file_path_str = format!(
                    "{}.paired{}",
                    file_path.to_str().unwrap(),
                    SAMPLE_FILE_SUFFIX
                );

                let mut read_sk_file = BufWriter::new(
                    File::create(&file_path_str)
                        .expect(&format!("{} path not valid; exiting ", file_path_str)),
                );

                bincode::serialize_into(&mut read_sk_file, &read_sketch).unwrap();
                info!("Sketching {} complete.", file_path_str);
            }
        });
    }

    if !read_inputs.is_empty() {
        info!("Sketching non-paired sequences...");
    }

    let iter_vec: Vec<usize> = (0..read_inputs.len()).into_iter().collect();
    iter_vec.into_par_iter().for_each(|i| {
        let pref = Path::new(&args.sample_output_dir);
        std::fs::create_dir_all(pref)
            .expect("Could not create directory for output sample files (-d). Exiting...");

        let read_file = &read_inputs[i];

        check_vram_and_block(max_ram, read_file);
        let mut sample_name = None;
        if let Some(name) = &sample_names {
            sample_name = Some(name[i + first_pairs.len()].clone());
        }

        let read_sketch_opt;
        read_sketch_opt = sketch_sequences_needle(
            read_file,
            args.c,
            args.k,
            sample_name.clone(),
            args.no_dedup,
        );

        if read_sketch_opt.is_some() {
            let read_sketch = read_sketch_opt.unwrap();
            let sketch_name;
            if sample_name.is_some() {
                sketch_name = read_sketch.sample_name.as_ref().unwrap();
            } else {
                sketch_name = &read_sketch.file_name;
            }
            let read_file_path = Path::new(&sketch_name).file_name().unwrap();
            let file_path = pref.join(&read_file_path);

            let file_path_str = format!("{}{}", file_path.to_str().unwrap(), SAMPLE_FILE_SUFFIX);

            let mut read_sk_file = BufWriter::new(
                File::create(&file_path_str)
                    .expect(&format!("{} path not valid; exiting.", file_path_str)),
            );

            bincode::serialize_into(&mut read_sk_file, &read_sketch).unwrap();
            info!("Sketching {} complete.", file_path_str);
        }
    });

    if !genome_inputs.is_empty() {
        info!("Sketching genomes...");
        let iter_vec: Vec<usize> = (0..genome_inputs.len()).into_iter().collect();
        let counter: Mutex<usize> = Mutex::new(0);
        let pref = Path::new(&args.db_out_name);
        let file_path_str = format!("{}{}", pref.to_str().unwrap(), QUERY_FILE_SUFFIX);
        let path = std::path::Path::new(&file_path_str);
        let prefix = path.parent().unwrap();
        std::fs::create_dir_all(prefix)
            .expect("Could not create directory for output database file (-o). Exiting...");
        let all_genome_sketches = Mutex::new(vec![]);

        iter_vec.into_par_iter().for_each(|i| {
            let genome_file = &genome_inputs[i];
            if args.individual {
                let indiv_gn_sketches = sketch_genome_individual(
                    args.c,
                    args.k,
                    genome_file,
                    args.min_spacing_kmer,
                    !args.no_pseudotax,
                );
                all_genome_sketches
                    .lock()
                    .unwrap()
                    .extend(indiv_gn_sketches);
            } else {
                let genome_sketch = sketch_genome(
                    args.c,
                    args.k,
                    genome_file,
                    args.min_spacing_kmer,
                    !args.no_pseudotax,
                );
                if genome_sketch.is_some() {
                    all_genome_sketches
                        .lock()
                        .unwrap()
                        .push(genome_sketch.unwrap());
                }
            }
            let mut c = counter.lock().unwrap();
            *c += 1;
            if *c % 100 == 0 && *c != 0 {
                info!("{} genomes processed.", *c);
            }
        });

        if all_genome_sketches.lock().unwrap().is_empty() {
            warn!(
                "No valid genomes to sketch; {} is not output",
                file_path_str
            );
        } else {
            let mut genome_sk_file = BufWriter::new(
                File::create(&file_path_str).expect(&format!("{} not valid ", file_path_str)),
            );
            info!("Wrote all genome sketches to {}", file_path_str);
            bincode::serialize_into(&mut genome_sk_file, &all_genome_sketches).unwrap();
        }
    }

    info!("Finished.");
}

pub fn sketch_genome_individual(
    c: usize,
    k: usize,
    ref_file: &str,
    min_spacing: usize,
    pseudotax: bool,
) -> Vec<GenomeSketch> {
    let reader = parse_fastx_file(&ref_file);
    if !reader.is_ok() {
        warn!("{} is not a valid fasta/fastq file; skipping.", ref_file);
        return vec![];
    } else {
        let mut reader = reader.unwrap();
        let mut return_vec = vec![];
        while let Some(record) = reader.next() {
            let mut return_genome_sketch = GenomeSketch::default();
            return_genome_sketch.c = c;
            return_genome_sketch.k = k;
            return_genome_sketch.file_name = ref_file.to_string();
            if record.is_ok() {
                let mut pseudotax_track_kmers = vec![];
                let mut kmer_vec = vec![];
                let record = record.expect(&format!("Invalid record for file {} ", ref_file));
                let contig_name = String::from_utf8_lossy(record.id()).to_string();
                let contig_name_notab = contig_name.replace('\t', " ");
                return_genome_sketch.first_contig_name = contig_name_notab.to_owned();
                let seq = record.seq();

                extract_markers_positions(&seq, &mut kmer_vec, c, k, 0);

                let mut kmer_set = MMHashSet::default();
                let mut duplicate_set = MMHashSet::default();
                let mut new_vec = Vec::with_capacity(kmer_vec.len());
                kmer_vec.sort();
                for (_, _pos, km) in kmer_vec.iter() {
                    if !kmer_set.contains(&km) {
                        kmer_set.insert(km);
                    } else {
                        duplicate_set.insert(km);
                    }
                }
                let mut last_pos = 0;
                for (_, pos, km) in kmer_vec.iter() {
                    if !duplicate_set.contains(&km) {
                        if last_pos == 0 || pos - last_pos > min_spacing {
                            new_vec.push(*km);
                            last_pos = *pos;
                        } else if pseudotax {
                            pseudotax_track_kmers.push(*km);
                        }
                    }
                }

                return_genome_sketch.gn_size = record.seq().len();
                return_genome_sketch.genome_kmers = new_vec;
                return_genome_sketch.min_spacing = min_spacing;
                if pseudotax {
                    return_genome_sketch.pseudotax_tracked_nonused_kmers =
                        Some(pseudotax_track_kmers);
                }
                return_vec.push(return_genome_sketch);
            } else {
                warn!("File {} is not a valid fasta/fastq file", ref_file);
                return vec![];
            }
        }
        return return_vec;
    }
}

pub fn sketch_genome(
    c: usize,
    k: usize,
    ref_file: &str,
    min_spacing: usize,
    pseudotax: bool,
) -> Option<GenomeSketch> {
    let reader = parse_fastx_file(&ref_file);
    let mut vec = vec![];
    let mut pseudotax_track_kmers = vec![];
    if !reader.is_ok() {
        warn!("{} is not a valid fasta/fastq file; skipping.", ref_file);
        return None;
    } else {
        let mut reader = reader.unwrap();
        let mut first = true;
        let mut return_genome_sketch = GenomeSketch::default();
        return_genome_sketch.c = c;
        return_genome_sketch.k = k;
        return_genome_sketch.file_name = ref_file.to_string();
        let mut contig_number = 0;
        while let Some(record) = reader.next() {
            if record.is_ok() {
                let record = record.expect(&format!("Invalid record for file {} ", ref_file));
                if first {
                    let contig_name = String::from_utf8_lossy(record.id()).to_string();
                    let contig_name_notab = contig_name.replace('\t', " ");
                    return_genome_sketch.first_contig_name = contig_name_notab.to_owned();
                    first = false;
                }
                let seq = record.seq();

                return_genome_sketch.gn_size += seq.len();
                extract_markers_positions(&seq, &mut vec, c, k, contig_number);

                contig_number += 1
            } else {
                warn!("File {} is not a valid fasta/fastq file", ref_file);
                return None;
            }
        }
        let mut kmer_set = MMHashSet::default();
        let mut duplicate_set = MMHashSet::default();
        let mut new_vec = Vec::with_capacity(vec.len());
        vec.sort();
        for (_, _, km) in vec.iter() {
            if !kmer_set.contains(&km) {
                kmer_set.insert(km);
            } else {
                duplicate_set.insert(km);
            }
        }

        let mut last_pos = 0;
        let mut last_contig = 0;
        for (contig, pos, km) in vec.iter() {
            if !duplicate_set.contains(&km) {
                if last_pos == 0 || last_contig != *contig || pos - last_pos > min_spacing {
                    new_vec.push(*km);
                    last_contig = *contig;
                    last_pos = *pos;
                } else if pseudotax {
                    pseudotax_track_kmers.push(*km);
                }
            }
        }
        return_genome_sketch.genome_kmers = new_vec;
        return_genome_sketch.min_spacing = min_spacing;
        if pseudotax {
            return_genome_sketch.pseudotax_tracked_nonused_kmers = Some(pseudotax_track_kmers);
        }
        return Some(return_genome_sketch);
    }
}

#[inline]
fn pair_kmer_single(s1: &[u8]) -> Option<([Marker; 2], [Marker; 2])> {
    let k = std::mem::size_of::<Marker>() * 4;
    if s1.len() < 4 * k + 2 {
        return None;
    } else {
        let mut kmer_f = 0;
        let mut kmer_g = 0;
        let mut kmer_r = 0;
        let mut kmer_t = 0;
        let halfway = s1.len() / 2;
        // len(s1)/2 + (k-1)* 2 + 2 < len(s1)
        for i in 0..k {
            let nuc_1 = BYTE_TO_SEQ[s1[2 * i] as usize] as Marker;
            let nuc_2 = BYTE_TO_SEQ[s1[2 * i + halfway] as usize] as Marker;
            let nuc_3 = BYTE_TO_SEQ[s1[1 + 2 * i] as usize] as Marker;
            let nuc_4 = BYTE_TO_SEQ[s1[1 + 2 * i + halfway] as usize] as Marker;

            kmer_f <<= 2;
            kmer_f |= nuc_1;

            kmer_r <<= 2;
            kmer_r |= nuc_2;

            kmer_g <<= 2;
            kmer_g |= nuc_3;

            kmer_t <<= 2;
            kmer_t |= nuc_4;
        }
        return Some(([kmer_f, kmer_r], [kmer_g, kmer_t]));
    }
}

#[inline]
fn pair_kmer(s1: &[u8], s2: &[u8]) -> Option<([Marker; 2], [Marker; 2])> {
    let k = std::mem::size_of::<Marker>() * 4;
    if s1.len() < 2 * k + 1 || s2.len() < 2 * k + 1 {
        return None;
    } else {
        let mut kmer_f = 0;
        let mut kmer_g = 0;
        let mut kmer_r = 0;
        let mut kmer_t = 0;
        for i in 0..k {
            let nuc_1 = BYTE_TO_SEQ[s1[2 * i] as usize] as Marker;
            let nuc_2 = BYTE_TO_SEQ[s2[2 * i] as usize] as Marker;
            let nuc_3 = BYTE_TO_SEQ[s1[1 + 2 * i] as usize] as Marker;
            let nuc_4 = BYTE_TO_SEQ[s2[1 + 2 * i] as usize] as Marker;

            kmer_f <<= 2;
            kmer_f |= nuc_1;

            kmer_r <<= 2;
            kmer_r |= nuc_2;

            kmer_g <<= 2;
            kmer_g |= nuc_3;

            kmer_t <<= 2;
            kmer_t |= nuc_4;
        }
        return Some(([kmer_f, kmer_r], [kmer_g, kmer_t]));
    }
}

fn dup_removal_lsh_full_exact(
    kmer_counts: &mut FxHashMap<Kmer, u32>,
    kmer_to_pair_set: &mut FxHashSet<(u64, [Marker; 2])>,
    //kmer_to_pair_set: &mut ScalableCuckooFilter<(u64,[Marker;2]), FxHasher>,
    //kmer_to_pair_set: &mut GrowableBloom,
    km: &u64,
    kmer_pair: Option<([Marker; 2], [Marker; 2])>,
    num_dup_removed: &mut usize,
    no_dedup: bool,
    threshold: Option<u32>,
) {
    let c = kmer_counts.entry(*km).or_insert(0);
    let mut c_threshold = u32::MAX;
    if let Some(t) = threshold {
        c_threshold = t;
    }
    if !no_dedup && *c < c_threshold {
        if let Some(doublepairs) = kmer_pair {
            let mut ret = false;
            if kmer_to_pair_set.contains(&(*km, doublepairs.0)) {
                //Need this when using approximate data structures
                if *c > 0 {
                    ret = true;
                }
            } else {
                kmer_to_pair_set.insert((*km, doublepairs.0));
            }
            if kmer_to_pair_set.contains(&(*km, doublepairs.1)) {
                if *c > 0 {
                    ret = true;
                }
            } else {
                kmer_to_pair_set.insert((*km, doublepairs.1));
            }
            if ret {
                *num_dup_removed += 1;
                return;
            }
        }
    }
    *c += 1;
}

fn dup_removal_lsh_full(
    kmer_counts: &mut FxHashMap<Kmer, u32>,
    //kmer_to_pair_set: &mut FxHashSet<(u64,[Marker;2])>,
    kmer_to_pair_set: &mut ScalableCuckooFilter<(u64, [Marker; 2]), FxHasher>,
    //kmer_to_pair_set: &mut GrowableBloom,
    km: &u64,
    kmer_pair: Option<([Marker; 2], [Marker; 2])>,
    num_dup_removed: &mut usize,
    no_dedup: bool,
) {
    let c = kmer_counts.entry(*km).or_insert(0);
    if !no_dedup {
        if let Some(doublepairs) = kmer_pair {
            let mut ret = false;
            if kmer_to_pair_set.contains(&(*km, doublepairs.0)) {
                //Need this when using approximate data structures
                if *c > 0 {
                    ret = true;
                }
            } else {
                kmer_to_pair_set.insert(&(*km, doublepairs.0));
            }
            if kmer_to_pair_set.contains(&(*km, doublepairs.1)) {
                if *c > 0 {
                    ret = true;
                }
            } else {
                kmer_to_pair_set.insert(&(*km, doublepairs.1));
            }
            if ret {
                *num_dup_removed += 1;
                return;
            }
        }
    }
    *c += 1;
}

pub fn sketch_pair_sequences(
    read_file1: &str,
    read_file2: &str,
    c: usize,
    k: usize,
    sample_name: Option<String>,
    no_dedup: bool,
    dedup_fpr: f64,
) -> Option<SequencesSketch> {
    let r1o = parse_fastx_file(&read_file1);
    let r2o = parse_fastx_file(&read_file2);
    let mut read_sketch = SequencesSketch::new(read_file1.to_string(), c, k, true, sample_name, 0.);
    if r1o.is_err() || r2o.is_err() {
        log::error!("Paired end reading failed for '{}' and '{}'. Make sure the files are present or the sequences are valid.", read_file1, read_file2);
        std::process::exit(1);
    }

    let mut num_dup_removed = 0;

    let mut reader1 = r1o.unwrap();
    let mut reader2 = r2o.unwrap();

    //let mut kmer_pair_set = FxHashMap::default();
    let mut kmer_pair_set = FxHashSet::default();
    //let mut kmer_pair_set = GrowableBloom::new(0.001, 1_000_000_0);
    let mut fpr = 0.001;
    if dedup_fpr != 0. {
        fpr = dedup_fpr;
    }
    let mut kmer_pair_set_approx = ScalableCuckooFilterBuilder::new()
        .initial_capacity(1_000_000_0)
        .false_positive_probability(fpr)
        .hasher(FxHasher::default())
        .finish();

    let mut mean_read_length: f64 = 0.;
    let mut counter: f64 = 0.;

    loop {
        let n1 = reader1.next();
        let n2 = reader2.next();
        if let Some(rec1_o) = n1 {
            if let Some(rec2_o) = n2 {
                if let Ok(rec1) = rec1_o {
                    if let Ok(rec2) = rec2_o {
                        let mut temp_vec1 = vec![];
                        let mut temp_vec2 = vec![];

                        extract_markers(&rec1.seq(), &mut temp_vec1, c, k);
                        extract_markers(&rec2.seq(), &mut temp_vec2, c, k);
                        let kmer_pair = pair_kmer(&rec1.seq(), &rec2.seq());

                        //moving average
                        counter += 1.;
                        mean_read_length = mean_read_length
                            + ((rec1.seq().len() as f64) - mean_read_length) / counter;

                        for km in temp_vec1.iter() {
                            if dedup_fpr == 0. {
                                dup_removal_lsh_full_exact(
                                    &mut read_sketch.kmer_counts,
                                    &mut kmer_pair_set,
                                    km,
                                    kmer_pair,
                                    &mut num_dup_removed,
                                    no_dedup,
                                    None,
                                );
                            } else {
                                dup_removal_lsh_full(
                                    &mut read_sketch.kmer_counts,
                                    &mut kmer_pair_set_approx,
                                    km,
                                    kmer_pair,
                                    &mut num_dup_removed,
                                    no_dedup,
                                );
                            }
                            //dup_removal_lsh(&mut read_sketch.kmer_counts, &mut kmer_pair_set, km, kmer_pair, &mut num_dup_removed, no_dedup);
                        }
                        for km in temp_vec2.iter() {
                            if temp_vec1.contains(km) {
                                continue;
                            }
                            if dedup_fpr == 0. {
                                dup_removal_lsh_full_exact(
                                    &mut read_sketch.kmer_counts,
                                    &mut kmer_pair_set,
                                    km,
                                    kmer_pair,
                                    &mut num_dup_removed,
                                    no_dedup,
                                    None,
                                );
                            } else {
                                dup_removal_lsh_full(
                                    &mut read_sketch.kmer_counts,
                                    &mut kmer_pair_set_approx,
                                    km,
                                    kmer_pair,
                                    &mut num_dup_removed,
                                    no_dedup,
                                );
                            }
                            //dup_removal_lsh(&mut read_sketch.kmer_counts, &mut kmer_pair_set, km, kmer_pair, &mut num_dup_removed, no_dedup);
                        }
                    }
                } else {
                    return None;
                }
            }
        } else {
            break;
        }
    }
    let percent = (num_dup_removed as f64)/((read_sketch.kmer_counts.values().sum::<u32>() as f64) + num_dup_removed as f64) * 100.;
    log::debug!(
        "Number of sketched k-mers removed due to read duplication for {}: {}. Percentage: {:.2}%",
        read_sketch.file_name,
        num_dup_removed,
        percent,
    );
    read_sketch.mean_read_length = mean_read_length;
    return Some(read_sketch);
}

pub fn sketch_sequences_needle(
    read_file: &str,
    c: usize,
    k: usize,
    sample_name: Option<String>,
    no_dedup: bool,
) -> Option<SequencesSketch> {
    let mut kmer_map = HashMap::default();
    let ref_file = &read_file;
    let reader = parse_fastx_file(&ref_file);
    let mut mean_read_length = 0.;
    let mut counter = 0.;
    let mut kmer_to_pair_table = FxHashSet::default();
    let mut num_dup_removed = 0;

    if !reader.is_ok() {
        warn!("{} is not a valid fasta/fastq file; skipping.", ref_file);
        return None
    } else {
        let mut reader = reader.unwrap();
        while let Some(record) = reader.next() {
            if record.is_ok() {
                let mut vec = vec![];
                let record = record.expect(&format!("Invalid record for file {} ", ref_file));
                let seq = record.seq();
                let kmer_pair;
                if seq.len() > 400 {
                    kmer_pair = None;
                } else {
                    kmer_pair = pair_kmer_single(&seq);
                }
                extract_markers(&seq, &mut vec, c, k);
                for km in vec {
                    dup_removal_lsh_full_exact(
                        &mut kmer_map,
                        &mut kmer_to_pair_table,
                        &km,
                        kmer_pair,
                        &mut num_dup_removed,
                        no_dedup,
                        Some(MAX_DEDUP_COUNT),
                    );
                }
                //moving average
                counter += 1.;
                mean_read_length =
                    mean_read_length + ((seq.len() as f64) - mean_read_length) / counter;
            } else {
                warn!("File {} is not a valid fasta/fastq file", ref_file);
            }
        }
    }

    return Some(SequencesSketch {
        kmer_counts: kmer_map,
        file_name: read_file.to_string(),
        c,
        k,
        paired: false,
        sample_name: sample_name,
        mean_read_length,
    });
}

// ---------------------------------------------------------------------------
// Incremental (streaming) sketching.
//
// The single-shot `sketch_*_from_bytes` functions below and the chunk-fed
// `StreamSketcher` / `PairStreamSketcher` share the exact same per-record code
// (`SingleSketchState::push_record` / `PairSketchState::push_pair`). That
// sharing is the equivalence guarantee: feeding a FASTQ in one block or in a
// thousand arbitrary blocks visits the same records, in the same order, with
// the same state updates.
// ---------------------------------------------------------------------------

/// All the mutable state a single-end sketch accumulates, one record at a time.
struct SingleSketchState {
    kmer_map: FxHashMap<Kmer, u32>,
    kmer_to_pair_table: FxHashSet<(u64, [Marker; 2])>,
    num_dup_removed: usize,
    mean_read_length: f64,
    counter: f64,
    n_read: usize,
    c: usize,
    k: usize,
    no_dedup: bool,
}

impl SingleSketchState {
    fn new(c: usize, k: usize, no_dedup: bool) -> SingleSketchState {
        SingleSketchState {
            kmer_map: HashMap::default(),
            kmer_to_pair_table: FxHashSet::default(),
            num_dup_removed: 0,
            mean_read_length: 0.0,
            counter: 0.0,
            n_read: 0,
            c,
            k,
            no_dedup,
        }
    }

    /// Body of the single-end sketching loop, for exactly one record.
    fn push_record(&mut self, seq: &[u8]) {
        let mut vec = vec![];
        let kmer_pair = if seq.len() > 400 {
            None
        } else {
            pair_kmer_single(seq)
        };
        extract_markers(seq, &mut vec, self.c, self.k);
        for km in vec {
            dup_removal_lsh_full_exact(
                &mut self.kmer_map,
                &mut self.kmer_to_pair_table,
                &km,
                kmer_pair,
                &mut self.num_dup_removed,
                self.no_dedup,
                Some(MAX_DEDUP_COUNT),
            );
        }
        self.counter += 1.0;
        self.mean_read_length += ((seq.len() as f64) - self.mean_read_length) / self.counter;
        self.n_read += 1;
    }

    /// Terminal: moves the counts out and drops the dedup table (which is the
    /// bigger of the two structures — it holds up to two entries per sketched
    /// k-mer occurrence, and nothing downstream needs it).
    fn take_sketch(&mut self, sample_name: String) -> SequencesSketch {
        self.kmer_to_pair_table = FxHashSet::default();
        SequencesSketch {
            kmer_counts: std::mem::take(&mut self.kmer_map),
            file_name: sample_name.clone(),
            c: self.c,
            k: self.k,
            paired: false,
            sample_name: Some(sample_name),
            mean_read_length: self.mean_read_length,
        }
    }

    fn into_sketch(mut self, sample_name: String) -> SequencesSketch {
        self.take_sketch(sample_name)
    }
}

/// Bytes-fed equivalent of `sketch_sequences_needle`. Takes a raw FASTQ/FASTA
/// byte buffer (uncompressed) and returns a single-end sketch. `max_reads`,
/// when Some, stops after that many records — useful in the WASM context to
/// cap memory and work.
pub fn sketch_sequences_from_bytes(
    bytes: &[u8],
    sample_name: String,
    c: usize,
    k: usize,
    no_dedup: bool,
    max_reads: Option<usize>,
) -> Option<SequencesSketch> {
    let cursor = std::io::Cursor::new(bytes);
    let reader_res = needletail::parse_fastx_reader(cursor);
    if reader_res.is_err() {
        log::warn!("WASM input is not a valid fasta/fastq stream; skipping.");
        return None;
    }
    let mut reader = reader_res.unwrap();

    let mut state = SingleSketchState::new(c, k, no_dedup);

    while let Some(record) = reader.next() {
        if let Some(cap) = max_reads {
            if state.n_read >= cap {
                break;
            }
        }
        if let Ok(record) = record {
            state.push_record(&record.seq());
        }
    }

    Some(state.into_sketch(sample_name))
}

/// All the mutable state a paired-end sketch accumulates, one pair at a time.
struct PairSketchState {
    kmer_counts: FxHashMap<Kmer, u32>,
    kmer_pair_set: FxHashSet<(u64, [Marker; 2])>,
    num_dup_removed: usize,
    mean_read_length: f64,
    counter: f64,
    n_pairs: usize,
    c: usize,
    k: usize,
    no_dedup: bool,
}

impl PairSketchState {
    fn new(c: usize, k: usize, no_dedup: bool) -> PairSketchState {
        PairSketchState {
            kmer_counts: HashMap::default(),
            kmer_pair_set: FxHashSet::default(),
            num_dup_removed: 0,
            mean_read_length: 0.0,
            counter: 0.0,
            n_pairs: 0,
            c,
            k,
            no_dedup,
        }
    }

    /// Body of the paired-end sketching loop, for exactly one (R1, R2) pair.
    fn push_pair(&mut self, seq1: &[u8], seq2: &[u8]) {
        let mut temp1 = Vec::new();
        let mut temp2 = Vec::new();
        extract_markers(seq1, &mut temp1, self.c, self.k);
        extract_markers(seq2, &mut temp2, self.c, self.k);
        let kmer_pair = pair_kmer(seq1, seq2);

        self.counter += 1.0;
        self.mean_read_length += ((seq1.len() as f64) - self.mean_read_length) / self.counter;

        for km in temp1.iter() {
            dup_removal_lsh_full_exact(
                &mut self.kmer_counts,
                &mut self.kmer_pair_set,
                km,
                kmer_pair,
                &mut self.num_dup_removed,
                self.no_dedup,
                None,
            );
        }
        for km in temp2.iter() {
            if temp1.contains(km) {
                continue;
            }
            dup_removal_lsh_full_exact(
                &mut self.kmer_counts,
                &mut self.kmer_pair_set,
                km,
                kmer_pair,
                &mut self.num_dup_removed,
                self.no_dedup,
                None,
            );
        }
        self.n_pairs += 1;
    }

    /// Terminal: see `SingleSketchState::take_sketch`.
    fn take_sketch(&mut self, sample_name: String) -> SequencesSketch {
        self.kmer_pair_set = FxHashSet::default();
        SequencesSketch {
            kmer_counts: std::mem::take(&mut self.kmer_counts),
            file_name: sample_name.clone(),
            c: self.c,
            k: self.k,
            paired: true,
            sample_name: Some(sample_name),
            mean_read_length: self.mean_read_length,
        }
    }

    fn into_sketch(mut self, sample_name: String) -> SequencesSketch {
        self.take_sketch(sample_name)
    }
}

/// Paired-end byte equivalent of `sketch_pair_sequences`. Reads R1 and R2
/// byte streams in lockstep, derives an inter-mate `kmer_pair` for exact
/// dedup, and returns one `SequencesSketch` flagged `paired: true`.
///
/// Only the exact-dedup path is implemented (no_dedup=false, dedup_fpr=0):
/// the scalable cuckoo filter is heavyweight and not needed at the 5M-read
/// cap we plan to use in the browser.
pub fn sketch_pair_sequences_from_bytes(
    r1_bytes: &[u8],
    r2_bytes: &[u8],
    sample_name: String,
    c: usize,
    k: usize,
    no_dedup: bool,
    max_reads: Option<usize>,
) -> Option<SequencesSketch> {
    let r1 = needletail::parse_fastx_reader(std::io::Cursor::new(r1_bytes));
    let r2 = needletail::parse_fastx_reader(std::io::Cursor::new(r2_bytes));
    if r1.is_err() || r2.is_err() {
        log::warn!("WASM PE input not valid fasta/fastq; skipping.");
        return None;
    }
    let mut reader1 = r1.unwrap();
    let mut reader2 = r2.unwrap();

    let mut state = PairSketchState::new(c, k, no_dedup);

    loop {
        if let Some(cap) = max_reads {
            if state.n_pairs >= cap {
                break;
            }
        }
        let n1 = reader1.next();
        let n2 = reader2.next();
        let (rec1_o, rec2_o) = match (n1, n2) {
            (Some(a), Some(b)) => (a, b),
            _ => break, // one stream exhausted (or both)
        };
        let (rec1, rec2) = match (rec1_o, rec2_o) {
            (Ok(a), Ok(b)) => (a, b),
            _ => continue,
        };

        state.push_pair(&rec1.seq(), &rec2.seq());
    }

    Some(state.into_sketch(sample_name))
}

// ---------------------------------------------------------------------------
// Chunked, never-materialise-the-whole-file API.
//
// A browser cannot hold a 20-50M-read FASTQ in one `Uint8Array` (Chrome refuses
// a single ArrayBuffer of 2 GiB), so JS hands us the trimmed FASTQ in blocks.
// We split those blocks on *record* boundaries — a FASTQ record is exactly four
// lines, which the whole pipeline already assumes — and hand each complete
// run of records to needletail, so parsing stays byte-for-byte identical to the
// single-shot path. Whatever trails the last complete record is carried over to
// the next `feed`.
// ---------------------------------------------------------------------------

/// Scan `buf[from..]` for the end of the last complete FASTQ record.
///
/// `lines` is how many complete lines of the *current* (unfinished) record are
/// already in `buf` before `from`; it is always 0..=3 because we cut exactly at
/// 4-line boundaries. Returns `(cut, lines_left)`, where `cut` is the offset one
/// past the `\n` that completed the last group of four lines (0 if none did),
/// and `lines_left` is the new count of dangling complete lines.
fn record_boundary(buf: &[u8], from: usize, lines: usize) -> (usize, usize) {
    let mut lines = lines;
    let mut cut = 0usize;
    for (off, b) in buf[from..].iter().enumerate() {
        if *b == b'\n' {
            lines += 1;
            if lines == 4 {
                cut = from + off + 1;
                lines = 0;
            }
        }
    }
    (cut, lines)
}

/// Hard cap on the carry buffer.
///
/// `record_boundary` only releases bytes once it has seen four `\n`; if the
/// input has (almost) no newlines — single-line FASTA, a genome contig on one
/// line, CR-only line endings — nothing is ever released and the carry grows
/// to the size of the whole file. That is exactly the single giant buffer this
/// API exists to remove, only now in wasm linear memory where overflowing it
/// aborts the worker instead of raising a catchable RangeError. 8 MiB is ~30k
/// ordinary FASTQ records, so any legitimate FASTQ stream stays far below it.
///
/// It is a *memory* guard, not the FASTA guard: a multi-line FASTA has plenty
/// of newlines and never trips this cap. Non-FASTQ input is rejected by
/// `FASTQ_START` below, whatever its line structure.
const CARRY_MAX: usize = 8 << 20;

/// The one byte this API dispatches on.
///
/// needletail picks the parser from the first byte of the stream (`>` → FASTA,
/// `@` → FASTQ). Since we hand it one block per `feed` instead of one reader
/// per sample, that decision would be re-taken on every block: a block starting
/// with `>` would be read as FASTA even in the middle of a FASTQ sample, and
/// the record count — hence the TSV — would again depend on where the chunks
/// fall. So the format is pinned, and pinned to FASTQ:
///
///   * the streaming split is "every four `\n`", which is the definition of a
///     FASTQ record and nothing else. A multi-line FASTA has no such structure:
///     feeding it here would chop its contigs into arbitrary 4-line pieces and
///     produce a sketch that resembles neither `profile()` nor reality. This
///     path is therefore FASTQ-only *by construction*, and says so out loud:
///     a first block that does not start with `@` is `invalid`, i.e. the same
///     visible error the UI shows for "not a FASTQ file", instead of a
///     silently wrong profile.
///   * a *later* block that does not start with `@` is `stopped`: the one-shot
///     reader, positioned there, would find something other than a record start
///     and give up for good (needletail's `InvalidStart`).
const FASTQ_START: u8 = b'@';

/// Incremental single-end sketcher: same state as `sketch_sequences_from_bytes`,
/// plus a carry buffer for the record straddling two chunks.
///
/// FASTQ only — the 4-lines-per-record split does not hold for FASTA, neither
/// single-line (no boundary at all, caught by `CARRY_MAX`) nor multi-line (a
/// contig would be cut every 4 lines). A stream that does not open with
/// `FASTQ_START` is rejected outright rather than sketched wrongly; that is the
/// one deliberate difference with `sketch_sequences_from_bytes`, which would
/// happily read FASTA. See `FASTQ_START`.
///
/// # Matching needletail's stop semantics
///
/// The reference path builds *one* needletail reader over the whole sample.
/// needletail sets `finished = true` on the first record-level error
/// (parser/fastq.rs:251/261/285) and never resumes, so `profile()` sketches the
/// records preceding the first bad one and stops there. Rebuilding a reader per
/// block would instead restart parsing after every error, making the read count
/// — and therefore the TSV — a function of the chunk schedule. `stopped`
/// reproduces the one-shot behaviour: once raised, nothing is ever parsed again.
///
/// `invalid` is the other half of the equivalence: the one-shot returns `None`
/// when `parse_fastx_reader` itself fails, which it decides on the first two
/// bytes of the stream. So only a failure on the *first* block we hand to
/// needletail means "not a fastx stream" (`invalid`); the same failure on a
/// later block means the bytes at that point are not a record start, which is
/// precisely what makes a one-shot reader give up: `stopped`. The same split
/// applies to the format check (`FASTQ_START`), which runs *before*
/// `parse_fastx_reader` so that a `>` never re-dispatches a block to the FASTA
/// parser.
pub struct StreamSketcher {
    state: SingleSketchState,
    sample_name: String,
    max_reads: Option<usize>,
    carry: Vec<u8>,
    carry_lines: usize,
    /// The stream is not fastx at all — `finish()` returns None, like the
    /// one-shot path.
    invalid: bool,
    /// needletail gave up on this stream; ignore everything that follows.
    stopped: bool,
    /// Whether any block was ever handed to `parse_fastx_reader`.
    parse_attempted: bool,
    /// Total bytes handed to `feed` (0 = empty input = one-shot `None`).
    bytes_fed: usize,
}

impl StreamSketcher {
    pub fn new(
        sample_name: String,
        c: usize,
        k: usize,
        no_dedup: bool,
        max_reads: Option<usize>,
    ) -> StreamSketcher {
        StreamSketcher {
            state: SingleSketchState::new(c, k, no_dedup),
            sample_name,
            max_reads,
            carry: Vec::new(),
            carry_lines: 0,
            invalid: false,
            stopped: false,
            parse_attempted: false,
            bytes_fed: 0,
        }
    }

    /// Number of records sketched so far.
    pub fn n_reads(&self) -> usize {
        self.state.n_read
    }

    /// True once `max_reads` has been reached — the caller can stop feeding.
    pub fn is_done(&self) -> bool {
        match self.max_reads {
            Some(cap) => self.state.n_read >= cap,
            None => false,
        }
    }

    /// The stream was rejected: `finish()` will return `None`.
    pub fn is_invalid(&self) -> bool {
        self.invalid
    }

    /// No further byte can change the outcome (cap reached, needletail gave up,
    /// or the stream was rejected). The caller should stop reading the file.
    pub fn is_halted(&self) -> bool {
        self.invalid || self.stopped || self.is_done()
    }

    /// Feed the next slice of the FASTQ stream. Returns the cumulative read count.
    pub fn feed(&mut self, chunk: &[u8]) -> usize {
        // Early out: once halted, every remaining byte is dead weight. Keeping
        // on sketching just to throw the result away at `finish()` costs the
        // full peak memory and the full CPU of the sample.
        if self.is_halted() {
            self.release_buffers();
            return self.state.n_read;
        }
        self.bytes_fed += chunk.len();
        let from = self.carry.len();
        self.carry.extend_from_slice(chunk);
        let (cut, lines_left) = record_boundary(&self.carry, from, self.carry_lines);
        self.carry_lines = lines_left;
        if cut > 0 {
            // Take the buffer out so the borrow checker lets us mutate `self`
            // while reading the block; the Vec (and its capacity) goes back.
            let mut buf = std::mem::take(&mut self.carry);
            self.consume_block(&buf[..cut]);
            buf.drain(..cut);
            self.carry = buf;
        } else if self.carry.len() > CARRY_MAX {
            log::warn!(
                "streamed input has no fastq record boundary in {} bytes; not a FASTQ stream.",
                self.carry.len()
            );
            self.reject();
        }
        if self.is_halted() {
            self.release_buffers();
        }
        self.state.n_read
    }

    fn release_buffers(&mut self) {
        self.carry = Vec::new();
        self.carry_lines = 0;
    }

    /// Mark the stream unusable and drop everything: the sketch state is dead
    /// weight from here on (`finish()` returns `None`), and it is by far the
    /// biggest allocation of the sample.
    fn reject(&mut self) {
        self.invalid = true;
        self.state = SingleSketchState::new(self.state.c, self.state.k, self.state.no_dedup);
        self.release_buffers();
    }

    /// Parse one run of complete records and sketch them, reproducing what a
    /// single needletail reader over the whole sample would do (see the type
    /// doc for why `stopped` and `invalid` are not the same thing).
    fn consume_block(&mut self, block: &[u8]) {
        if block.is_empty() {
            return;
        }
        let first_block = !self.parse_attempted;
        self.parse_attempted = true;
        // Pin the format instead of letting needletail re-dispatch per block.
        if block[0] != FASTQ_START {
            if first_block {
                log::warn!("streamed input does not start with '@'; this path is FASTQ-only.");
                self.reject();
            } else {
                self.stopped = true;
            }
            return;
        }
        let reader_res = needletail::parse_fastx_reader(std::io::Cursor::new(block));
        let mut reader = match reader_res {
            Ok(r) => r,
            Err(_) => {
                if first_block {
                    self.reject();
                } else {
                    self.stopped = true;
                }
                return;
            }
        };
        while let Some(record) = reader.next() {
            if let Some(cap) = self.max_reads {
                if self.state.n_read >= cap {
                    break;
                }
            }
            match record {
                Ok(record) => self.state.push_record(&record.seq()),
                // The one-shot loop `continue`s here, but needletail has already
                // set `finished`, so its very next `next()` returns None: a bad
                // record ends the parse for good. Reproduce that exactly.
                Err(_) => {
                    self.stopped = true;
                    break;
                }
            }
        }
    }

    /// Flush the carry (a last record with no trailing newline is still valid)
    /// and produce the sketch. `None` if the stream was not valid fastx — the
    /// same inputs on which `sketch_sequences_from_bytes` returns `None`.
    ///
    /// Terminal: the accumulated state is moved out, so a second call returns an
    /// empty sketch. Takes `&mut self` (rather than consuming) only so callers
    /// can still read `n_reads()` after the final flush.
    pub fn finish(&mut self) -> Option<SequencesSketch> {
        if !self.is_halted() && !self.carry.is_empty() {
            let buf = std::mem::take(&mut self.carry);
            // A truncated trailing record simply yields no record, exactly as
            // the single-shot path does.
            self.consume_block(&buf);
        }
        // Empty input: `parse_fastx_reader` needs two bytes and fails with
        // EmptyFile, so the one-shot path returns None. Returning an empty
        // sketch instead would be reported to the user as "0 species detected"
        // rather than as the error it is.
        if self.bytes_fed == 0 {
            self.invalid = true;
        }
        if self.invalid {
            log::warn!("streamed input is not a valid fastq stream; skipping.");
            return None;
        }
        let name = self.sample_name.clone();
        Some(self.state.take_sketch(name))
    }
}

/// One side (R1 or R2) of a streamed pair: carry buffer plus the queue of
/// already-decoded sequences waiting for their mate.
///
/// `stopped` / `invalid` carry the same meaning as on `StreamSketcher`, with
/// one extra rule that keeps the two queues aligned: a record that needletail
/// rejects must NOT simply be skipped, or every later pair would associate
/// `R1[i+1]` with `R2[i]`. It ends decoding on that side for good, which is
/// what the one-shot lockstep loop does (needletail marks the reader finished,
/// so the next iteration breaks out).
struct PairStreamSide {
    carry: Vec<u8>,
    carry_lines: usize,
    queue: std::collections::VecDeque<Vec<u8>>,
    stopped: bool,
    invalid: bool,
    parse_attempted: bool,
    bytes_fed: usize,
}

impl PairStreamSide {
    fn new() -> PairStreamSide {
        PairStreamSide {
            carry: Vec::new(),
            carry_lines: 0,
            queue: std::collections::VecDeque::new(),
            stopped: false,
            invalid: false,
            parse_attempted: false,
            bytes_fed: 0,
        }
    }

    fn halted(&self) -> bool {
        self.stopped || self.invalid
    }

    /// Records this side can still produce: the ones already decoded, plus the
    /// one the carry may still be holding.
    ///
    /// The last record of a file with no trailing newline sits in `carry` until
    /// `flush()`, so `queue.len()` alone reads as "nothing left" while a record
    /// is in fact still coming. The JS cross-stop rule ("the other mate is over
    /// and has nothing queued, so stop this one") must never see that zero, or
    /// it cuts the surviving mate one pair too early. Over-counting is safe:
    /// a carry that turns out to hold no complete record only delays the stop.
    fn pending(&self) -> usize {
        self.queue.len() + if self.carry.is_empty() { 0 } else { 1 }
    }

    /// Decode whatever complete records `chunk` completes into `queue`.
    fn feed(&mut self, chunk: &[u8]) {
        if self.halted() {
            self.release_input();
            return;
        }
        self.bytes_fed += chunk.len();
        let from = self.carry.len();
        self.carry.extend_from_slice(chunk);
        let (cut, lines_left) = record_boundary(&self.carry, from, self.carry_lines);
        self.carry_lines = lines_left;
        if cut == 0 {
            if self.carry.len() > CARRY_MAX {
                log::warn!(
                    "streamed PE input has no fastq record boundary in {} bytes; not a FASTQ stream.",
                    self.carry.len()
                );
                self.invalid = true;
                self.release_input();
            }
            return;
        }
        let mut buf = std::mem::take(&mut self.carry);
        self.decode(&buf[..cut]);
        buf.drain(..cut);
        self.carry = buf;
        if self.halted() {
            self.release_input();
        }
    }

    fn decode(&mut self, block: &[u8]) {
        if block.is_empty() {
            return;
        }
        let first_block = !self.parse_attempted;
        self.parse_attempted = true;
        // Same format pinning as `StreamSketcher::consume_block` — see
        // `FASTQ_START`. Without it a mate containing a stray `>` at a block
        // boundary gets that block parsed as FASTA.
        if block[0] != FASTQ_START {
            if first_block {
                log::warn!("streamed PE input does not start with '@'; this path is FASTQ-only.");
                self.invalid = true;
            } else {
                self.stopped = true;
            }
            return;
        }
        let mut reader = match needletail::parse_fastx_reader(std::io::Cursor::new(block)) {
            Ok(r) => r,
            Err(_) => {
                if first_block {
                    self.invalid = true;
                } else {
                    self.stopped = true;
                }
                return;
            }
        };
        while let Some(record) = reader.next() {
            match record {
                Ok(record) => self.queue.push_back(record.seq().to_vec()),
                Err(_) => {
                    self.stopped = true;
                    break;
                }
            }
        }
    }

    fn flush(&mut self) {
        if self.halted() || self.carry.is_empty() {
            return;
        }
        let buf = std::mem::take(&mut self.carry);
        self.decode(&buf);
    }

    /// Drop the input buffer but keep the queue: records already decoded are
    /// still waiting for their mate and still count.
    fn release_input(&mut self) {
        self.carry = Vec::new();
        self.carry_lines = 0;
    }

    fn release(&mut self) {
        self.release_input();
        self.queue = std::collections::VecDeque::new();
    }
}

/// Incremental paired-end sketcher. The two streams advance independently:
/// decoded sequences pile up on whichever side is ahead, and a pair is consumed
/// as soon as both sides have one. Only the imbalance between the two streams
/// costs memory.
///
/// The caller is expected to keep that imbalance bounded (see `pair_lag`); at
/// ~184 bytes per queued read, an unbounded drift between two mates of the same
/// sample is enough to materialise a whole mate in linear memory.
pub struct PairStreamSketcher {
    state: PairSketchState,
    sample_name: String,
    max_reads: Option<usize>,
    side1: PairStreamSide,
    side2: PairStreamSide,
    invalid: bool,
    /// No further pair can ever be produced — one side has permanently stopped
    /// decoding and its queue has run dry.
    stopped: bool,
}

impl PairStreamSketcher {
    pub fn new(
        sample_name: String,
        c: usize,
        k: usize,
        no_dedup: bool,
        max_reads: Option<usize>,
    ) -> PairStreamSketcher {
        PairStreamSketcher {
            state: PairSketchState::new(c, k, no_dedup),
            sample_name,
            max_reads,
            side1: PairStreamSide::new(),
            side2: PairStreamSide::new(),
            invalid: false,
            stopped: false,
        }
    }

    /// Number of pairs sketched so far.
    pub fn n_reads(&self) -> usize {
        self.state.n_pairs
    }

    pub fn is_done(&self) -> bool {
        match self.max_reads {
            Some(cap) => self.state.n_pairs >= cap,
            None => false,
        }
    }

    /// The stream was rejected: `finish()` will return `None`.
    pub fn is_invalid(&self) -> bool {
        self.invalid
    }

    /// No further byte can change the outcome; the caller should stop reading.
    pub fn is_halted(&self) -> bool {
        self.invalid || self.stopped || self.is_done()
    }

    /// Records decoded on R1 and still waiting for their mate.
    pub fn queued_r1(&self) -> usize {
        self.side1.queue.len()
    }

    /// Records decoded on R2 and still waiting for their mate.
    pub fn queued_r2(&self) -> usize {
        self.side2.queue.len()
    }

    /// Records R1 can still deliver: decoded *and* still in the carry.
    /// This — not `queued_r1` — is what the JS cross-stop rule must test; see
    /// `PairStreamSide::pending`.
    pub fn pending_r1(&self) -> usize {
        self.side1.pending()
    }

    /// Records R2 can still deliver. See `pending_r1`.
    pub fn pending_r2(&self) -> usize {
        self.side2.pending()
    }

    /// How far ahead the leading mate is, in reads. `drain_pairs` empties one of
    /// the two queues on every call, so this is exactly the imbalance between
    /// the two streams — the only thing this sketcher buffers, and the number
    /// the JS side must keep bounded (each queued read costs ~184 bytes).
    pub fn pair_lag(&self) -> usize {
        self.side1.queue.len().max(self.side2.queue.len())
    }

    pub fn feed_r1(&mut self, chunk: &[u8]) -> usize {
        self.feed_side(true, chunk)
    }

    pub fn feed_r2(&mut self, chunk: &[u8]) -> usize {
        self.feed_side(false, chunk)
    }

    fn feed_side(&mut self, first: bool, chunk: &[u8]) -> usize {
        if self.is_halted() {
            self.release_buffers();
            return self.state.n_pairs;
        }
        if first {
            self.side1.feed(chunk);
        } else {
            self.side2.feed(chunk);
        }
        if self.side1.invalid || self.side2.invalid {
            self.reject();
            return self.state.n_pairs;
        }
        self.drain_pairs();
        if self.is_halted() {
            self.release_buffers();
        }
        self.state.n_pairs
    }

    fn drain_pairs(&mut self) {
        loop {
            if self.is_done() {
                break;
            }
            if self.side1.queue.is_empty() || self.side2.queue.is_empty() {
                break;
            }
            let s1 = self.side1.queue.pop_front().unwrap();
            let s2 = self.side2.queue.pop_front().unwrap();
            self.state.push_pair(&s1, &s2);
        }
        // A side that has stopped decoding and run out of queued records can
        // never produce another mate, so nothing the *other* side is still
        // sending can become a pair: freeze both and give the memory back.
        //
        // Not before both mates have been handed to needletail, though.
        // `sketch_pair_sequences_from_bytes` opens *both* readers and returns
        // None if either fails, before reading a single record; freezing here
        // while one side has never been looked at would skip that verdict
        // entirely (`finish()` short-circuits on `stopped`) and answer
        // `Some(empty sketch)` where the one-shot answers `None` — and which of
        // the two came out would depend on the block schedule. The delay costs
        // one block on the untouched side: the very next `feed_side` on it
        // decodes, sets `parse_attempted`, and the freeze happens then.
        if self.side1.parse_attempted
            && self.side2.parse_attempted
            && ((self.side1.stopped && self.side1.queue.is_empty())
                || (self.side2.stopped && self.side2.queue.is_empty()))
        {
            self.stopped = true;
            self.release_buffers();
        }
        // The VecDeque ring never shrinks on its own; after a burst it would
        // stay resident until the sketcher is dropped. Test the two sides
        // *separately*: the invariant of the loop above is that one of the two
        // queues is empty and the other carries the whole drift, so a condition
        // on both being empty at once almost never fires — which is exactly the
        // burst we want to give back.
        for q in [&mut self.side1.queue, &mut self.side2.queue] {
            if q.is_empty() && q.capacity() > 1 << 16 {
                q.shrink_to_fit();
            }
        }
    }

    fn release_buffers(&mut self) {
        self.side1.release();
        self.side2.release();
    }

    fn reject(&mut self) {
        self.invalid = true;
        self.state = PairSketchState::new(self.state.c, self.state.k, self.state.no_dedup);
        self.release_buffers();
    }

    /// Flush both carries, pair up whatever is left and produce the sketch.
    /// Terminal, like `StreamSketcher::finish`.
    pub fn finish(&mut self) -> Option<SequencesSketch> {
        if !self.is_halted() {
            self.side1.flush();
            self.side2.flush();
            if self.side1.invalid || self.side2.invalid {
                self.invalid = true;
            }
            self.drain_pairs();
        }
        // An empty mate makes `parse_fastx_reader` fail in the one-shot path,
        // which returns None for the whole pair. Only meaningful when we read
        // both mates to the end: once `stopped` is raised the caller is *told*
        // to stop feeding, so an empty side proves nothing about the file.
        // Skipping the check there is only sound because `drain_pairs` refuses
        // to raise `stopped` until both sides have actually been parsed: a mate
        // that never opened cannot be waved through as "fine".
        if !self.stopped && (self.side1.bytes_fed == 0 || self.side2.bytes_fed == 0) {
            self.invalid = true;
        }
        if self.invalid {
            log::warn!("streamed PE input is not a valid fastq stream; skipping.");
            return None;
        }
        let name = self.sample_name.clone();
        Some(self.state.take_sketch(name))
    }
}

// ---------------------------------------------------------------------------
// Equivalence tests: one-shot sketching vs chunk-fed streaming.
//
// The whole point of `StreamSketcher` is that it must produce *exactly* the
// same sketch as `sketch_sequences_from_bytes`, whatever the chunk boundaries.
// These tests hammer that with deliberately hostile chunk schedules: 1 byte at
// a time, 3 bytes, a size that always lands mid-quality-line, a size that lands
// exactly on a record end, and a cycling irregular schedule.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod stream_equivalence_tests {
    use super::*;

    const C: usize = 20;
    const K: usize = 31;

    /// Deterministic xorshift64* — no rand dependency, reproducible failures.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            self.0 = x;
            x.wrapping_mul(0x2545F4914F6CDD1D)
        }
        fn below(&mut self, n: usize) -> usize {
            (self.next() % (n as u64)) as usize
        }
    }

    /// Build a synthetic FASTQ.
    ///
    /// `lens` is cycled over the records, so the file mixes: reads shorter than
    /// `4k+2` (pair_kmer_single -> None), reads longer than 400 (kmer_pair ->
    /// None), and ordinary reads. Every 5th record repeats record 0's sequence
    /// so the dedup path (`kmer_to_pair_table`) actually fires. Quality lines
    /// deliberately contain '@' and '+' — a naive line-sniffing parser would
    /// desynchronise on them; needletail (4 lines per record) does not.
    fn make_fastq(n_records: usize, seed: u64, lens: &[usize], trailing_newline: bool) -> Vec<u8> {
        let mut rng = Rng(seed);
        let bases = b"ACGT";
        let mut out: Vec<u8> = Vec::new();
        let mut first_seq: Vec<u8> = Vec::new();
        for i in 0..n_records {
            let len = lens[i % lens.len()];
            let seq: Vec<u8> = if i > 0 && i % 5 == 0 && first_seq.len() == len {
                first_seq.clone()
            } else {
                (0..len).map(|_| bases[rng.below(4)]).collect()
            };
            if i == 0 {
                first_seq = seq.clone();
            }
            let qual: Vec<u8> = (0..len)
                .map(|j| if j % 17 == 0 { b'@' } else if j % 13 == 0 { b'+' } else { b'I' })
                .collect();
            out.extend_from_slice(format!("@read_{:06} some description\n", i).as_bytes());
            out.extend_from_slice(&seq);
            out.push(b'\n');
            out.extend_from_slice(b"+\n");
            out.extend_from_slice(&qual);
            out.push(b'\n');
        }
        if !trailing_newline {
            out.pop();
        }
        out
    }

    /// Drop one character from the quality line of record `idx` — the classic
    /// truncated-download corruption. needletail rejects it (UnequalLengths)
    /// and, crucially, never parses another record afterwards.
    fn corrupt_quality(fastq: &[u8], idx: usize) -> Vec<u8> {
        let mut lines: Vec<Vec<u8>> = fastq.split(|b| *b == b'\n').map(|l| l.to_vec()).collect();
        let qual = 4 * idx + 3;
        assert!(lines[qual].len() > 1, "quality line {} too short to corrupt", qual);
        lines[qual].pop();
        lines.join(&b'\n')
    }

    /// Feed `bytes` through a `StreamSketcher` using a cycling chunk schedule.
    /// Returns None on exactly the inputs the one-shot path rejects.
    fn stream_single_opt(
        bytes: &[u8],
        schedule: &[usize],
        max_reads: Option<usize>,
    ) -> (Option<SequencesSketch>, usize) {
        let mut s = StreamSketcher::new("browser_sample".to_string(), C, K, false, max_reads);
        let mut i = 0usize;
        let mut step = 0usize;
        while i < bytes.len() {
            let n = schedule[step % schedule.len()].min(bytes.len() - i);
            assert!(n > 0, "chunk schedule must not contain 0");
            s.feed(&bytes[i..i + n]);
            i += n;
            step += 1;
            if s.is_done() {
                break;
            }
        }
        let sketch = s.finish();
        (sketch, s.n_reads())
    }

    fn stream_single(
        bytes: &[u8],
        schedule: &[usize],
        max_reads: Option<usize>,
    ) -> (SequencesSketch, usize) {
        let (sketch, n) = stream_single_opt(bytes, schedule, max_reads);
        (sketch.expect("stream finish"), n)
    }

    fn assert_same(label: &str, a: &SequencesSketch, b: &SequencesSketch) {
        assert_eq!(a.kmer_counts.len(), b.kmer_counts.len(), "{}: kmer_counts size", label);
        assert_eq!(a.kmer_counts, b.kmer_counts, "{}: kmer_counts", label);
        assert_eq!(
            a.mean_read_length.to_bits(),
            b.mean_read_length.to_bits(),
            "{}: mean_read_length {} vs {}",
            label,
            a.mean_read_length,
            b.mean_read_length
        );
        assert_eq!(a.c, b.c, "{}: c", label);
        assert_eq!(a.k, b.k, "{}: k", label);
        assert_eq!(a.paired, b.paired, "{}: paired", label);
    }

    #[test]
    fn single_end_streaming_matches_one_shot() {
        // 150 = ordinary, 151 = odd length, 60 = below 4k+2, 420/500 = >400.
        let lens = [150usize, 151, 60, 420, 500];
        let fastq = make_fastq(200, 0xC0FFEE, &lens, true);
        let reference = sketch_sequences_from_bytes(
            &fastq,
            "browser_sample".to_string(),
            C,
            K,
            false,
            None,
        )
        .expect("reference sketch");
        assert!(
            reference.kmer_counts.len() > 100,
            "test FASTQ too small to prove anything: {} kmers",
            reference.kmer_counts.len()
        );

        // A uniform-length file lets us hit a record boundary exactly.
        let uniform = make_fastq(120, 0xBEEF, &[150usize], true);
        let rec_len = uniform.len() / 120;
        assert_eq!(rec_len * 120, uniform.len());
        let uniform_ref =
            sketch_sequences_from_bytes(&uniform, "browser_sample".to_string(), C, K, false, None)
                .expect("reference sketch");

        for schedule in [
            vec![usize::MAX],       // whole file in one chunk
            vec![1],                // one byte at a time
            vec![3],                // 3 bytes
            vec![7],
            vec![64],
            vec![997],              // prime, lands anywhere
            vec![1, 7, 3, 1000, 13, 2, 511], // irregular
            vec![100000],           // bigger than the file
        ] {
            let (streamed, n) = stream_single(&fastq, &schedule, None);
            assert_eq!(n, 200, "schedule {:?}: read count", schedule);
            assert_same(&format!("schedule {:?}", schedule), &reference, &streamed);
        }

        for schedule in [
            vec![rec_len],          // exactly on a record end, every time
            vec![rec_len - 1],      // always one byte short of a record end
            vec![rec_len / 2],      // lands mid-sequence / mid-quality line
            vec![rec_len * 3 + 1],
            vec![rec_len - 2, 1, 1], // record end reached by 1-byte dribbles
        ] {
            let (streamed, n) = stream_single(&uniform, &schedule, None);
            assert_eq!(n, 120, "uniform schedule {:?}: read count", schedule);
            assert_same(
                &format!("uniform schedule {:?}", schedule),
                &uniform_ref,
                &streamed,
            );
        }
    }

    #[test]
    fn single_end_streaming_without_trailing_newline() {
        let lens = [150usize, 151, 60, 420, 500];
        let fastq = make_fastq(50, 0x1234, &lens, false);
        let reference =
            sketch_sequences_from_bytes(&fastq, "browser_sample".to_string(), C, K, false, None)
                .expect("reference sketch");
        for schedule in [vec![usize::MAX], vec![1], vec![3], vec![257]] {
            let (streamed, n) = stream_single(&fastq, &schedule, None);
            assert_eq!(n, 50, "schedule {:?}: read count (last record flushed)", schedule);
            assert_same(&format!("no-newline {:?}", schedule), &reference, &streamed);
        }
    }

    #[test]
    fn single_end_streaming_respects_max_reads() {
        let lens = [150usize, 151, 60, 420, 500];
        let fastq = make_fastq(200, 0x5EED, &lens, true);
        for cap in [1usize, 37, 199, 200, 500] {
            let reference = sketch_sequences_from_bytes(
                &fastq,
                "browser_sample".to_string(),
                C,
                K,
                false,
                Some(cap),
            )
            .expect("reference sketch");
            for schedule in [vec![5usize], vec![1], vec![1024]] {
                let (streamed, n) = stream_single(&fastq, &schedule, Some(cap));
                assert_eq!(n, cap.min(200), "cap {} schedule {:?}", cap, schedule);
                assert_same(&format!("cap {} schedule {:?}", cap, schedule), &reference, &streamed);
            }
        }
    }

    /// Feed R1 and R2 with *independent* schedules, including the pathological
    /// case where one whole mate arrives before the other starts.
    fn stream_pair_opt(
        r1: &[u8],
        r2: &[u8],
        sched1: &[usize],
        sched2: &[usize],
        interleave: bool,
        max_reads: Option<usize>,
    ) -> (Option<SequencesSketch>, usize) {
        let mut s = PairStreamSketcher::new("browser_sample".to_string(), C, K, false, max_reads);
        let mut i1 = 0usize;
        let mut i2 = 0usize;
        let mut st1 = 0usize;
        let mut st2 = 0usize;
        if !interleave {
            while i1 < r1.len() {
                let n = sched1[st1 % sched1.len()].min(r1.len() - i1);
                s.feed_r1(&r1[i1..i1 + n]);
                i1 += n;
                st1 += 1;
            }
        }
        while i1 < r1.len() || i2 < r2.len() {
            if i1 < r1.len() {
                let n = sched1[st1 % sched1.len()].min(r1.len() - i1);
                s.feed_r1(&r1[i1..i1 + n]);
                i1 += n;
                st1 += 1;
            }
            if i2 < r2.len() {
                let n = sched2[st2 % sched2.len()].min(r2.len() - i2);
                s.feed_r2(&r2[i2..i2 + n]);
                i2 += n;
                st2 += 1;
            }
            if s.is_done() {
                break;
            }
        }
        let sketch = s.finish();
        (sketch, s.n_reads())
    }

    fn stream_pair(
        r1: &[u8],
        r2: &[u8],
        sched1: &[usize],
        sched2: &[usize],
        interleave: bool,
        max_reads: Option<usize>,
    ) -> (SequencesSketch, usize) {
        let (sketch, n) = stream_pair_opt(r1, r2, sched1, sched2, interleave, max_reads);
        (sketch.expect("pair stream finish"), n)
    }

    #[test]
    fn paired_end_streaming_matches_one_shot() {
        let lens1 = [150usize, 151, 60, 420, 500];
        let lens2 = [150usize, 149, 500, 60, 151];
        let r1 = make_fastq(150, 0xAAAA, &lens1, true);
        let r2 = make_fastq(150, 0xBBBB, &lens2, true);
        let reference = sketch_pair_sequences_from_bytes(
            &r1,
            &r2,
            "browser_sample".to_string(),
            C,
            K,
            false,
            None,
        )
        .expect("reference PE sketch");
        assert!(reference.kmer_counts.len() > 100);

        let cases: Vec<(Vec<usize>, Vec<usize>, bool)> = vec![
            (vec![usize::MAX], vec![usize::MAX], true),
            (vec![1], vec![1], true),
            (vec![1], vec![9973], true),          // wildly unbalanced rates
            (vec![3], vec![rec_ish()], true),
            (vec![1, 5, 700], vec![13, 2, 4096], true),
            (vec![64], vec![64], false),          // all of R1 before any of R2
            (vec![usize::MAX], vec![7], false),
        ];
        for (s1, s2, inter) in cases {
            let (streamed, n) = stream_pair(&r1, &r2, &s1, &s2, inter, None);
            assert_eq!(n, 150, "PE {:?}/{:?} inter={}", s1, s2, inter);
            assert_same(
                &format!("PE {:?}/{:?} inter={}", s1, s2, inter),
                &reference,
                &streamed,
            );
        }
    }

    fn rec_ish() -> usize {
        // 150bp record: header + seq + '+' + qual, roughly; any mid-record size.
        183
    }

    #[test]
    fn paired_end_streaming_respects_max_reads() {
        let lens1 = [150usize, 151, 60, 420, 500];
        let lens2 = [150usize, 149, 500, 60, 151];
        let r1 = make_fastq(150, 0xAAAA, &lens1, true);
        let r2 = make_fastq(150, 0xBBBB, &lens2, true);
        for cap in [1usize, 23, 149, 150, 400] {
            let reference = sketch_pair_sequences_from_bytes(
                &r1,
                &r2,
                "browser_sample".to_string(),
                C,
                K,
                false,
                Some(cap),
            )
            .expect("reference PE sketch");
            let (streamed, n) = stream_pair(&r1, &r2, &[11], &[257], true, Some(cap));
            assert_eq!(n, cap.min(150), "PE cap {}", cap);
            assert_same(&format!("PE cap {}", cap), &reference, &streamed);
        }
    }

    /// Unequal mate counts: the shorter stream decides, exactly as the
    /// lockstep one-shot loop does.
    #[test]
    fn paired_end_streaming_handles_unequal_mates() {
        let lens = [150usize, 151, 60];
        let r1 = make_fastq(90, 0xCAFE, &lens, true);
        let r2 = make_fastq(60, 0xF00D, &lens, true);
        let reference = sketch_pair_sequences_from_bytes(
            &r1,
            &r2,
            "browser_sample".to_string(),
            C,
            K,
            false,
            None,
        )
        .expect("reference PE sketch");
        let (streamed, n) = stream_pair(&r1, &r2, &[1], &[3], true, None);
        assert_eq!(n, 60);
        assert_same("PE unequal", &reference, &streamed);
    }

    // -----------------------------------------------------------------------
    // Stop semantics. needletail stops for good at the first malformed record;
    // rebuilding a reader per block used to restart the parse, which made the
    // read count (and the TSV) a function of the chunk schedule.
    // -----------------------------------------------------------------------

    #[test]
    fn single_end_streaming_stops_at_malformed_record() {
        let lens = [150usize, 151, 60, 420, 500];
        let good = make_fastq(40, 0xBAD5EED, &lens, true);
        for bad in [0usize, 1, 7, 23, 39] {
            let fastq = corrupt_quality(&good, bad);
            let reference =
                sketch_sequences_from_bytes(&fastq, "browser_sample".to_string(), C, K, false, None)
                    .expect("one-shot still returns a (partial) sketch");
            for schedule in [
                vec![usize::MAX],
                vec![1],
                vec![7],
                vec![64],
                vec![997],
                vec![1, 7, 3, 1000, 13, 2, 511],
                vec![1 << 20],
            ] {
                let (streamed, n) = stream_single(&fastq, &schedule, None);
                assert_eq!(
                    n, bad,
                    "bad record {} schedule {:?}: must sketch exactly the records before it",
                    bad, schedule
                );
                assert_same(
                    &format!("malformed record {} schedule {:?}", bad, schedule),
                    &reference,
                    &streamed,
                );
            }
        }
    }

    /// The one-shot PE loop advances both readers together, so a bad record on
    /// one mate ends the *pair* stream. Skipping it on one side only would
    /// shift that queue and mis-mate every pair after it.
    #[test]
    fn paired_end_streaming_stops_at_malformed_record() {
        let lens1 = [150usize, 151, 60, 420, 500];
        let lens2 = [150usize, 149, 500, 60, 151];
        let g1 = make_fastq(12, 0xAAAA, &lens1, true);
        let g2 = make_fastq(12, 0xBBBB, &lens2, true);
        let cases: [(Option<usize>, Option<usize>); 5] = [
            (Some(3), None),
            (None, Some(5)),
            (Some(3), Some(9)),
            (Some(9), Some(3)),
            (Some(0), None),
        ];
        for (bad1, bad2) in cases {
            let r1 = match bad1 {
                Some(i) => corrupt_quality(&g1, i),
                None => g1.clone(),
            };
            let r2 = match bad2 {
                Some(i) => corrupt_quality(&g2, i),
                None => g2.clone(),
            };
            let expect = bad1.unwrap_or(12).min(bad2.unwrap_or(12));
            let reference = sketch_pair_sequences_from_bytes(
                &r1,
                &r2,
                "browser_sample".to_string(),
                C,
                K,
                false,
                None,
            )
            .expect("one-shot PE still returns a (partial) sketch");
            let schedules: Vec<(Vec<usize>, Vec<usize>, bool)> = vec![
                (vec![usize::MAX], vec![usize::MAX], true),
                (vec![1], vec![1], true),
                (vec![500], vec![500], true),
                (vec![1], vec![9973], true),
                (vec![64], vec![64], false), // all of R1 before any of R2
                (vec![usize::MAX], vec![7], false),
            ];
            for (s1, s2, inter) in schedules {
                let (streamed, n) = stream_pair(&r1, &r2, &s1, &s2, inter, None);
                let label = format!(
                    "PE bad {:?}/{:?} {:?}/{:?} inter={}",
                    bad1, bad2, s1, s2, inter
                );
                assert_eq!(n, expect, "{}: pair count", label);
                assert_same(&label, &reference, &streamed);
            }
        }
    }

    /// `streamCore` concatenates the runs of one sample with no separator, so
    /// the reference is the one-shot on the concatenated bytes — including when
    /// a non-final run has no trailing newline (which merges its last quality
    /// line with the next run's first header) or ends with blank lines.
    #[test]
    fn single_end_streaming_across_concatenated_files() {
        let lens = [150usize, 151, 60];
        let a_nl = make_fastq(10, 0x11, &lens, true);
        let a_no_nl = make_fastq(10, 0x11, &lens, false);
        let b = make_fastq(10, 0x22, &lens, true);
        let c = make_fastq(10, 0x33, &lens, true);

        let cat = |parts: &[&[u8]]| -> Vec<u8> {
            let mut v = Vec::new();
            for p in parts {
                v.extend_from_slice(p);
            }
            v
        };
        let cases: Vec<(&str, Vec<u8>)> = vec![
            ("clean 3 runs", cat(&[&a_nl, &b, &c])),
            ("run 1 without trailing newline", cat(&[&a_no_nl, &b, &c])),
            ("blank line between runs", cat(&[&a_nl, b"\n", &b])),
            ("three blank lines between runs", cat(&[&a_nl, b"\n\n\n", &b])),
            ("run 2 without trailing newline", cat(&[&a_nl, &a_no_nl, &c])),
        ];
        for (label, bytes) in cases {
            let reference =
                sketch_sequences_from_bytes(&bytes, "browser_sample".to_string(), C, K, false, None)
                    .expect("one-shot on the concatenation");
            for schedule in [
                vec![usize::MAX],
                vec![1],
                vec![64],
                vec![997],
                vec![1, 7, 3, 1000, 13, 2, 511],
            ] {
                let (streamed, _) = stream_single(&bytes, &schedule, None);
                assert_same(&format!("{} schedule {:?}", label, schedule), &reference, &streamed);
            }
        }
    }

    /// Every truncation of a FASTQ, plus a handful of degenerate inputs: the
    /// streaming path must return `None` on exactly the inputs the one-shot
    /// path rejects, and the same sketch on all the others. An empty sketch
    /// where `profile()` errored shows up in the UI as "0 species detected".
    #[test]
    fn truncated_and_degenerate_inputs_match_one_shot() {
        let fastq = make_fastq(12, 0x777, &[150usize, 60, 420], true);
        let mut cuts: Vec<usize> = (0..40.min(fastq.len())).collect();
        cuts.extend((40..fastq.len()).step_by(7));
        cuts.push(fastq.len());
        for cut in cuts {
            let prefix = &fastq[..cut];
            let reference =
                sketch_sequences_from_bytes(prefix, "browser_sample".to_string(), C, K, false, None);
            for schedule in [vec![usize::MAX], vec![1], vec![7], vec![997]] {
                let (streamed, _) = stream_single_opt(prefix, &schedule, None);
                match (&reference, &streamed) {
                    (None, None) => {}
                    (Some(a), Some(b)) => {
                        assert_same(&format!("prefix {} schedule {:?}", cut, schedule), a, b)
                    }
                    (r, s) => panic!(
                        "prefix {} schedule {:?}: one-shot {} vs streaming {}",
                        cut,
                        schedule,
                        r.is_some(),
                        s.is_some()
                    ),
                }
            }
        }

        // FASTA is excluded on purpose (see `FASTQ_START`): it has its own test
        // below, because the streaming path answers None where the one-shot
        // answers Some.
        let degenerate: Vec<&[u8]> = vec![
            b"",
            b"@",
            b"x",
            b"xy",
            b"hello\nworld\n",
            b"@only a header\n",
            b"@h\nACGT\n+\nIIII\n\n\n",
        ];
        for input in degenerate {
            let reference =
                sketch_sequences_from_bytes(input, "browser_sample".to_string(), C, K, false, None);
            for schedule in [vec![usize::MAX], vec![1], vec![3]] {
                let (streamed, _) = stream_single_opt(input, &schedule, None);
                assert_eq!(
                    reference.is_some(),
                    streamed.is_some(),
                    "degenerate {:?} schedule {:?}: one-shot Some={} streaming Some={}",
                    String::from_utf8_lossy(input),
                    schedule,
                    reference.is_some(),
                    streamed.is_some()
                );
                if let (Some(a), Some(b)) = (&reference, &streamed) {
                    assert_same(&format!("degenerate {:?}", String::from_utf8_lossy(input)), a, b);
                }
            }
        }
    }

    /// An input with no record boundary (single-line FASTA, CR-only endings)
    /// must be rejected instead of growing the carry until linear memory dies.
    #[test]
    fn carry_cap_rejects_input_without_record_boundaries() {
        let mut s = StreamSketcher::new("browser_sample".to_string(), C, K, false, None);
        let chunk = vec![b'A'; 1 << 20];
        let mut fed = 0usize;
        for _ in 0..64 {
            s.feed(&chunk);
            fed += chunk.len();
            if s.is_halted() {
                break;
            }
        }
        assert!(s.is_invalid(), "no-newline input must be rejected");
        assert!(
            fed <= (CARRY_MAX + 2 * (1 << 20)),
            "carry grew to {} bytes before being capped",
            fed
        );
        assert!(s.finish().is_none());

        // Same guard on both mates of a pair.
        let mut p = PairStreamSketcher::new("browser_sample".to_string(), C, K, false, None);
        let mut fed_pe = 0usize;
        for _ in 0..64 {
            p.feed_r1(&chunk);
            fed_pe += chunk.len();
            if p.is_halted() {
                break;
            }
        }
        assert!(p.is_invalid());
        assert!(fed_pe <= (CARRY_MAX + 2 * (1 << 20)));
        assert!(p.finish().is_none());
    }

    /// `pair_lag` is what the JS side throttles on: without it, nothing bounds
    /// the number of decoded reads the leading mate piles up in linear memory.
    #[test]
    fn pair_lag_reports_the_imbalance() {
        let lens = [150usize, 151, 60];
        let r1 = make_fastq(100, 0xAAAA, &lens, true);
        let r2 = make_fastq(100, 0xBBBB, &lens, true);
        let mut s = PairStreamSketcher::new("browser_sample".to_string(), C, K, false, None);
        assert_eq!(s.pair_lag(), 0);

        // Whole mate 1 before mate 2 starts: worst case for the queue.
        s.feed_r1(&r1);
        assert_eq!(s.queued_r1(), 100, "every R1 record is buffered");
        assert_eq!(s.queued_r2(), 0);
        assert_eq!(s.pair_lag(), 100, "lag == records waiting for their mate");

        // Half of mate 2 drains half the queue.
        let half = r2.len() / 2;
        let cut = 1 + r2[..half].iter().rposition(|b| *b == b'\n').unwrap();
        s.feed_r2(&r2[..cut]);
        let drained = s.n_reads();
        assert!(drained > 0 && drained < 100, "drained {}", drained);
        assert_eq!(s.pair_lag(), 100 - drained);

        s.feed_r2(&r2[cut..]);
        assert_eq!(s.pair_lag(), 0);
        assert_eq!(s.n_reads(), 100);
        assert!(s.finish().is_some());
    }

    // -----------------------------------------------------------------------
    // Format pinning. needletail picks its parser from the first byte of what
    // it is handed; handing it one block per feed used to re-take that decision
    // on every block, so a block starting with '>' was read as FASTA in the
    // middle of a FASTQ sample. See `FASTQ_START`.
    // -----------------------------------------------------------------------

    /// A multi-line FASTA "contig file" — the thing a user picks by mistake
    /// among their run files (the `accept=".gz"` filter does not stop it, and
    /// drag & drop ignores `accept` altogether).
    fn make_fasta(n_contigs: usize, seed: u64, lines: usize, line_len: usize) -> Vec<u8> {
        let mut rng = Rng(seed);
        let bases = b"ACGT";
        let mut out: Vec<u8> = Vec::new();
        for i in 0..n_contigs {
            out.extend_from_slice(format!(">contig_{}\n", i).as_bytes());
            for _ in 0..lines {
                for _ in 0..line_len {
                    out.push(bases[rng.below(4)]);
                }
                out.push(b'\n');
            }
        }
        out
    }

    /// One FASTA file concatenated between two runs of FASTQ. A chunk boundary
    /// that lands on the '>' used to hand that block to needletail's FASTA
    /// reader, which sketched a quality line as if it were a sequence: the read
    /// count, and therefore the TSV, went back to depending on the chunk size.
    #[test]
    fn fasta_run_file_in_the_middle_does_not_reopen_a_fasta_reader() {
        let lens = [150usize, 151, 60];
        let mut bytes = make_fastq(20, 0x51DE, &lens, true);
        bytes.extend_from_slice(&make_fasta(3, 0xFA57A, 4, 60));
        bytes.extend_from_slice(&make_fastq(20, 0x51DF, &lens, true));

        let reference =
            sketch_sequences_from_bytes(&bytes, "browser_sample".to_string(), C, K, false, None)
                .expect("one-shot sketches the FASTQ prefix and stops at the '>'");
        for schedule in [
            vec![usize::MAX],
            vec![1],
            vec![7],
            vec![64],
            vec![997],
            vec![1 << 20],
            vec![1, 7, 3, 1000, 13, 2, 511],
        ] {
            let (streamed, n) = stream_single(&bytes, &schedule, None);
            assert_eq!(n, 20, "schedule {:?}: records before the FASTA only", schedule);
            assert_same(&format!("fasta in the middle {:?}", schedule), &reference, &streamed);
        }
    }

    /// Same trap on the paired-end side: `PairStreamSide::decode` had the same
    /// per-block `parse_fastx_reader`.
    #[test]
    fn paired_end_gt_at_block_boundary_does_not_reopen_a_fasta_reader() {
        let lens = [150usize, 151, 60];
        let mut r1 = make_fastq(5, 0xA1, &lens, true);
        r1.extend_from_slice(&make_fasta(2, 0xFA, 4, 60));
        r1.extend_from_slice(&make_fastq(5, 0xA2, &lens, true));
        let r2 = make_fastq(12, 0xB1, &lens, true);
        let reference = sketch_pair_sequences_from_bytes(
            &r1,
            &r2,
            "browser_sample".to_string(),
            C,
            K,
            false,
            None,
        )
        .expect("one-shot PE sketch");
        for (s1, s2) in [
            (vec![usize::MAX], vec![usize::MAX]),
            (vec![1], vec![1]),
            (vec![64], vec![64]),
            (vec![997], vec![7]),
            (vec![1 << 20], vec![1 << 20]),
        ] {
            let (streamed, n) = stream_pair(&r1, &r2, &s1, &s2, true, None);
            assert_eq!(n, 5, "PE {:?}/{:?}: pairs before the FASTA", s1, s2);
            assert_same(&format!("PE fasta {:?}/{:?}", s1, s2), &reference, &streamed);
        }
    }

    /// FASTA in, error out. This is the one deliberate divergence from
    /// `sketch_sequences_from_bytes` (which reads FASTA happily): the 4-line
    /// split has no meaning there, so the streaming path refuses the file
    /// instead of producing a sketch that matches nothing. `None` is what the
    /// worker turns into a visible "not a valid FASTQ" error.
    #[test]
    fn fasta_is_refused_instead_of_silently_chopped() {
        let multiline = make_fasta(4, 0x3, 4, 60);
        let singleline = make_fasta(4, 0x4, 1, 4000);
        let oneshot_multi = sketch_sequences_from_bytes(
            &multiline,
            "browser_sample".to_string(),
            C,
            K,
            false,
            None,
        )
        .expect("the one-shot path does read FASTA");
        assert!(
            oneshot_multi.kmer_counts.len() > 10,
            "the FASTA must be big enough for the divergence to matter"
        );

        for (label, bytes) in [("multi-line", &multiline), ("single-line", &singleline)] {
            for schedule in [vec![usize::MAX], vec![1], vec![64], vec![997]] {
                let mut s =
                    StreamSketcher::new("browser_sample".to_string(), C, K, false, None);
                let mut i = 0usize;
                let mut step = 0usize;
                while i < bytes.len() {
                    let n = schedule[step % schedule.len()].min(bytes.len() - i);
                    s.feed(&bytes[i..i + n]);
                    i += n;
                    step += 1;
                }
                assert!(
                    s.finish().is_none(),
                    "{} FASTA schedule {:?}: must be refused, not sketched",
                    label,
                    schedule
                );
                assert!(s.is_invalid(), "{} FASTA schedule {:?}", label, schedule);
            }
        }

        // Same verdict on both mates of a pair, whichever one is the FASTA.
        let fastq = make_fastq(10, 0x5, &[150usize], true);
        for (r1, r2) in [(&multiline, &fastq), (&fastq, &multiline)] {
            let (streamed, _) = stream_pair_opt(r1, r2, &[64], &[64], true, None);
            assert!(streamed.is_none(), "PE with a FASTA mate must be refused");
        }
    }

    // -----------------------------------------------------------------------
    // Paired-end stop semantics.
    // -----------------------------------------------------------------------

    /// The one-shot PE path opens *both* readers before reading anything and
    /// returns None if either fails. So a mate that has never been parsed must
    /// not be waved through: freezing the sketcher on the other mate's stop
    /// would answer `Some(empty sketch)` — "0 species detected" — where
    /// `profile_pe()` raises an error, and *which* of the two came out would
    /// depend on the order the blocks happened to arrive in.
    #[test]
    fn paired_end_never_waves_through_an_unparsed_mate() {
        let lens = [150usize, 151, 60];
        // R1 is not fastx at all: the leading '@' is gone (a .txt, a BAM, a
        // truncated .gz — anything whose first byte is not '@'/'>').
        let mut r1 = make_fastq(12, 0xDEAD, &lens, true);
        r1.remove(0);
        // R2's very first record is malformed, so R2 stops before R1 has had a
        // chance to be looked at.
        let r2 = corrupt_quality(&make_fastq(12, 0xBEEF, &lens, true), 0);

        let reference = sketch_pair_sequences_from_bytes(
            &r1,
            &r2,
            "browser_sample".to_string(),
            C,
            K,
            false,
            None,
        );
        assert!(reference.is_none(), "one-shot rejects the pair on R1");

        for (s1, s2) in [
            (vec![1usize], vec![usize::MAX]),
            (vec![7], vec![usize::MAX]),
            (vec![64], vec![997]),
            (vec![1], vec![1]),
            (vec![usize::MAX], vec![usize::MAX]),
            (vec![usize::MAX], vec![7]),
        ] {
            let (streamed, n) = stream_pair_opt(&r1, &r2, &s1, &s2, true, None);
            assert!(
                streamed.is_none(),
                "PE {:?}/{:?}: one-shot says None, streaming said Some({} pairs)",
                s1,
                s2,
                n
            );
        }
    }

    /// Once one mate has stopped for good with an empty queue, no read of the
    /// other mate can ever be paired. The sketcher must freeze *both* sides —
    /// `min(q1, q2)` alone keeps the pair count right but lets the surviving
    /// mate pile its whole file into linear memory.
    #[test]
    fn paired_end_stop_freezes_both_mates() {
        let lens = [150usize, 151, 60];
        let r1 = corrupt_quality(&make_fastq(12, 0xAAAA, &lens, true), 2);
        let r2 = make_fastq(12, 0xBBBB, &lens, true);
        let reference = sketch_pair_sequences_from_bytes(
            &r1,
            &r2,
            "browser_sample".to_string(),
            C,
            K,
            false,
            None,
        )
        .expect("one-shot PE sketch");

        let mut p = PairStreamSketcher::new("browser_sample".to_string(), C, K, false, None);
        p.feed_r1(&r1); // R1 decodes records 0 and 1, then stops on record 2
        assert_eq!(p.queued_r1(), 2);
        assert!(!p.is_halted(), "R1 still has two records to pair");

        // R2 arrives record by record. The 2nd one empties R1's queue: from
        // there on nothing can be paired again.
        let mut cuts: Vec<usize> = Vec::new();
        let mut seen = 0usize;
        for (i, b) in r2.iter().enumerate() {
            if *b == b'\n' {
                seen += 1;
                if seen % 4 == 0 {
                    cuts.push(i + 1);
                }
            }
        }
        let mut prev = 0usize;
        for (idx, cut) in cuts.iter().enumerate() {
            p.feed_r2(&r2[prev..*cut]);
            prev = *cut;
            if idx >= 1 {
                assert!(p.is_halted(), "after the 2nd R2 record the pair stream is frozen");
                assert_eq!(p.queued_r2(), 0, "R2 record {} was buffered anyway", idx);
                assert_eq!(p.pending_r2(), 0, "R2 record {} left pending", idx);
                assert_eq!(p.n_reads(), 2, "pairs must stay at 2");
            }
        }
        assert_eq!(p.n_reads(), 2);
        let streamed = p.finish().expect("still a valid (partial) sketch");
        assert_same("PE frozen after R1 stopped", &reference, &streamed);
    }

    // -----------------------------------------------------------------------
    // "Halted means halted": no byte handed to a finished sketcher may be
    // parsed, sketched, or even buffered. The end-of-`feed` cleanup is not
    // enough — it runs *after* the block has been consumed.
    // -----------------------------------------------------------------------

    /// A malformed record ends the sample for good. Bytes that arrive later
    /// (the next run file of the same sample, say) must not be sketched: the
    /// one-shot reader is finished and never looks at them.
    #[test]
    fn single_end_feed_is_inert_once_halted() {
        let lens = [150usize, 151, 60];
        let head = corrupt_quality(&make_fastq(12, 0x1010, &lens, true), 3);
        let tail = make_fastq(10, 0x2020, &lens, true); // perfectly valid FASTQ
        let mut both = head.clone();
        both.extend_from_slice(&tail);
        let reference =
            sketch_sequences_from_bytes(&both, "browser_sample".to_string(), C, K, false, None)
                .expect("one-shot stops at the bad record");

        let mut s = StreamSketcher::new("browser_sample".to_string(), C, K, false, None);
        s.feed(&head);
        assert!(s.is_halted(), "the bad record must halt the sketcher");
        assert_eq!(s.n_reads(), 3);
        let fed_at_halt = s.bytes_fed;

        s.feed(&tail);
        assert_eq!(s.n_reads(), 3, "records after the halt were sketched anyway");
        assert_eq!(s.bytes_fed, fed_at_halt, "bytes were accepted after the halt");
        assert!(s.carry.is_empty(), "carry was refilled after the halt");

        let streamed = s.finish().expect("partial sketch");
        assert_same("halted then fed again", &reference, &streamed);
    }

    /// Same rule for the pair sketcher: `feed_r1`/`feed_r2` after the halt must
    /// not even copy the chunk into a carry, let alone decode it into records.
    #[test]
    fn paired_end_feed_is_inert_once_halted() {
        let lens = [150usize, 151, 60];
        let r1 = corrupt_quality(&make_fastq(12, 0xAAAA, &lens, true), 2);
        let r2 = make_fastq(12, 0xBBBB, &lens, true);
        let mut p = PairStreamSketcher::new("browser_sample".to_string(), C, K, false, None);
        p.feed_r1(&r1);
        // Feed R2 in halves; the first half is enough to drain R1's two records
        // and freeze the sketcher.
        let half = 1 + r2[..r2.len() / 2].iter().rposition(|b| *b == b'\n').unwrap();
        p.feed_r2(&r2[..half]);
        assert!(p.is_halted(), "R1 stopped and its queue is empty");
        let (f1, f2) = (p.side1.bytes_fed, p.side2.bytes_fed);
        let pairs = p.n_reads();

        p.feed_r2(&r2[half..]);
        p.feed_r1(&r1);
        assert_eq!(p.side1.bytes_fed, f1, "R1 accepted bytes after the halt");
        assert_eq!(p.side2.bytes_fed, f2, "R2 accepted bytes after the halt");
        assert_eq!(p.n_reads(), pairs);
        assert!(p.side1.carry.is_empty() && p.side2.carry.is_empty());
        assert_eq!(p.queued_r1() + p.queued_r2(), 0, "records decoded after the halt");
    }

    /// The pairing ring is the one buffer that can hold ~100 000 reads. Once a
    /// side has been drained it must give that memory back — and the drain is
    /// one-sided by construction (`drain_pairs` empties the *shorter* queue),
    /// so the release has to be tested per side, not on both at once.
    #[test]
    fn drained_pairing_queue_gives_its_ring_back() {
        // Tiny records: this test is about the ring's slot count, not the reads.
        let n = 70_000usize; // > 1<<16 slots, the threshold in drain_pairs
        let mut r1: Vec<u8> = Vec::new();
        let mut r2: Vec<u8> = Vec::new();
        for i in 0..n {
            r1.extend_from_slice(format!("@a{}\nACGTACGTACGTACGTACGTACGTACGTACGT\n+\nIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII\n", i).as_bytes());
            r2.extend_from_slice(format!("@b{}\nTGCATGCATGCATGCATGCATGCATGCATGCA\n+\nIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII\n", i).as_bytes());
        }
        // One extra R2 record, so R2's queue is NOT empty when R1's is: exactly
        // the steady state of two mates drifting apart.
        r2.extend_from_slice(b"@b_extra\nTGCATGCATGCATGCATGCATGCATGCATGCA\n+\nIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII\n");

        let mut p = PairStreamSketcher::new("browser_sample".to_string(), C, K, false, None);
        p.feed_r1(&r1);
        assert!(
            p.side1.queue.capacity() > 1 << 16,
            "the ring did not grow: {} slots",
            p.side1.queue.capacity()
        );
        p.feed_r2(&r2);
        assert_eq!(p.n_reads(), n);
        assert!(
            !p.side2.queue.is_empty(),
            "R2 must still hold its extra record — that is the whole point"
        );
        assert!(
            p.side1.queue.capacity() <= 1 << 16,
            "the drained R1 ring kept {} slots",
            p.side1.queue.capacity()
        );
    }

    /// The rule `fastq-trim.js` applies to stop the surviving mate: "the other
    /// one is over and has nothing left". Replayed here against the sketcher it
    /// actually drives. Reading `queued_rN()` — records already decoded —
    /// answers 0 while the last record of a file with no trailing newline is
    /// still sitting in the carry, and the survivor gets cut one pair short.
    #[test]
    fn js_cross_stop_rule_keeps_the_last_pair() {
        let lens = [150usize, 151, 60];
        // R1 has no trailing newline: its last record only surfaces at flush().
        let r1 = make_fastq(3, 0x9001, &lens, false);
        let r2 = make_fastq(5, 0x9002, &lens, true);
        let reference = sketch_pair_sequences_from_bytes(
            &r1,
            &r2,
            "browser_sample".to_string(),
            C,
            K,
            false,
            None,
        )
        .expect("one-shot PE sketch");

        let mut p = PairStreamSketcher::new("browser_sample".to_string(), C, K, false, None);
        p.feed_r1(&r1); // R1's loop reaches EOF -> done[0] = true
        let done_r1 = true;

        // R2's loop, one record per chunk, polling the JS stop rule before each
        // read exactly as streamCore does.
        let rec = 1 + r2[..r2.len() / 5].iter().rposition(|b| *b == b'\n').unwrap();
        let mut i = 0usize;
        while i < r2.len() {
            if done_r1 && p.pending_r1() == 0 {
                break;
            }
            let take = rec.min(r2.len() - i);
            p.feed_r2(&r2[i..i + take]);
            i += take;
        }
        let streamed = p.finish().expect("PE sketch");
        assert_same("JS cross-stop rule", &reference, &streamed);
    }
}

// ---------------------------------------------------------------------------
// Differential fuzzing: mutated FASTQ x several chunk schedules, streaming vs
// one-shot. The targeted tests above each pin one known failure mode; this one
// is there for the modes nobody thought of. It is what caught the per-block
// `parse_fastx_reader` dispatch (135 divergences over 30 000 inputs, all of
// them a stray '>' or '@' landing on a block boundary) — the seed count here is
// cut down so the suite still runs in well under a second, and the schedule
// list is the discriminating part anyway.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod stream_fuzz_tests {
    use super::*;

    const C: usize = 20;
    const K: usize = 31;

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            self.0 = x;
            x.wrapping_mul(0x2545F4914F6CDD1D)
        }
        fn below(&mut self, n: usize) -> usize {
            (self.next() % (n as u64)) as usize
        }
    }

    /// Quality lines use the real Phred+33 alphabet, which legally contains
    /// '@' (Q31) and '>' (Q29) — the two bytes needletail dispatches on.
    fn gen_fastq(rng: &mut Rng, n: usize) -> Vec<u8> {
        let bases = b"ACGT";
        let quals: Vec<u8> = (b'!'..=b'J').collect();
        let mut out = Vec::new();
        for i in 0..n {
            let len = 30 + rng.below(120);
            out.extend_from_slice(format!("@r{} desc\n", i).as_bytes());
            for _ in 0..len {
                out.push(bases[rng.below(4)]);
            }
            out.push(b'\n');
            out.extend_from_slice(b"+\n");
            for _ in 0..len {
                out.push(quals[rng.below(quals.len())]);
            }
            out.push(b'\n');
        }
        out
    }

    /// The corruptions a real file suffers: a lost byte, an extra newline, a
    /// truncation, and the two dispatch bytes appearing where they should not.
    fn mutate(rng: &mut Rng, v: &mut Vec<u8>) {
        if v.is_empty() {
            return;
        }
        let p = rng.below(v.len());
        match rng.below(6) {
            0 => {
                v.remove(p);
            }
            1 => v.insert(p, b'\n'),
            2 => v[p] = [b'@', b'+', b'>', b'A', b'\n'][rng.below(5)],
            3 => v.truncate(p),
            4 => v.insert(p, b'>'),
            _ => v.insert(p, b'@'),
        }
    }

    fn stream_single(bytes: &[u8], sched: &[usize]) -> Option<SequencesSketch> {
        let mut s = StreamSketcher::new("s".to_string(), C, K, false, None);
        let mut i = 0usize;
        let mut step = 0usize;
        while i < bytes.len() {
            let n = sched[step % sched.len()].min(bytes.len() - i);
            s.feed(&bytes[i..i + n]);
            i += n;
            step += 1;
        }
        s.finish()
    }

    fn same(a: &Option<SequencesSketch>, b: &Option<SequencesSketch>) -> bool {
        match (a, b) {
            (None, None) => true,
            (Some(x), Some(y)) => {
                x.kmer_counts == y.kmer_counts
                    && x.mean_read_length.to_bits() == y.mean_read_length.to_bits()
            }
            _ => false,
        }
    }

    fn describe(o: &Option<SequencesSketch>) -> String {
        match o {
            None => "None".to_string(),
            Some(s) => format!("{} kmers / mrl {}", s.kmer_counts.len(), s.mean_read_length),
        }
    }

    #[test]
    fn fuzz_single_end_streaming_matches_one_shot() {
        let schedules: [&[usize]; 6] = [
            &[usize::MAX],
            &[1],
            &[7],
            &[64],
            &[997],
            &[1, 7, 3, 1000, 13, 2, 511],
        ];
        let mut checked = 0usize;
        for seed in 1..2500u64 {
            let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
            let n_records = 3 + rng.below(6);
            let mut bytes = gen_fastq(&mut rng, n_records);
            // One sample out of three is several runs concatenated, sometimes
            // with the intermediate trailing newline missing.
            if rng.below(3) == 0 {
                if rng.below(2) == 0 {
                    bytes.pop();
                }
                let n_more = 1 + rng.below(4);
                let more = gen_fastq(&mut rng, n_more);
                bytes.extend_from_slice(&more);
            }
            for _ in 0..rng.below(5) {
                mutate(&mut rng, &mut bytes);
            }

            let reference =
                sketch_sequences_from_bytes(&bytes, "s".to_string(), C, K, false, None);
            for sched in schedules {
                let streamed = stream_single(&bytes, sched);
                if bytes.first() != Some(&FASTQ_START) {
                    // Documented divergence: this path is FASTQ-only, so it
                    // refuses everything else instead of guessing (FASTA in
                    // particular, which the one-shot would read).
                    assert!(
                        streamed.is_none(),
                        "seed {} sched {:?}: non-FASTQ input must be refused, got {}",
                        seed,
                        sched,
                        describe(&streamed)
                    );
                    continue;
                }
                checked += 1;
                assert!(
                    same(&reference, &streamed),
                    "seed {} sched {:?}: one-shot {} vs streaming {}\nINPUT:\n{}",
                    seed,
                    sched,
                    describe(&reference),
                    describe(&streamed),
                    String::from_utf8_lossy(&bytes)
                );
            }
        }
        assert!(checked > 5000, "fuzz barely exercised anything: {}", checked);
    }

    #[test]
    fn fuzz_paired_end_streaming_matches_one_shot() {
        let schedules: [(usize, usize); 5] = [
            (usize::MAX, usize::MAX),
            (1, 1),
            (64, 997),
            (usize::MAX, 7),
            (7, usize::MAX),
        ];
        for seed in 1..1200u64 {
            let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
            let (n1_rec, n2_rec) = (2 + rng.below(6), 2 + rng.below(6));
            let mut r1 = gen_fastq(&mut rng, n1_rec);
            let mut r2 = gen_fastq(&mut rng, n2_rec);
            for side in 0..2 {
                if rng.below(2) == 0 {
                    let target = if side == 0 { &mut r1 } else { &mut r2 };
                    mutate(&mut rng, target);
                }
            }
            let reference = sketch_pair_sequences_from_bytes(
                &r1,
                &r2,
                "s".to_string(),
                C,
                K,
                false,
                None,
            );
            let fastq_only =
                r1.first() == Some(&FASTQ_START) && r2.first() == Some(&FASTQ_START);
            for (n1, n2) in schedules {
                let mut p = PairStreamSketcher::new("s".to_string(), C, K, false, None);
                let (mut i1, mut i2) = (0usize, 0usize);
                while i1 < r1.len() || i2 < r2.len() {
                    if i1 < r1.len() {
                        let n = n1.min(r1.len() - i1);
                        p.feed_r1(&r1[i1..i1 + n]);
                        i1 += n;
                    }
                    if i2 < r2.len() {
                        let n = n2.min(r2.len() - i2);
                        p.feed_r2(&r2[i2..i2 + n]);
                        i2 += n;
                    }
                }
                let streamed = p.finish();
                if !fastq_only {
                    assert!(
                        streamed.is_none(),
                        "seed {} sched {}/{}: non-FASTQ mate must be refused, got {}",
                        seed,
                        n1,
                        n2,
                        describe(&streamed)
                    );
                    continue;
                }
                assert!(
                    same(&reference, &streamed),
                    "seed {} sched {}/{}: one-shot {} vs streaming {}\nR1:\n{}\nR2:\n{}",
                    seed,
                    n1,
                    n2,
                    describe(&reference),
                    describe(&streamed),
                    String::from_utf8_lossy(&r1),
                    String::from_utf8_lossy(&r2)
                );
            }
        }
    }
}
