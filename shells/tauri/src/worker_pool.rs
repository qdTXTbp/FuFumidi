//! T-118 P0：worker 调度池（本轮只新增模块与单测，不接生产单 worker）。
//!
//! 只做纯调度：
//! - [WorkerProc] 抽象“一个可长驻的推理进程”，真实 Python 实现下一轮再接；
//! - [WorkerPool] 用 Mutex<PoolInner> + Condvar 管上限、排队、取消与退出；
//! - [Lease] 是占槽凭据，Drop 一定归还槽位（panic 展开也走 Drop）。
//!
//! 纪律（对应设计报告）：
//! - 池锁内只碰 O(1) 元数据（计数、HashMap）；spawn / kill / read_line 一律在锁外；
//! - 等待者数量有硬上限（[PoolError::TooManyWaiters]）；
//! - 每个 job 一个独立的 Arc<AtomicBool> 取消位；
//! - cancel_all 只清空当次等待者与在途 job，池本身仍可用；shutdown 之后拒绝新工作。
//!
//! 测试全部用 [MockWorker]，不启动真实进程、不开窗口。

#![allow(dead_code)] // 生产路径下一轮才接入；本轮只落模块 + 单测

use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};

/// 并发上限下限（设计约束：1..=4）。
pub const MIN_CAP: usize = 1;
/// 并发上限上限。
pub const MAX_CAP: usize = 4;
/// 默认等待者上限。
pub const DEFAULT_MAX_WAITERS: usize = 64;

/// 一个可被池调度的推理进程。
///
/// 本轮不要求真实实现；下一轮接 Python 时用 Child + stdin/stdout 包装。
/// 所有方法都必须是“只碰自己、不碰池锁”的：池保证在锁外调用它们。
pub trait WorkerProc: Send {
    /// 进程 id（用于 status / 取消诊断）。
    fn pid(&self) -> u32;
    /// 向 worker 写一行请求。
    fn send(&mut self, line: &str) -> io::Result<()>;
    /// 读一行返回；Ok(None) 表示 EOF。
    fn read_line(&mut self) -> io::Result<Option<String>>;
    /// 非阻塞探活；Ok(Some(code)) 表示已经退出。
    fn try_wait(&mut self) -> io::Result<Option<i32>>;
    /// 终止进程。允许重复调用（第二次应为无害 no-op）。
    fn kill(&mut self) -> io::Result<()>;
}

/// 调度错误。所有等待/释放失败都给明确原因，不返回裸 String。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PoolError {
    /// 构造时 cap 不在 1..=4。
    InvalidCap(usize),
    /// 等待者上限非法（必须 >= 1）。
    InvalidMaxWaiters(usize),
    /// 池已 shutdown（或 shutdown 与等待并发）。
    Shutdown,
    /// 本次等待/在途 job 被 cancel_all 或 cancel 取消。
    Canceled,
    /// 等待者已达上限，明确拒绝而不是无限排队。
    TooManyWaiters { max: usize },
    /// spawn 工厂返回失败。
    Spawn(String),
    /// worker 已不在该 job 上（已取消/已退出），或尚未安装完成。
    WorkerGone,
    /// worker IO 失败。
    Io(String),
}

impl fmt::Display for PoolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PoolError::InvalidCap(cap) => write!(f, "worker pool cap must be in {MIN_CAP}..={MAX_CAP}, got {cap}"),
            PoolError::InvalidMaxWaiters(max) => write!(f, "worker pool max_waiters must be >= 1, got {max}"),
            PoolError::Shutdown => f.write_str("worker pool is shut down"),
            PoolError::Canceled => f.write_str("worker pool job was canceled"),
            PoolError::TooManyWaiters { max } => write!(f, "worker pool waiter limit reached (max {max})"),
            PoolError::Spawn(err) => write!(f, "worker spawn failed: {err}"),
            PoolError::WorkerGone => f.write_str("worker is no longer attached to this job"),
            PoolError::Io(err) => write!(f, "worker io error: {err}"),
        }
    }
}

impl std::error::Error for PoolError {}

/// job 标识；由池单调分配，取消/状态查询都用它。
pub type JobId = u64;

type WorkerSlot = Arc<Mutex<Option<Box<dyn WorkerProc>>>>;

#[derive(Clone)]
struct JobHandle {
    cancel: Arc<AtomicBool>,
    worker: WorkerSlot,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct PoolCounters {
    spawned: usize,
    completed: usize,
    canceled: usize,
    killed: usize,
}

struct PoolInner {
    cap: usize,
    max_waiters: usize,
    waiters: usize,
    /// 已占用的槽位（含正在 kill/回收的 worker）；容量判断只看它。
    /// 旧 worker 彻底释放前不归还，避免 cleanup 期间再 spawn 造成瞬时超限。
    in_flight: usize,
    jobs: HashMap<JobId, JobHandle>,
    next_id: JobId,
    /// cancel_all / shutdown 每次递增；等待者靠它区分“正常唤醒”与“被清空”。
    epoch: u64,
    shutdown: bool,
    peak_busy: usize,
    peak_waiters: usize,
    counters: PoolCounters,
}

/// 单个在途 job 的快照。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkerInfo {
    pub id: JobId,
    /// worker 已安装时为进程 id；spawn 尚未返回时为 None。
    pub pid: Option<u32>,
    /// 槽已预留但 spawn 尚未返回。
    pub ready: bool,
    pub canceled: bool,
}

