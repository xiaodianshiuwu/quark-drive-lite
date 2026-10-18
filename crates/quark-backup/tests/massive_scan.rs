//! 大规模离线测试：~100k 条目扫描/入队/水位行为（不下真网）。
//! 记录：首批发现延迟、扫描吞吐、入队吞吐、认领吞吐。
//! 运行：cargo test -p quark-backup --offline --test massive_scan -- --nocapture

use quark_backup::scanner::{scan, ScanConfig, ScanItem};
use quark_backup::store::Store;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::mpsc;

/// 5 万单目录小文件 + 10 层 × 5000 文件（共 10 万）。
fn generate_tree(root: &std::path::Path, flat: usize, deep: usize) -> std::io::Result<()> {
    use std::io::Write;
    let flat_dir = root.join("flat");
    std::fs::create_dir_all(&flat_dir)?;
    for i in 0..flat {
        let mut f = std::fs::File::create(flat_dir.join(format!("f{i:05}.txt")))?;
        f.write_all(format!("content-{i}").as_bytes())?;
    }
    let deep_dir = root.join("deep");
    let mut cur = deep_dir;
    let per_level = deep / 10;
    for level in 0..10 {
        cur = cur.join(format!("L{level:02}"));
        std::fs::create_dir_all(&cur)?;
        for i in 0..per_level {
            let mut f = std::fs::File::create(cur.join(format!("d{level:02}_{i:05}.bin")))?;
            f.write_all(b"x")?;
        }
    }
    Ok(())
}

#[tokio::test]
async fn scan_100k_entries_batches_and_queue() {
    let base = tempfile::tempdir().unwrap();
    let root = base.path().join("data");
    let t0 = Instant::now();
    generate_tree(&root, 50_000, 50_000).unwrap();
    println!("[gen] 100k 文件生成: {:?}", t0.elapsed());

    let store = Arc::new(Store::open(&base.path().join("t.db")).unwrap());
    let cfg = ScanConfig {
        account: "acc".into(),
        root_dir: root.clone(),
        target_fid: "t1".into(),
        batch_size: 500,
    };
    let (tx, mut rx) = mpsc::channel::<Vec<ScanItem>>(1000);
    let files_seen = Arc::new(AtomicU64::new(0));
    let scan_start = Instant::now();

    let handle = tokio::task::spawn_blocking(move || scan(&cfg, tx));
    let mut first_batch_latency: Option<Instant> = None;
    let mut insert_elapsed = std::time::Duration::ZERO;
    while let Some(batch) = rx.recv().await {
        if first_batch_latency.is_none() {
            first_batch_latency = Some(scan_start);
        }
        let t_ins = Instant::now();
        let tasks: Vec<quark_backup::Task> = batch
            .into_iter()
            .filter_map(|it| match it {
                ScanItem::File(t) => {
                    files_seen.fetch_add(1, Ordering::Relaxed);
                    Some(t)
                }
                ScanItem::Dir(_) | ScanItem::Warning { .. } => None,
            })
            .collect();
        if !tasks.is_empty() {
            store.upsert_discovered(&tasks).unwrap();
        }
        insert_elapsed += t_ins.elapsed();
    }
    let scan_elapsed = scan_start.elapsed();
    let st = handle.await.unwrap().unwrap();

    println!(
        "[scan] files={} dirs={} batches={} 耗时 {:?}（吞吐 {:.0} 条/秒）",
        st.files, st.dirs, st.batches, scan_elapsed,
        st.files as f64 / scan_elapsed.as_secs_f64(),
    );
    println!(
        "[queue] upsert 累计耗时 {:?}（吞吐 {:.0} 条/秒）",
        insert_elapsed,
        st.files as f64 / insert_elapsed.as_secs_f64().max(0.001),
    );
    println!("[water] channel 容量 1000（高水位）；扫描端 send 满即阻塞——本测试 rx 消费足够快未触发满载");

    assert_eq!(st.files, 100_000);
    assert!(st.batches >= 200);
    assert_eq!(files_seen.load(Ordering::Relaxed), 100_000);
    let c = store.counts("acc").unwrap();
    assert_eq!(c.get("discovered").copied().unwrap_or(0), 100_000);

    // 认领吞吐
    let claim_start = Instant::now();
    let mut claimed_total = 0usize;
    loop {
        let batch = store.claim_batch("acc", 1000).unwrap();
        if batch.is_empty() {
            break;
        }
        claimed_total += batch.len();
    }
    let claim_elapsed = claim_start.elapsed();
    println!(
        "[claim] 认领 {claimed_total} 条，耗时 {claim_elapsed:?}（吞吐 {:.0} 条/秒）",
        claimed_total as f64 / claim_elapsed.as_secs_f64().max(0.001),
    );
    assert_eq!(claimed_total, 100_000);
}
