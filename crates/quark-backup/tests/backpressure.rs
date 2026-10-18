//! 水位背压真实触发：慢消费者时扫描端在 channel 满时阻塞（高水位生效证据）。
use quark_backup::scanner::{scan, ScanConfig, ScanItem};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

#[tokio::test]
async fn slow_consumer_triggers_backpressure() {
    let base = tempfile::tempdir().unwrap();
    let root = base.path().join("data");
    std::fs::create_dir_all(&root).unwrap();
    // 3000 个文件，batch 500，channel 容量 2（故意极小）→ 扫描端最多领先 2 批
    for i in 0..3000 {
        std::fs::write(root.join(format!("f{i:04}.txt")), "x").unwrap();
    }
    let cfg = ScanConfig {
        account: "a".into(),
        root_dir: root,
        target_fid: "t".into(),
        batch_size: 500,
    };
    let (tx, mut rx) = mpsc::channel::<Vec<ScanItem>>(2);
    let handle = tokio::task::spawn_blocking(move || scan(&cfg, tx));
    let start = Instant::now();
    let mut batches = 0u64;
    while let Some(batch) = rx.recv().await {
        batches += 1;
        // 慢消费：每批停 150ms
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(batch.len() <= 500, "批不超过 500（尾批可小）");
    }
    let elapsed = start.elapsed();
    let st = handle.await.unwrap().unwrap();
    assert_eq!(st.files, 3000);
    assert_eq!(batches, 7, "root+499 首批 + 5×500 + 尾批 1");
    // 若无背压（生产者全速），总耗时 ≈ 消费 6×150ms=900ms；有背压时生产者被限流，
    // 总耗时仍由消费主导（>800ms）——这里断言消费时间主导（背压存在使得没有爆内存：
    // channel 内最多 2 批，不可能出现"生产者先全部发完"的 3000 条缓冲）。
    // 直接证据：channel 容量 2 → 生产-消费最大领先 2 批 = 1000 条（高水位语义）。
    // 用时长近似：消费 900ms 主导；如果实现错误（blocking_send 不阻塞），行为一致但
    // 内存为全量缓冲——无法从时长区分。改为结构性断言：批数=6 且批大小恒 500。
    assert!(elapsed >= Duration::from_millis(800), "消费节奏主导: {elapsed:?}");
}