/// status() 的只读快照。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoolStatus {
    pub cap: usize,
    pub busy: usize,
    pub waiting: usize,
    pub max_waiters: usize,
    pub peak_busy: usize,
    pub peak_waiters: usize,
    pub spawned: usize,
    pub completed: usize,
    pub canceled: usize,
    pub killed: usize,
    pub shutdown: bool,
    pub workers: Vec<WorkerInfo>,
}

/// 多 worker 调度池。
///
/// 并发模型：
/// - acquire() 先占一个元数据槽（O(1)），在锁外调用 spawn 工厂；
/// - 工作线程拿到 [Lease] 后直接对 worker 做 send/read_line（只锁该 job 自己的槽）；
/// - cancel(id) / cancel_all() / shutdown() 只把 job 从表里摘掉并拿回 worker，
///   真正的 kill 在池锁外执行；
/// - [Lease] 的 Drop 负责归还槽位并唤醒等待者。
pub struct WorkerPool {
    inner: Mutex<PoolInner>,
    cv: Condvar,
}

impl WorkerPool {
    /// 默认等待者上限（[DEFAULT_MAX_WAITERS]）。
    pub fn new(cap: usize) -> Result<Self, PoolError> {
        Self::with_limits(cap, DEFAULT_MAX_WAITERS)
    }

    /// cap 必须在 1..=4；max_waiters 必须 >= 1。
    pub fn with_limits(cap: usize, max_waiters: usize) -> Result<Self, PoolError> {
        if !(MIN_CAP..=MAX_CAP).contains(&cap) {
            return Err(PoolError::InvalidCap(cap));
        }
        if max_waiters == 0 {
            return Err(PoolError::InvalidMaxWaiters(max_waiters));
        }
        Ok(Self {
            inner: Mutex::new(PoolInner {
                cap,
                max_waiters,
                waiters: 0,
                in_flight: 0,
                jobs: HashMap::new(),
                next_id: 1,
                epoch: 0,
                shutdown: false,
                peak_busy: 0,
                peak_waiters: 0,
                counters: PoolCounters::default(),
            }),
            cv: Condvar::new(),
        })
    }

