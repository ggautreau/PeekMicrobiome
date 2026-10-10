#!/usr/bin/env bash
# What each profiler costs the machine, step by step.
#
#   scripts/depth-bench/resources.sh <sample> <R1.gz> <R2.gz> [threads]
#
# §3.2 of the note prices the browser against native sylph and says nothing about
# what the OTHER references cost, which is half of a comparison: a profile from
# 113,104 GTDB representatives is only "the one the page cannot offer" if the
# reason is quantified, and the reason is a 14 GB database read into 15 GB of
# RAM.
#
# Every step is measured with /usr/bin/time -v, one at a time, nothing else
# running: peak resident set, user and system CPU, wall clock. Parallel
# measurement would be faster and would measure contention instead of cost.
#
# WHAT %M MEANS HERE. GNU time reports the peak RSS of the process it launched
# AND its waited-for children, which is what we want for meteor (it forks
# bowtie2) — but it is a peak, not an integral, and two children peaking at
# different moments are reported as the larger, not the sum. For a pipeline
# (`seqtk | gzip`) the shell is the child, so the pipeline is wrapped in `bash
# -c` and the figure covers both halves.
set -euo pipefail
# The shell's locale decides whether printf accepts "18.29" or demands "18,29",
# and GNU time always writes a dot. Under fr_FR the first measurement aborted the
# whole run.
export LC_ALL=C

SAMPLE=$1; R1=$2; R2=$3; THREADS=${4:-16}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
BENCH=$ROOT/data/bench
SEQTK=/home/ggautreau/miniconda3/envs/seqtk_env/bin/seqtk
SYLPH=/home/ggautreau/miniconda3/envs/sylph/bin/sylph
METEOR=/home/ggautreau/miniconda3/envs/meteor/bin/meteor
REF_METEOR=$BENCH/refs/hs_10_4_gut_taxo
WORK=$BENCH/res/$SAMPLE
OUT=$BENCH/res/measures.tsv
mkdir -p "$WORK" "$(dirname "$OUT")"

[ -s "$OUT" ] || printf 'sample\tdepth\tstep\twall_s\tuser_s\tsys_s\tpeak_rss_kb\tbytes_out\n' > "$OUT"

# One measured step: run it under GNU time, parse the four numbers, append a row.
measure() {
  local depth=$1 step=$2 out_path=$3; shift 3
  local tf; tf=$(mktemp)
  /usr/bin/time -v -o "$tf" "$@" > /dev/null 2>&1 || {
    echo "[$step] ÉCHEC"; cat "$tf" | tail -3; rm -f "$tf"; return 1; }
  local wall user sys rss bytes
  # "Elapsed (wall clock) time (h:mm:ss or m:ss): 1:07.16"
  wall=$(awk -F': ' '/Elapsed \(wall clock\)/{print $NF}' "$tf" |
    awk -F: '{ if (NF==3) print $1*3600+$2*60+$3; else print $1*60+$2 }')
  user=$(awk -F': ' '/User time/{print $NF}' "$tf")
  sys=$(awk -F': ' '/System time/{print $NF}' "$tf")
  rss=$(awk -F': ' '/Maximum resident set size/{print $NF}' "$tf")
  bytes=0
  [ -n "$out_path" ] && [ -e "$out_path" ] && bytes=$(du -sb "$out_path" | cut -f1)
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$SAMPLE" "$depth" "$step" "$wall" "$user" "$sys" "$rss" "$bytes" >> "$OUT"
  printf '  %-22s %8.1f s mur, %8.1f s CPU, %8.0f Mo crête\n' \
    "$step" "$wall" "$(echo "$user + $sys" | bc)" "$(echo "scale=0; $rss/1024" | bc)"
  rm -f "$tf"
}

for D in 100000 1000000 3000000; do
  TAG="${SAMPLE}_d${D}"
  echo "== $TAG =="

  measure "$D" subsample "$WORK/${TAG}_1.fastq.gz" bash -c \
    "$SEQTK sample -s42 '$R1' $D | gzip -1 > '$WORK/${TAG}_1.fastq.gz'"
  measure "$D" subsample_mate2 "$WORK/${TAG}_2.fastq.gz" bash -c \
    "$SEQTK sample -s42 '$R2' $D | gzip -1 > '$WORK/${TAG}_2.fastq.gz'"

  rm -rf "$WORK/sk"; mkdir -p "$WORK/sk"
  measure "$D" sylph_sketch "$WORK/sk" \
    "$SYLPH" sketch -1 "$WORK/${TAG}_1.fastq.gz" -2 "$WORK/${TAG}_2.fastq.gz" \
    -c 200 -k 31 -t "$THREADS" -d "$WORK/sk" -S "$TAG"

  measure "$D" sylph_profile_uhgg "" \
    "$SYLPH" profile "$BENCH/refs/human-gut.syldb" "$WORK/sk/$TAG.paired.sylsp" -t "$THREADS"
  measure "$D" sylph_profile_gtdb "" \
    "$SYLPH" profile /home/ggautreau/FermenTwin/FT1/gtdb-r220-c200-dbv1.syldb \
    "$WORK/sk/$TAG.paired.sylsp" -t "$THREADS"

  measure "$D" func_page "$WORK/$TAG.func.json" \
    node "$ROOT/scripts/depth-bench/func_profile.mjs" \
    "$WORK/${TAG}_1.fastq.gz" "$WORK/${TAG}_2.fastq.gz" "$WORK/$TAG.func.json"

  rm -rf "$WORK/mt"; mkdir -p "$WORK/mt/in"
  ln -sf "$WORK/${TAG}_1.fastq.gz" "$WORK/mt/in/${TAG}_1.fastq.gz"
  ln -sf "$WORK/${TAG}_2.fastq.gz" "$WORK/mt/in/${TAG}_2.fastq.gz"
  "$METEOR" fastq -i "$WORK/mt/in" -p -o "$WORK/mt/fq" > /dev/null 2>&1
  measure "$D" meteor_mapping "$WORK/mt/map" \
    "$METEOR" mapping -i "$WORK/mt/fq/$TAG" -r "$REF_METEOR" -o "$WORK/mt/map" -t "$THREADS"
  measure "$D" meteor_profile "$WORK/mt/prof" \
    "$METEOR" profile -i "$WORK/mt/map/$TAG" -r "$REF_METEOR" -o "$WORK/mt/prof"

  rm -rf "$WORK/mt" "$WORK/sk" "$WORK/${TAG}_1.fastq.gz" "$WORK/${TAG}_2.fastq.gz"
done
echo "-> $OUT"