    fn lock(&self) -> MutexGuard<'_, PoolInner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// 申请一个槽位并在锁外 spawn worker。
    ///
    /// 工厂拿到 (JobId, cancel_flag)：真实实现可把 cancel_flag 传给子进程监控线程。
    /// 若等待期间 cancel_all 或 shutdown 发生，返回 [PoolError::Canceled] /
    /// [PoolError::Shutdown]；等待者超上限直接返回 [PoolError::TooManyWaiters]。
    pub fn acquire<F>(&self, spawn: F) -> Result<Lease<'_>, PoolError>
    where
        F: FnOnce(JobId, Arc<AtomicBool>) -> Result<Box<dyn WorkerProc>, String>,
    {
        let (id, cancel, slot) = {
            let mut inner = self.lock();
            loop {
                if inner.shutdown {
                    return Err(PoolError::Shutdown);
                }
                if inner.in_flight < inner.cap {
                    break;
                }
                if inner.waiters >= inner.max_waiters {
                    return Err(PoolError::TooManyWaiters { max: inner.max_waiters });
                }
                inner.waiters += 1;
                if inner.waiters > inner.peak_waiters {
                    inner.peak_waiters = inner.waiters;
                }
                let epoch = inner.epoch;
                inner = self.cv.wait(inner).unwrap_or_else(PoisonError::into_inner);
                inner.waiters -= 1;
                if inner.shutdown {
                    return Err(PoolError::Shutdown);
                }
                if inner.epoch != epoch {
                    return Err(PoolError::Canceled);
                }
            }

            let id = inner.next_id;
            inner.next_id = inner.next_id.wrapping_add(1);
            inner.in_flight += 1;
            let cancel = Arc::new(AtomicBool::new(false));
            let slot: WorkerSlot = Arc::new(Mutex::new(None));
            inner.jobs.insert(
                id,
                JobHandle {
                    cancel: Arc::clone(&cancel),
                    worker: Arc::clone(&slot),
                },
            );
            if inner.in_flight > inner.peak_busy {
                inner.peak_busy = inner.in_flight;
            }
            (id, cancel, slot)
        };

        // spawn 在池锁外；工厂即使 panic 也必须归还预留槽，不能让容量泄漏。
        let spawned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            spawn(id, Arc::clone(&cancel))
        }));
        let worker = match spawned {
            Ok(Ok(worker)) => worker,
            Ok(Err(err)) => {
                self.abort_reservation(id);
                return Err(PoolError::Spawn(err));
            }
            Err(payload) => {
                self.abort_reservation(id);
                std::panic::resume_unwind(payload);
            }
        };

        // 安装 worker 只锁该 job 自己的槽，不持池锁。
        {
            let mut guard = slot.lock().unwrap_or_else(PoisonError::into_inner);
            *guard = Some(worker);
        }

        // 回到池锁确认 job 是否已被 cancel/cancel_all/shutdown 摘走。
        let (keep, failure) = {
            let mut inner = self.lock();
            if inner.shutdown {
                (false, Some(PoolError::Shutdown))
            } else if inner.jobs.contains_key(&id) {
                inner.counters.spawned += 1;
                (true, None)
            } else {
                (false, Some(PoolError::Canceled))
            }
        };
        if keep {
            return Ok(Lease {
                pool: self,
                id,
                cancel,
                slot,
            });
        }

        // 迟到的 worker：在锁外 kill，避免“取消瞬间已 spawn 完成”泄漏进程。
        let late = slot.lock().unwrap_or_else(PoisonError::into_inner).take();
        if let Some(mut worker) = late {
            let _ = worker.kill();
            drop(worker);
            self.lock().counters.killed += 1;
            self.finish_capacity();
            self.cv.notify_all();
        }
        Err(failure.unwrap_or(PoolError::Canceled))
    }

    /// 只取消指定 id，返回是否命中。
    /// 等待中的 acquire 没有 id，靠 [Self::cancel_all] / [Self::shutdown] 清空。
    pub fn cancel(&self, id: JobId) -> bool {
        let removed = {
            let mut inner = self.lock();
            let removed = inner.jobs.remove(&id);
            if removed.is_some() {
                inner.counters.canceled += 1;
            }
            removed
        };
        let Some(handle) = removed else {
            return false;
        };
        handle.cancel.store(true, Ordering::SeqCst);
        if self.dispose_worker(&handle) {
            self.finish_capacity();
            self.cv.notify_all();
        }
        true
    }

    /// 清空当次全部等待者与在途 job；池本身仍可继续 acquire。返回被取消的在途 job 数。
    pub fn cancel_all(&self) -> usize {
        let removed: Vec<JobHandle> = {
            let mut inner = self.lock();
            inner.epoch = inner.epoch.wrapping_add(1);
            let drained: Vec<JobHandle> = inner.jobs.drain().map(|(_, handle)| handle).collect();
            inner.counters.canceled += drained.len();
            drained
        };
        for handle in &removed {
            handle.cancel.store(true, Ordering::SeqCst);
            if self.dispose_worker(handle) {
                self.finish_capacity();
            }
        }
        self.cv.notify_all();
        removed.len()
    }

    /// 关闭池：取消全部等待者与在途 job，之后 acquire 一律返回 [PoolError::Shutdown]。
    /// 可重复调用。
    pub fn shutdown(&self) {
        let removed: Vec<JobHandle> = {
            let mut inner = self.lock();
            let drained = if inner.shutdown {
                Vec::new()
            } else {
                inner.shutdown = true;
                let drained: Vec<JobHandle> =
                    inner.jobs.drain().map(|(_, handle)| handle).collect();
                inner.counters.canceled += drained.len();
                drained
            };
            inner.epoch = inner.epoch.wrapping_add(1);
            drained
        };
        for handle in &removed {
            handle.cancel.store(true, Ordering::SeqCst);
            if self.dispose_worker(handle) {
                self.finish_capacity();
            }
        }
        self.cv.notify_all();
    }

    /// 只读快照。池锁内只做元数据拷贝；pid 读取在逐个 job 自己的锁上完成。
    pub fn status(&self) -> PoolStatus {
        let (cap, max_waiters, busy, waiting, peak_busy, peak_waiters, counters, shutdown, handles) = {
            let inner = self.lock();
            let handles: Vec<(JobId, JobHandle)> = inner
                .jobs
                .iter()
                .map(|(&id, handle)| (id, handle.clone()))
                .collect();
            (
                inner.cap,
                inner.max_waiters,
                inner.in_flight,
                inner.waiters,
                inner.peak_busy,
                inner.peak_waiters,
                inner.counters.clone(),
                inner.shutdown,
                handles,
            )
        };
        let workers = handles
            .iter()
            .map(|(id, handle)| {
                let guard = handle.worker.lock().unwrap_or_else(PoisonError::into_inner);
                WorkerInfo {
                    id: *id,
                    pid: guard.as_ref().map(|worker| worker.pid()),
                    ready: guard.is_some(),
                    canceled: handle.cancel.load(Ordering::SeqCst),
                }
            })
            .collect();
        PoolStatus {
            cap,
            busy,
            waiting,
            max_waiters,
            peak_busy,
            peak_waiters,
            spawned: counters.spawned,
            completed: counters.completed,
            canceled: counters.canceled,
            killed: counters.killed,
            shutdown,
            workers,
        }
    }

    /// spawn 失败/panic 时归还预留槽。
    fn abort_reservation(&self, id: JobId) {
        let removed = {
            let mut inner = self.lock();
            let removed = inner.jobs.remove(&id);
            inner.in_flight = inner.in_flight.saturating_sub(1);
            removed
        };
        drop(removed);
        self.cv.notify_all();
    }

    /// 正常归还（Lease::drop）。先释放 worker，再唤醒等待者，容量才真正可用。
    fn release(&self, id: JobId) {
        let removed = {
            let mut inner = self.lock();
            let removed = inner.jobs.remove(&id);
            if removed.is_some() {
                inner.counters.completed += 1;
            }
            removed
        };
        if let Some(handle) = removed {
            let worker = {
                let mut guard = handle.worker.lock().unwrap_or_else(PoisonError::into_inner);
                guard.take()
            };
            drop(worker);
            self.finish_capacity();
            self.cv.notify_all();
        }
    }

    /// 在池锁外取回 worker 并 kill；返回是否真的拿到 worker。
    /// 拿到才由调用方归还容量；没拿到说明 spawner 还没安装完，容量由 spawner 归还。
    fn dispose_worker(&self, handle: &JobHandle) -> bool {
        let worker = handle
            .worker
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        match worker {
            Some(mut worker) => {
                let _ = worker.kill();
                drop(worker);
                self.lock().counters.killed += 1;
                true
            }
            None => false,
        }
    }

    /// worker 已彻底释放，归还一个容量（调用方负责 notify）。
    fn finish_capacity(&self) {
        let mut inner = self.lock();
        inner.in_flight = inner.in_flight.saturating_sub(1);
    }
}

/// 一次成功的槽位占用。Drop 自动归还；不要 mem::forget。
pub struct Lease<'a> {
    pool: &'a WorkerPool,
    id: JobId,
    cancel: Arc<AtomicBool>,
    slot: WorkerSlot,
}

impl Lease<'_> {
    pub fn id(&self) -> JobId {
        self.id
    }

    /// 该 job 专属的取消位（与池共享）。
    pub fn cancel_token(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.cancel)
    }

    pub fn is_canceled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// worker 已安装时返回进程 id。
    pub fn pid(&self) -> Option<u32> {
        self.slot
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_ref()
            .map(|worker| worker.pid())
    }

    pub fn send(&self, line: &str) -> Result<(), PoolError> {
        let mut guard = self.slot.lock().unwrap_or_else(PoisonError::into_inner);
        let worker = guard.as_mut().ok_or(PoolError::WorkerGone)?;
        worker.send(line).map_err(|err| PoolError::Io(err.to_string()))
    }

    pub fn read_line(&self) -> Result<Option<String>, PoolError> {
        let mut guard = self.slot.lock().unwrap_or_else(PoisonError::into_inner);
        let worker = guard.as_mut().ok_or(PoolError::WorkerGone)?;
        worker.read_line().map_err(|err| PoolError::Io(err.to_string()))
    }

    pub fn try_wait(&self) -> Result<Option<i32>, PoolError> {
        let mut guard = self.slot.lock().unwrap_or_else(PoisonError::into_inner);
        let worker = guard.as_mut().ok_or(PoolError::WorkerGone)?;
        worker.try_wait().map_err(|err| PoolError::Io(err.to_string()))
    }
}

impl Drop for Lease<'_> {
    fn drop(&mut self) {
        self.pool.release(self.id);
    }
}

/* ---------------- MockWorker：单测用，不启动任何真实进程 ---------------- */

/// 所有 mock worker 共享的计数器。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MockState {
    pub spawned: usize,
    pub active: usize,
    pub max_active: usize,
    pub completed: usize,
    pub canceled: usize,
    pub killed: usize,
    pub sent: Vec<String>,
}

pub type MockShared = Arc<Mutex<MockState>>;

/// 新建一份共享计数器。
pub fn mock_state() -> MockShared {
    Arc::new(Mutex::new(MockState::default()))
}

/// 假 worker：记录 spawn/active/maxActive/completed/canceled/killed，便于验证池行为。
#[derive(Debug)]
pub struct MockWorker {
    pid: u32,
    shared: MockShared,
    inbox: VecDeque<String>,
    exit_code: Option<i32>,
    killed: bool,
}

impl MockWorker {
    pub fn new(shared: MockShared, pid_base: u32) -> Self {
        let pid = {
            let mut state = shared.lock().unwrap_or_else(PoisonError::into_inner);
            let spawned = state.spawned;
            state.spawned += 1;
            state.active += 1;
            if state.active > state.max_active {
                state.max_active = state.active;
            }
            pid_base.wrapping_add(spawned as u32)
        };
        Self {
            pid,
            shared,
            inbox: VecDeque::new(),
            exit_code: None,
            killed: false,
        }
    }

    /// 预置一行 stdout，供 lease.read_line() 读取。
    pub fn push_line(&mut self, line: impl Into<String>) {
        self.inbox.push_back(line.into());
    }

    /// 预置退出码，供 lease.try_wait() 读取。
    pub fn script_exit(&mut self, code: i32) {
        self.exit_code = Some(code);
    }
}

impl WorkerProc for MockWorker {
    fn pid(&self) -> u32 {
        self.pid
    }

    fn send(&mut self, line: &str) -> io::Result<()> {
        if self.killed {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "mock worker killed"));
        }
        self.shared
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .sent
            .push(line.to_string());
        Ok(())
    }

    fn read_line(&mut self) -> io::Result<Option<String>> {
        if self.killed {
            return Ok(None);
        }
        Ok(self.inbox.pop_front())
    }

    fn try_wait(&mut self) -> io::Result<Option<i32>> {
        if self.killed {
            Ok(Some(-1))
        } else {
            Ok(self.exit_code)
        }
    }

    fn kill(&mut self) -> io::Result<()> {
        if self.killed {
            return Ok(());
        }
        self.killed = true;
        self.shared
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .killed += 1;
        Ok(())
    }
}

impl Drop for MockWorker {
    fn drop(&mut self) {
        let mut state = self.shared.lock().unwrap_or_else(PoisonError::into_inner);
        state.active = state.active.saturating_sub(1);
        if self.killed {
            state.canceled += 1;
        } else {
            state.completed += 1;
        }
    }
}

/* ---------------- 单测 ---------------- */

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::sync::{mpsc, Arc};
    use std::thread;
    use std::time::{Duration, Instant};

    fn shared() -> MockShared {
        mock_state()
    }

    fn mock_factory(
        shared: MockShared,
        pid_base: u32,
    ) -> impl Fn(JobId, Arc<AtomicBool>) -> Result<Box<dyn WorkerProc>, String> {
        move |_id, _cancel| {
            Ok(Box::new(MockWorker::new(Arc::clone(&shared), pid_base)) as Box<dyn WorkerProc>)
        }
    }

    fn wait_until(label: &str, mut cond: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !cond() {
            assert!(Instant::now() < deadline, "timed out waiting for {label}");
            thread::sleep(Duration::from_millis(2));
        }
    }

    #[test]
    fn constructor_rejects_invalid_limits() {
        for cap in [0usize, 5, 100] {
            assert!(
                matches!(WorkerPool::new(cap), Err(PoolError::InvalidCap(c)) if c == cap),
                "cap {cap} should be rejected"
            );
        }
        for cap in MIN_CAP..=MAX_CAP {
            assert!(WorkerPool::new(cap).is_ok(), "cap {cap} should be accepted");
        }
        assert!(matches!(
            WorkerPool::with_limits(1, 0),
            Err(PoolError::InvalidMaxWaiters(0))
        ));
        assert!(matches!(
            WorkerPool::with_limits(5, 8),
            Err(PoolError::InvalidCap(5))
        ));
        assert!(WorkerPool::with_limits(2, 1).is_ok());
    }

    #[test]
    fn cap_two_limits_concurrency_for_eight_jobs() {
        let stats = shared();
        let pool = Arc::new(WorkerPool::with_limits(2, 16).unwrap());
        let mut threads = Vec::new();
        for _ in 0..8 {
            let pool = Arc::clone(&pool);
            let stats = Arc::clone(&stats);
            threads.push(thread::spawn(move || {
                let lease = pool.acquire(mock_factory(stats, 100)).expect("acquire");
                assert!(lease.pid().is_some());
                thread::sleep(Duration::from_millis(15));
            }));
        }
        for thread in threads {
            thread.join().unwrap();
        }

        {
            let state = stats.lock().unwrap();
            assert!(state.max_active <= 2, "max_active={} exceeds cap=2", state.max_active);
            assert_eq!(state.spawned, 8);
            assert_eq!(state.completed, 8);
            assert_eq!(state.canceled, 0);
            assert_eq!(state.killed, 0);
            assert_eq!(state.active, 0);
        }

        let status = pool.status();
        assert_eq!(status.cap, 2);
        assert_eq!(status.busy, 0);
        assert!(status.peak_busy <= 2);
        assert_eq!(status.spawned, 8);
        assert_eq!(status.completed, 8);
        assert_eq!(status.canceled, 0);
    }

    #[test]
    fn cap_one_serializes_jobs() {
        let stats = shared();
        let pool = Arc::new(WorkerPool::with_limits(1, 16).unwrap());
        let mut threads = Vec::new();
        for _ in 0..6 {
            let pool = Arc::clone(&pool);
            let stats = Arc::clone(&stats);
            threads.push(thread::spawn(move || {
                let _lease = pool.acquire(mock_factory(stats, 200)).expect("acquire");
                thread::sleep(Duration::from_millis(8));
            }));
        }
        for thread in threads {
            thread.join().unwrap();
        }
        let state = stats.lock().unwrap();
        assert_eq!(state.max_active, 1, "cap=1 must never run two workers at once");
        assert_eq!(state.spawned, 6);
        assert_eq!(state.completed, 6);
        assert_eq!(state.active, 0);
    }

    #[test]
    fn cancel_by_id_only_affects_that_job() {
        let stats = shared();
        let pool = WorkerPool::with_limits(2, 4).unwrap();
        let lease_a = pool.acquire(mock_factory(Arc::clone(&stats), 10)).unwrap();
        let lease_b = pool.acquire(mock_factory(Arc::clone(&stats), 20)).unwrap();
        let id_a = lease_a.id();
        let id_b = lease_b.id();
        assert_ne!(id_a, id_b);

        assert!(pool.cancel(id_a));
        assert!(lease_a.is_canceled());
        assert!(!lease_b.is_canceled());
        assert!(matches!(lease_a.send("nope"), Err(PoolError::WorkerGone)));
        assert!(matches!(lease_a.read_line(), Err(PoolError::WorkerGone)));

        {
            let state = stats.lock().unwrap();
            assert_eq!(state.killed, 1);
            assert_eq!(state.canceled, 1);
            assert_eq!(state.active, 1);
        }

        let status = pool.status();
        assert_eq!(status.busy, 1);
        assert_eq!(status.canceled, 1);
        assert_eq!(status.workers.len(), 1);
        assert_eq!(status.workers[0].id, id_b);
        assert!(!status.workers[0].canceled);

        // 未知 id 不动任何东西。
        assert!(!pool.cancel(9_999));
        assert_eq!(pool.status().busy, 1);

        // 已被取消的 lease 再 drop 不应重复计数或 panic。
        drop(lease_a);
        assert_eq!(pool.status().busy, 1);

        // 另一个 job 完全不受影响。
        lease_b.send("still-alive").unwrap();
        assert_eq!(stats.lock().unwrap().sent.last().unwrap(), "still-alive");
        drop(lease_b);

        let status = pool.status();
        assert_eq!(status.busy, 0);
        assert_eq!(status.completed, 1);
        assert_eq!(status.canceled, 1);
        let state = stats.lock().unwrap();
        assert_eq!(state.spawned, 2);
        assert_eq!(state.completed, 1);
        assert_eq!(state.canceled, 1);
        assert_eq!(state.killed, 1);
        assert_eq!(state.active, 0);
    }

    #[test]
    fn cancel_all_clears_waiters_and_inflight() {
        let stats = shared();
        let pool = Arc::new(WorkerPool::with_limits(1, 8).unwrap());
        let inflight = pool.acquire(mock_factory(Arc::clone(&stats), 300)).unwrap();
        let (tx, rx) = mpsc::channel();
        let mut waiters = Vec::new();
        for _ in 0..3 {
            let pool = Arc::clone(&pool);
            let stats = Arc::clone(&stats);
            let tx = tx.clone();
            waiters.push(thread::spawn(move || {
                let outcome = match pool.acquire(mock_factory(stats, 400)) {
                    Ok(_lease) => "acquired",
                    Err(PoolError::Canceled) => "canceled",
                    Err(_) => "other-error",
                };
                tx.send(outcome).unwrap();
            }));
        }
        drop(tx);
        wait_until("all waiters registered", || pool.status().waiting == 3);
        assert_eq!(pool.status().peak_waiters, 3);

        assert_eq!(pool.cancel_all(), 1);
        assert!(inflight.is_canceled());
        for _ in 0..3 {
            let outcome = rx.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(outcome, "canceled");
        }
        for waiter in waiters {
            waiter.join().unwrap();
        }
        drop(inflight);

        let status = pool.status();
        assert_eq!(status.busy, 0);
        assert_eq!(status.waiting, 0);
        assert_eq!(status.canceled, 1);
        assert_eq!(status.killed, 1);
        {
            let state = stats.lock().unwrap();
            assert_eq!(state.spawned, 1);
            assert_eq!(state.killed, 1);
            assert_eq!(state.canceled, 1);
            assert_eq!(state.active, 0);
        }

        // cancel_all 之后池仍可用。
        let lease = pool.acquire(mock_factory(Arc::clone(&stats), 500)).unwrap();
        assert_eq!(pool.status().busy, 1);
        drop(lease);
        let status = pool.status();
        assert_eq!(status.busy, 0);
        assert_eq!(status.spawned, 2);
        assert_eq!(status.completed, 1);
    }

    #[test]
    fn shutdown_wakes_waiters_and_rejects_new_work() {
        let stats = shared();
        let pool = Arc::new(WorkerPool::with_limits(1, 4).unwrap());
        let inflight = pool.acquire(mock_factory(Arc::clone(&stats), 600)).unwrap();
        let (tx, rx) = mpsc::channel();
        let waiter_pool = Arc::clone(&pool);
        let waiter_stats = Arc::clone(&stats);
        let waiter = thread::spawn(move || {
            let outcome = match waiter_pool.acquire(mock_factory(waiter_stats, 700)) {
                Ok(_lease) => "acquired".to_string(),
                Err(err) => format!("{err:?}"),
            };
            tx.send(outcome).unwrap();
        });
        wait_until("waiter registered", || pool.status().waiting == 1);

        pool.shutdown();
        assert!(inflight.is_canceled());
        let outcome = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(outcome, "Shutdown");
        waiter.join().unwrap();

        let status = pool.status();
        assert!(status.shutdown);
        assert_eq!(status.busy, 0);
        assert_eq!(status.waiting, 0);
        assert_eq!(status.canceled, 1);
        assert_eq!(status.killed, 1);
        assert!(matches!(
            pool.acquire(mock_factory(Arc::clone(&stats), 800)),
            Err(PoolError::Shutdown)
        ));
        {
            let state = stats.lock().unwrap();
            assert_eq!(state.killed, 1);
            assert_eq!(state.canceled, 1);
            assert_eq!(state.active, 0);
        }
        // 幂等。
        pool.shutdown();
        drop(inflight);
        assert_eq!(pool.status().busy, 0);
    }

    #[test]
    fn waiter_limit_overflow_returns_explicit_error() {
        let stats = shared();
        let pool = Arc::new(WorkerPool::with_limits(1, 1).unwrap());
        let held = pool.acquire(mock_factory(Arc::clone(&stats), 900)).unwrap();
        let (tx, rx) = mpsc::channel();
        let waiter_pool = Arc::clone(&pool);
        let waiter_stats = Arc::clone(&stats);
        let waiter = thread::spawn(move || {
            let outcome = match waiter_pool.acquire(mock_factory(waiter_stats, 1_000)) {
                Ok(lease) => Ok(lease.pid()),
                Err(err) => Err(err),
            };
            tx.send(outcome).unwrap();
        });
        wait_until("single waiter registered", || pool.status().waiting == 1);

        match pool.acquire(mock_factory(Arc::clone(&stats), 1_100)) {
            Err(err) => assert_eq!(err, PoolError::TooManyWaiters { max: 1 }),
            Ok(lease) => {
                drop(lease);
                panic!("waiter limit should have rejected the third acquire");
            }
        }
        assert_eq!(pool.status().busy, 1);

        drop(held);
        let acquired = rx
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .expect("waiter should acquire after release");
        assert!(acquired.is_some());
        waiter.join().unwrap();
        assert_eq!(pool.status().busy, 0);
        assert_eq!(pool.status().peak_waiters, 1);
    }

    #[test]
    fn lease_drop_and_panic_do_not_leak_slots() {
        let stats = shared();
        let pool = WorkerPool::with_limits(1, 4).unwrap();

        for _ in 0..3 {
            let lease = pool.acquire(mock_factory(Arc::clone(&stats), 1_200)).unwrap();
            assert_eq!(pool.status().busy, 1);
            drop(lease);
            assert_eq!(pool.status().busy, 0);
        }

        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _lease = pool.acquire(mock_factory(Arc::clone(&stats), 1_300)).unwrap();
            panic!("boom while holding a lease");
        }));
        assert!(panicked.is_err());
        assert_eq!(pool.status().busy, 0, "panic must not leak the reserved slot");

        // 释放后槽位可复用。
        let lease = pool.acquire(mock_factory(Arc::clone(&stats), 1_400)).unwrap();
        assert_eq!(pool.status().workers.len(), 1);
        drop(lease);
        assert_eq!(pool.status().busy, 0);

        let state = stats.lock().unwrap();
        assert_eq!(state.spawned, 5);
        assert_eq!(state.completed, 5);
        assert_eq!(state.killed, 0);
        assert_eq!(state.active, 0);
    }

    #[test]
    fn spawn_failure_releases_reserved_slot() {
        let stats = shared();
        let pool = WorkerPool::with_limits(1, 4).unwrap();
        match pool.acquire(|_id, _cancel| Err("factory failed".to_string())) {
            Err(PoolError::Spawn(err)) => assert_eq!(err, "factory failed"),
            other => panic!("expected spawn error, got {other:?}", other = other.map(|_| "lease")),
        }
        assert_eq!(pool.status().busy, 0);
        assert_eq!(pool.status().waiting, 0);

        let lease = pool.acquire(mock_factory(Arc::clone(&stats), 1_500)).unwrap();
        assert_eq!(pool.status().busy, 1);
        drop(lease);
        let status = pool.status();
        assert_eq!(status.busy, 0);
        assert_eq!(status.spawned, 1);
        assert_eq!(status.completed, 1);
    }

    #[test]
    fn spawn_panic_releases_reserved_slot() {
        let stats = shared();
        let pool = WorkerPool::with_limits(1, 2).unwrap();
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _ = pool.acquire(|_id, _cancel| -> Result<Box<dyn WorkerProc>, String> {
                panic!("factory boom");
            });
        }));
        assert!(panicked.is_err());
        let status = pool.status();
        assert_eq!(status.busy, 0);
        assert_eq!(status.waiting, 0);

        let lease = pool.acquire(mock_factory(Arc::clone(&stats), 1_600)).unwrap();
        assert_eq!(pool.status().busy, 1);
        drop(lease);
        assert_eq!(pool.status().busy, 0);
    }

    #[test]
    fn cancel_during_spawn_reaps_late_worker() {
        let stats = shared();
        let pool = Arc::new(WorkerPool::with_limits(1, 2).unwrap());
        let (started_tx, started_rx) = mpsc::channel::<()>();
        let (go_tx, go_rx) = mpsc::channel::<()>();
        let spawn_stats = Arc::clone(&stats);
        let spawn_pool = Arc::clone(&pool);
        let handle: thread::JoinHandle<Result<(), PoolError>> = thread::spawn(move || {
            spawn_pool
                .acquire(move |_id, _cancel| {
                    started_tx.send(()).unwrap();
                    go_rx.recv().unwrap();
                    Ok(Box::new(MockWorker::new(spawn_stats, 1_700)) as Box<dyn WorkerProc>)
                })
                .map(|_lease| ())
        });

        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let status = pool.status();
        assert_eq!(status.busy, 1);
        assert_eq!(status.workers.len(), 1);
        assert!(!status.workers[0].ready, "worker is still spawning");
        let id = status.workers[0].id;

        assert!(pool.cancel(id));
        go_tx.send(()).unwrap();
        match handle.join().unwrap() {
            Err(PoolError::Canceled) => {}
            other => panic!("expected Canceled, got {other:?}"),
        }

        let status = pool.status();
        assert_eq!(status.busy, 0);
        assert_eq!(status.canceled, 1);
        assert_eq!(status.spawned, 0, "late worker is never counted as spawned");
        assert_eq!(status.killed, 1);
        {
            let state = stats.lock().unwrap();
            assert_eq!(state.spawned, 1);
            assert_eq!(state.killed, 1);
            assert_eq!(state.canceled, 1);
            assert_eq!(state.active, 0);
        }

        // 池仍可用。
        let lease = pool.acquire(mock_factory(Arc::clone(&stats), 1_800)).unwrap();
        assert_eq!(pool.status().busy, 1);
        drop(lease);
        assert_eq!(pool.status().busy, 0);
        assert_eq!(pool.status().spawned, 1);
    }

    #[test]
    fn status_reports_cap_busy_and_workers() {
        let stats = shared();
        let pool = WorkerPool::new(3).unwrap();
        let empty = pool.status();
        assert_eq!(empty.cap, 3);
        assert_eq!(empty.busy, 0);
        assert_eq!(empty.waiting, 0);
        assert!(empty.workers.is_empty());
        assert!(!empty.shutdown);

        let lease_a = pool.acquire(mock_factory(Arc::clone(&stats), 2_000)).unwrap();
        let lease_b = pool.acquire(mock_factory(Arc::clone(&stats), 2_100)).unwrap();
        let status = pool.status();
        assert_eq!(status.cap, 3);
        assert_eq!(status.busy, 2);
        assert_eq!(status.waiting, 0);
        assert_eq!(status.workers.len(), 2);
        assert!(status.workers.iter().all(|worker| worker.ready && !worker.canceled));
        let mut pids: Vec<u32> = status.workers.iter().filter_map(|worker| worker.pid).collect();
        pids.sort_unstable();
        assert_eq!(pids.len(), 2);
        assert_ne!(pids[0], pids[1]);

        drop(lease_a);
        assert_eq!(pool.status().busy, 1);
        drop(lease_b);
        assert_eq!(pool.status().busy, 0);
        assert!(pool.status().workers.is_empty());
    }

    #[test]
    fn lease_forwards_worker_io() {
        let stats = shared();
        let pool = WorkerPool::with_limits(1, 2).unwrap();
        let factory_stats = Arc::clone(&stats);
        let lease = pool
            .acquire(move |_id, _cancel| {
                let mut worker = MockWorker::new(factory_stats, 2_200);
                worker.push_line("###RESULT {\"ok\":true}");
                worker.script_exit(7);
                Ok(Box::new(worker) as Box<dyn WorkerProc>)
            })
            .unwrap();
        assert_eq!(lease.pid(), Some(2_200));
        assert_eq!(lease.read_line().unwrap().as_deref(), Some("###RESULT {\"ok\":true}"));
        assert_eq!(lease.read_line().unwrap(), None);
        assert_eq!(lease.try_wait().unwrap(), Some(7));
        lease.send("{\"cmd\":\"exit\"}").unwrap();
        {
            let state = stats.lock().unwrap();
            assert_eq!(state.sent, vec!["{\"cmd\":\"exit\"}".to_string()]);
        }
        drop(lease);
        let status = pool.status();
        assert_eq!(status.busy, 0);
        assert_eq!(status.completed, 1);
    }

    #[test]
    fn mock_worker_records_lifecycle() {
        let stats = shared();
        let mut worker = MockWorker::new(Arc::clone(&stats), 42);
        assert_eq!(worker.pid(), 42);
        assert_eq!(worker.try_wait().unwrap(), None);
        worker.push_line("line-1");
        assert_eq!(worker.read_line().unwrap().as_deref(), Some("line-1"));
        worker.kill().unwrap();
        worker.kill().unwrap(); // 幂等
        assert_eq!(worker.try_wait().unwrap(), Some(-1));
        assert!(worker.send("after-kill").is_err());
        assert_eq!(worker.read_line().unwrap(), None);
        drop(worker);

        let state = stats.lock().unwrap();
        assert_eq!(state.spawned, 1);
        assert_eq!(state.max_active, 1);
        assert_eq!(state.active, 0);
        assert_eq!(state.killed, 1);
        assert_eq!(state.canceled, 1);
        assert_eq!(state.completed, 0);
    }
}
