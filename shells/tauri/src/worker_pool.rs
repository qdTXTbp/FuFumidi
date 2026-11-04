//! T-118 worker 调度池：P0 落调度模块，P1 接生产单 worker，P2 动态并发（1..=4）。
//!
//! - [WorkerProc] 抽象“一个可长驻的推理进程”；[ChildWorker] 是真实实现
//!   （std::process::Child 的 stdin/stdout，Windows 上 CREATE_NO_WINDOW，stderr 丢弃防阻塞）；
//! - [WorkerPool] 用 Mutex<PoolInner> + Condvar 管上限、排队、取消与退出；
//! - [Lease] 是占槽凭据，Drop 一定归还槽位（panic 展开也走 Drop）；
//! - 生产路径默认 cap=1 + reuse：请求之间保留一个暖 worker，取消/崩溃后才重新 spawn；
//! - P2：[WorkerPool::set_cap] 按请求动态调容（clamp 1..=4）。缩容只回收**空闲暖 worker**，
//!   在途 job 不打断；扩容立即唤醒等待者。生产每请求按 `__slots` / GPU / MAX_WORKERS 调它。
//!
//! 纪律（对应设计报告）：
//! - 池锁内只碰 O(1) 元数据（计数、HashMap）；spawn / kill / read_line 一律在锁外；
//! - 等待者数量有硬上限（[PoolError::TooManyWaiters]）；
//! - 每个 job 一个独立的 Arc<AtomicBool> 取消位；
//! - cancel_all 只清空当次等待者与在途 job，池本身仍可用；shutdown 之后拒绝新工作。
//!
//! P0 的单测仍全部用 [MockWorker]，不启动真实进程、不开窗口；P1 另加 4 个真实
//! Python 子进程测试（echo / 阻塞读取消 / EOF 重启 / 暖 worker 复用），
//! 环境里没有 Python 时直接跳过。

#![allow(dead_code)] // cancel_all / 部分 status 字段当前只给下一轮并发用

use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::io::{self, BufRead, BufReader, Write};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};

/// 并发上限下限（设计约束：1..=4）。
pub const MIN_CAP: usize = 1;
/// 并发上限上限。
pub const MAX_CAP: usize = 4;
/// 默认等待者上限。
pub const DEFAULT_MAX_WAITERS: usize = 64;
/// Windows 进程创建标志：不弹控制台窗口（等价 Electron spawn 的 windowsHide）。
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

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
    /// 取消时允许池在 worker 锁被“阻塞中的 read_line”占用时按 pid 直接终止。
    ///
    /// 默认 None：MockWorker 与未知实现不暴露 pid，池因此**绝不会**对测试里的假 pid
    /// 执行 taskkill / kill。真实 [ChildWorker] 返回自己的 pid。
    fn emergency_pid(&self) -> Option<u32> {
        None
    }
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
    /// lease 判定 worker 已不可复用（EOF / 读失败）：release 时直接丢弃，不进暖池。
    broken: Arc<AtomicBool>,
    /// worker 安装后的真实 pid（0 = spawn 尚未完成）。status / 取消诊断只读它，避免抢 worker 锁。
    pid: Arc<AtomicU32>,
    /// 锁外紧急终止用的 pid（仅真实子进程非 0；mock 永远为 0，测试不会误杀真进程）。
    kill_pid: Arc<AtomicU32>,
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
    /// 生产 P1 开启：job 正常结束后保留健康 worker，下一次 acquire 直接复用。
    /// 默认 false，P0 单测的“每个 job 一个 MockWorker”语义完全不变。
    reuse: bool,
    /// 空闲暖 worker（不超过 cap）。kill / drop 一律在池锁外做。
    warm: Vec<Box<dyn WorkerProc>>,
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
#[derive(Debug, Clone, Default, PartialEq, Eq)]
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
    /// 暖池里的空闲 worker 数（reuse=true 时通常为 1）。
    pub warm: usize,
    /// 至少有一个暖 worker 仍存活（status 时 try_wait 探测）。
    pub warm_alive: bool,
    /// 第一个存活暖 worker 的 pid（engine_worker_status 用）。
    pub warm_pid: Option<u32>,
    /// 所有存活暖 worker 的 pid（P2 status 的 workers 数组用；顺序 = 暖池顺序）。
    pub warm_pids: Vec<u32>,
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
    /// 默认不复用 worker（P0 语义），生产路径用 [Self::with_reuse]。
    pub fn with_limits(cap: usize, max_waiters: usize) -> Result<Self, PoolError> {
        Self::with_limits_reuse(cap, max_waiters, false)
    }

    /// 生产路径入口：cap=1 + 默认等待者上限 + 暖 worker 复用。
    /// 语义等价于旧实现里那个常驻的 Option<Worker>：请求之间不重启 Python。
    pub fn with_reuse(cap: usize) -> Result<Self, PoolError> {
        Self::with_limits_reuse(cap, DEFAULT_MAX_WAITERS, true)
    }

    /// 与 [Self::with_limits] 相同，但可显式开启暖 worker 复用。
    pub fn with_limits_reuse(cap: usize, max_waiters: usize, reuse: bool) -> Result<Self, PoolError> {
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
                reuse,
                warm: Vec::new(),
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
        let (id, cancel, broken, pid, kill_pid, slot, warm) = {
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
            let broken = Arc::new(AtomicBool::new(false));
            let pid = Arc::new(AtomicU32::new(0));
            let kill_pid = Arc::new(AtomicU32::new(0));
            let slot: WorkerSlot = Arc::new(Mutex::new(None));
            inner.jobs.insert(
                id,
                JobHandle {
                    cancel: Arc::clone(&cancel),
                    broken: Arc::clone(&broken),
                    pid: Arc::clone(&pid),
                    kill_pid: Arc::clone(&kill_pid),
                    worker: Arc::clone(&slot),
                },
            );
            // 有暖 worker 就直接复用（P1 常驻单 worker 的关键）；没有才走 spawn 工厂。
            // 取出的暖 worker 不再计入 in_flight，由本 job 这次占用接管。
            let warm = if inner.reuse { inner.warm.pop() } else { None };
            if inner.in_flight > inner.peak_busy {
                inner.peak_busy = inner.in_flight;
            }
            (id, cancel, broken, pid, kill_pid, slot, warm)
        };

        let reused_warm = warm.is_some();
        let from_factory;
        let worker = if let Some(worker) = warm {
            from_factory = false;
            worker
        } else {
            from_factory = true;
            // spawn 在池锁外；工厂即使 panic 也必须归还预留槽，不能让容量泄漏。
            let spawned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                spawn(id, Arc::clone(&cancel))
            }));
            match spawned {
                Ok(Ok(worker)) => worker,
                Ok(Err(err)) => {
                    self.abort_reservation(id);
                    return Err(PoolError::Spawn(err));
                }
                Err(payload) => {
                    self.abort_reservation(id);
                    std::panic::resume_unwind(payload);
                }
            }
        };

        // pid 必须在安装前取；安装后立刻公布到 job 元数据。
        // cancel 的锁外终止路径只读这两个 atomic，不必抢 worker 锁。
        let worker_pid = worker.pid();
        let emergency_pid = worker.emergency_pid().unwrap_or(0);
        {
            let mut guard = slot.lock().unwrap_or_else(PoisonError::into_inner);
            *guard = Some(worker);
        }
        pid.store(worker_pid, Ordering::SeqCst);
        kill_pid.store(emergency_pid, Ordering::SeqCst);

        // 回到池锁确认 job 是否已被 cancel/cancel_all/shutdown 摘走。
        let (keep, failure) = {
            let mut inner = self.lock();
            if inner.shutdown {
                (false, Some(PoolError::Shutdown))
            } else if inner.jobs.contains_key(&id) {
                if from_factory {
                    inner.counters.spawned += 1;
                }
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
                broken,
                reused: reused_warm,
                slot,
            });
        }

        // 迟到的 worker：在锁外 kill，避免“取消瞬间已 spawn 完成”泄漏进程。
        // 若 cancel 已经抢到并 kill 了它（slot 为空），容量由 cancel 归还。
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
        self.signal_stop(&handle);
        if self.dispose_worker(&handle) {
            self.finish_capacity();
            self.cv.notify_all();
        }
        true
    }

    /// 取消/关闭时先置位、再在锁外按 pid 发终止信号。
    ///
    /// 关键：worker 线程可能正卡在 read_line（持有该 job 的 worker 槽锁）。
    /// 若先 dispose_worker 抢锁，就会被“等进程输出”拖住；这里绝不碰 worker 锁。
    /// MockWorker 的 kill_pid 恒为 0，所以单测不会对假 pid 执行 taskkill。
    fn signal_stop(&self, handle: &JobHandle) {
        handle.cancel.store(true, Ordering::SeqCst);
        let pid = handle.kill_pid.load(Ordering::SeqCst);
        if pid == 0 {
            return;
        }
        #[cfg(target_os = "windows")]
        {
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .status();
        }
        #[cfg(unix)]
        {
            let _ = Command::new("kill")
                .args(["-KILL", &pid.to_string()])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        #[cfg(not(any(target_os = "windows", unix)))]
        {
            let _ = pid;
        }
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
            self.signal_stop(handle);
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
        let (removed, warm): (Vec<JobHandle>, Vec<Box<dyn WorkerProc>>) = {
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
            let warm = std::mem::take(&mut inner.warm);
            inner.epoch = inner.epoch.wrapping_add(1);
            (drained, warm)
        };
        for handle in &removed {
            self.signal_stop(handle);
            if self.dispose_worker(handle) {
                self.finish_capacity();
            }
        }
        // 暖 worker 也要 kill，退出后不留 Python 进程；Drop 在锁外执行。
        for mut worker in warm {
            let _ = worker.kill();
            drop(worker);
            self.lock().counters.killed += 1;
        }
        self.cv.notify_all();
    }

    /// 只读快照。**不抢在途 worker 的锁**（否则 convert 阻塞读时会卡住 status），
    /// pid 来自 job 自己的 atomic；只有空闲暖 worker 才做一次非阻塞 try_wait。
    pub fn status(&self) -> PoolStatus {
        let (cap, max_waiters, busy, waiting, peak_busy, peak_waiters, counters, shutdown, handles, warm, warm_alive, warm_pids) = {
            let mut inner = self.lock();
            let handles: Vec<(JobId, JobHandle)> = inner
                .jobs
                .iter()
                .map(|(&id, handle)| (id, handle.clone()))
                .collect();
            let warm = inner.warm.len();
            let mut warm_alive = false;
            let mut warm_pids = Vec::new();
            for worker in inner.warm.iter_mut() {
                if worker.try_wait().map(|status| status.is_none()).unwrap_or(true) {
                    warm_alive = true;
                    warm_pids.push(worker.pid());
                }
            }
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
                warm,
                warm_alive,
                warm_pids,
            )
        };
        let warm_pid = warm_pids.first().copied();
        let workers = handles
            .iter()
            .map(|(id, handle)| {
                let pid = handle.pid.load(Ordering::SeqCst);
                WorkerInfo {
                    id: *id,
                    pid: if pid == 0 { None } else { Some(pid) },
                    ready: pid != 0,
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
            warm,
            warm_alive,
            warm_pid,
            warm_pids,
        }
    }

    /// 调整并发上限：clamp 到 [MIN_CAP, MAX_CAP]，返回实际生效的 cap。
    ///
    /// P2 语义：
    /// - 只改元数据，**不打断在途 job**；缩容后新 job 会排队，直到 `in_flight` 降到新 cap 以下；
    /// - 超出新 cap 的空闲暖 worker 在锁外 kill，避免留下多余 Python 进程；
    /// - 扩容后 `notify_all` 唤醒等待者（等待条件 `in_flight < cap` 需要重新求值）。
    pub fn set_cap(&self, cap: usize) -> usize {
        let cap = cap.clamp(MIN_CAP, MAX_CAP);
        let excess: Vec<Box<dyn WorkerProc>> = {
            let mut inner = self.lock();
            inner.cap = cap;
            // warm 末尾是刚放回的 worker：保留最近使用的 cap 个，多出来的从头部取走。
            let extra = inner.warm.len().saturating_sub(cap);
            inner.warm.drain(..extra).collect()
        };
        let killed = excess.len();
        // kill / drop 一律在池锁外：ChildWorker::drop 会 kill + wait，不能占着锁等进程退出。
        for mut worker in excess {
            let _ = worker.kill();
            drop(worker);
        }
        if killed > 0 {
            self.lock().counters.killed += killed;
        }
        self.cv.notify_all();
        cap
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
            let mut worker = {
                let mut guard = handle.worker.lock().unwrap_or_else(PoisonError::into_inner);
                guard.take()
            };
            // 只复用“健康且未被标记 broken”的 worker；EOF/读失败/已退出一律丢弃。
            let healthy = match worker.as_mut() {
                Some(worker) => {
                    !handle.broken.load(Ordering::SeqCst)
                        && worker.try_wait().map(|status| status.is_none()).unwrap_or(false)
                }
                None => false,
            };
            if healthy {
                let mut inner = self.lock();
                if inner.reuse && !inner.shutdown && inner.warm.len() < inner.cap {
                    if let Some(worker) = worker.take() {
                        inner.warm.push(worker);
                    }
                }
            }
            // drop 只能在池锁外：ChildWorker::drop 会 kill + wait。
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
    broken: Arc<AtomicBool>,
    /// 本 job 是否复用了暖 worker（false = 本次是新 spawn）。
    /// 生产用它决定是否把请求号 seq 归零，保持旧实现“每个 worker 一个 seq”的行为。
    reused: bool,
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

    /// 本 job 是否复用了暖 worker（false = 本次新 spawn 的进程）。
    pub fn reused(&self) -> bool {
        self.reused
    }

    /// 标记 worker 已不可复用（EOF / 读写失败）：Drop 时直接丢弃，不进入暖池。
    pub fn mark_broken(&self) {
        self.broken.store(true, Ordering::SeqCst);
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

impl Drop for WorkerPool {
    fn drop(&mut self) {
        // 进程退出兜底：暖 worker 不归任何 Lease 所有，池被 drop 时必须 kill，不能留 Python。
        // 在途 worker 由 Lease 持有（Lease 借用池，池不可能先于它 drop）。
        let warm = {
            let mut inner = self.lock();
            std::mem::take(&mut inner.warm)
        };
        for mut worker in warm {
            let _ = worker.kill();
        }
    }
}

/* ---------------- ChildWorker：真实 Python 子进程（P1 生产实现） ---------------- */

/// 用 std::process::Child 的 stdin/stdout 包装一个常驻推理 worker。
///
/// 约定（与旧生产路径等价）：
/// - stdin/stdout 走管道；WorkerProc::send 自动补换行并 flush，read_line 去掉行尾；
/// - stderr 固定丢弃（Stdio::null），防止无控制台时管道写满把 Python 卡死；
/// - Windows 上 spawn 带 CREATE_NO_WINDOW (0x08000000)，绝不弹控制台窗口；
/// - WorkerProc::emergency_pid 返回真实 pid，池取消时可绕过阻塞读直接 taskkill /T /F；
/// - Drop 一定 kill + wait，异常路径也不留进程。
pub struct ChildWorker {
    child: Child,
    stdin: ChildStdin,
    reader: BufReader<ChildStdout>,
    pid: u32,
    exit_code: Option<i32>,
}

impl ChildWorker {
    /// 用给定 Command 启动 worker。调用方只负责程序、参数、cwd 与环境变量；
    /// stdin/stdout/stderr 与 Windows 窗口标志由这里统一设置（调用方设置会被覆盖）。
    pub fn spawn(mut cmd: Command) -> io::Result<Self> {
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(target_os = "windows")]
        {
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn()?;
        let pid = child.id();
        let Some(stdin) = child.stdin.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "worker stdin unavailable"));
        };
        let Some(stdout) = child.stdout.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "worker stdout unavailable"));
        };
        Ok(Self {
            child,
            stdin,
            reader: BufReader::new(stdout),
            pid,
            exit_code: None,
        })
    }
}

impl WorkerProc for ChildWorker {
    fn pid(&self) -> u32 {
        self.pid
    }

    fn send(&mut self, line: &str) -> io::Result<()> {
        if self.exit_code.is_some() {
            return Err(io::Error::new(io::ErrorKind::BrokenPipe, "worker already exited"));
        }
        self.stdin.write_all(line.as_bytes())?;
        self.stdin.write_all(b"\n")?;
        self.stdin.flush()
    }

    fn read_line(&mut self) -> io::Result<Option<String>> {
        if self.exit_code.is_some() {
            return Ok(None);
        }
        let mut buf = String::new();
        let read = self.reader.read_line(&mut buf)?;
        if read == 0 {
            // 顺手收尸，避免 child 变成 zombie / handle 泄漏。
            let _ = self.try_wait();
            return Ok(None);
        }
        while buf.ends_with('\n') || buf.ends_with('\r') {
            buf.pop();
        }
        Ok(Some(buf))
    }

    fn try_wait(&mut self) -> io::Result<Option<i32>> {
        if let Some(code) = self.exit_code {
            return Ok(Some(code));
        }
        match self.child.try_wait()? {
            Some(status) => {
                let code = status.code().unwrap_or(-1);
                self.exit_code = Some(code);
                Ok(Some(code))
            }
            None => Ok(None),
        }
    }

    fn kill(&mut self) -> io::Result<()> {
        if self.exit_code.is_some() {
            return Ok(());
        }
        match self.child.try_wait() {
            Ok(Some(status)) => {
                self.exit_code = Some(status.code().unwrap_or(-1));
                return Ok(());
            }
            Ok(None) => {}
            Err(err) => return Err(err),
        }
        let kill_result = self.child.kill();
        match self.child.wait() {
            Ok(status) => {
                self.exit_code = Some(status.code().unwrap_or(-1));
                Ok(())
            }
            Err(wait_err) => kill_result.map_err(|_| wait_err),
        }
    }

    fn emergency_pid(&self) -> Option<u32> {
        Some(self.pid)
    }
}

impl Drop for ChildWorker {
    fn drop(&mut self) {
        let _ = self.kill();
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
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
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

    /* ---------------- P1：暖 worker 复用（MockWorker） ---------------- */

    #[test]
    fn warm_reuse_keeps_one_idle_worker_between_jobs() {
        let stats = shared();
        let pool = WorkerPool::with_limits_reuse(1, 4, true).unwrap();
        let pid = {
            let lease = pool.acquire(mock_factory(Arc::clone(&stats), 3_000)).unwrap();
            assert!(!lease.reused(), "first job must spawn a fresh worker");
            let pid = lease.pid().unwrap();
            drop(lease);
            pid
        };
        let status = pool.status();
        assert_eq!(status.busy, 0);
        assert_eq!(status.warm, 1);
        assert!(status.warm_alive);
        assert_eq!(status.warm_pid, Some(pid));
        assert_eq!(status.spawned, 1);
        assert_eq!(status.completed, 1);
        {
            let state = stats.lock().unwrap();
            assert_eq!(state.active, 1, "warm worker must stay alive between jobs");
            assert_eq!(state.completed, 0);
        }
        {
            let lease = pool.acquire(mock_factory(Arc::clone(&stats), 3_100)).unwrap();
            assert_eq!(lease.pid(), Some(pid), "warm worker should be reused");
            assert!(lease.reused(), "second job must report warm reuse");
            assert_eq!(pool.status().spawned, 1, "second job must not spawn a new worker");
        }
        assert_eq!(pool.status().warm, 1);

        pool.shutdown();
        let status = pool.status();
        assert!(status.shutdown);
        assert_eq!(status.warm, 0);
        assert_eq!(status.busy, 0);
        let state = stats.lock().unwrap();
        assert_eq!(state.spawned, 1);
        assert_eq!(state.active, 0, "shutdown must kill the warm worker");
        assert_eq!(state.killed, 1);
    }

    #[test]
    fn exited_worker_is_not_kept_warm() {
        let stats = shared();
        let pool = WorkerPool::with_limits_reuse(1, 4, true).unwrap();
        let factory_stats = Arc::clone(&stats);
        let lease = pool
            .acquire(move |_id, _cancel| {
                let mut worker = MockWorker::new(factory_stats, 3_200);
                worker.script_exit(9);
                Ok(Box::new(worker) as Box<dyn WorkerProc>)
            })
            .unwrap();
        drop(lease);

        let status = pool.status();
        assert_eq!(status.warm, 0, "exited worker must not be recycled");
        assert!(!status.warm_alive);
        assert_eq!(status.completed, 1);
        assert_eq!(stats.lock().unwrap().active, 0);

        // 下一次 acquire 必须重新 spawn（mock pid = base + 已 spawn 数）。
        let lease = pool.acquire(mock_factory(Arc::clone(&stats), 3_300)).unwrap();
        assert_eq!(lease.pid(), Some(3_301));
        assert_eq!(pool.status().spawned, 2);
    }

    #[test]
    fn broken_worker_is_dropped_instead_of_warmed() {
        let stats = shared();
        let pool = WorkerPool::with_limits_reuse(1, 4, true).unwrap();
        {
            let lease = pool.acquire(mock_factory(Arc::clone(&stats), 3_400)).unwrap();
            lease.mark_broken();
        }
        let status = pool.status();
        assert_eq!(status.warm, 0);
        assert_eq!(status.completed, 1);
        assert_eq!(stats.lock().unwrap().active, 0);
        assert_eq!(stats.lock().unwrap().killed, 0, "release only drops, it does not force-kill");
    }

    /* ---------------- P2：动态 cap（set_cap / cap2 并发 / status 非阻塞） ---------------- */

    #[test]
    fn set_cap_clamps_and_updates_status() {
        let pool = WorkerPool::with_limits(1, 4).unwrap();
        assert_eq!(pool.set_cap(0), MIN_CAP);
        assert_eq!(pool.status().cap, MIN_CAP);
        assert_eq!(pool.set_cap(99), MAX_CAP);
        assert_eq!(pool.status().cap, MAX_CAP);
        assert_eq!(pool.set_cap(2), 2);
        assert_eq!(pool.status().cap, 2);
    }

    #[test]
    fn set_cap_kills_excess_warm_workers_outside_lock() {
        let stats = shared();
        let pool = WorkerPool::with_limits_reuse(3, 8, true).unwrap();
        {
            let _a = pool.acquire(mock_factory(Arc::clone(&stats), 4_000)).unwrap();
            let _b = pool.acquire(mock_factory(Arc::clone(&stats), 4_100)).unwrap();
            let _c = pool.acquire(mock_factory(Arc::clone(&stats), 4_200)).unwrap();
            assert_eq!(stats.lock().unwrap().active, 3);
        }
        assert_eq!(pool.status().warm, 3, "three healthy workers should be warm");

        assert_eq!(pool.set_cap(1), 1);
        let status = pool.status();
        assert_eq!(status.cap, 1);
        assert_eq!(status.warm, 1, "excess warm workers must be trimmed");
        assert_eq!(status.warm_pids.len(), 1);
        let state = stats.lock().unwrap();
        assert_eq!(state.killed, 2, "trimmed warm workers must be killed");
        assert_eq!(state.active, 1);
        drop(state);

        pool.shutdown();
    }

    #[test]
    fn set_cap_shrink_keeps_running_jobs() {
        let stats = shared();
        let pool = WorkerPool::with_limits_reuse(3, 8, true).unwrap();
        let a = pool.acquire(mock_factory(Arc::clone(&stats), 4_300)).unwrap();
        let b = pool.acquire(mock_factory(Arc::clone(&stats), 4_400)).unwrap();
        let c = pool.acquire(mock_factory(Arc::clone(&stats), 4_500)).unwrap();
        assert_eq!(stats.lock().unwrap().active, 3);

        assert_eq!(pool.set_cap(1), 1);
        assert_eq!(pool.status().busy, 3, "in-flight jobs keep their slots");
        assert_eq!(stats.lock().unwrap().active, 3);
        assert_eq!(stats.lock().unwrap().killed, 0, "set_cap must never kill running jobs");

        // 三个在途 job 都还能正常读写（缩容只影响新 job 的排队）。
        a.send("a").unwrap();
        b.send("b").unwrap();
        c.send("c").unwrap();
        assert_eq!(stats.lock().unwrap().sent, vec!["a".to_string(), "b".to_string(), "c".to_string()]);

        drop(a);
        drop(b);
        drop(c);
        let status = pool.status();
        assert_eq!(status.busy, 0);
        assert_eq!(status.warm, 1, "cap=1 keeps one warm worker after draining");
        assert_eq!(stats.lock().unwrap().active, 1);
        pool.shutdown();
    }

    #[test]
    fn set_cap_expand_wakes_waiter() {
        let stats = shared();
        let pool = Arc::new(WorkerPool::with_limits(1, 4).unwrap());
        let held = pool.acquire(mock_factory(Arc::clone(&stats), 4_600)).unwrap();
        let (tx, rx) = mpsc::channel();
        let waiter_pool = Arc::clone(&pool);
        let waiter_stats = Arc::clone(&stats);
        let waiter = thread::spawn(move || {
            let outcome = waiter_pool
                .acquire(mock_factory(waiter_stats, 4_700))
                .map(|lease| lease.pid());
            tx.send(outcome).unwrap();
        });
        wait_until("waiter registered before set_cap", || pool.status().waiting == 1);

        assert_eq!(pool.set_cap(2), 2);
        let acquired = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("set_cap must wake the waiter")
            .expect("waiter should acquire after cap expands");
        assert!(acquired.is_some());
        waiter.join().unwrap();
        assert_eq!(pool.status().cap, 2);
        drop(held);
        assert_eq!(pool.status().busy, 0);
    }

    #[test]
    fn set_cap_two_runs_jobs_concurrently_and_cancel_is_isolated() {
        let stats = shared();
        let pool = WorkerPool::with_limits_reuse(1, 8, true).unwrap();
        assert_eq!(pool.set_cap(2), 2, "P2 must allow two slots");

        let lease_a = pool.acquire(mock_factory(Arc::clone(&stats), 4_800)).unwrap();
        let lease_b = pool.acquire(mock_factory(Arc::clone(&stats), 4_900)).unwrap();
        {
            let state = stats.lock().unwrap();
            assert_eq!(state.active, 2, "cap=2 must run two workers at the same time");
            assert_eq!(state.max_active, 2);
        }
        let status = pool.status();
        assert_eq!(status.cap, 2);
        assert_eq!(status.busy, 2);
        assert_eq!(status.workers.len(), 2);

        // 取消其中一个：另一个必须完全不受影响。
        let id_a = lease_a.id();
        assert!(pool.cancel(id_a));
        assert!(lease_a.is_canceled());
        assert!(!lease_b.is_canceled());
        assert!(matches!(lease_a.send("gone"), Err(PoolError::WorkerGone)));
        lease_b.send("b-alive").unwrap();
        assert!(stats.lock().unwrap().sent.iter().any(|line| line == "b-alive"));

        drop(lease_a);
        drop(lease_b);
        let status = pool.status();
        assert_eq!(status.busy, 0);
        assert_eq!(status.canceled, 1);
        assert_eq!(status.warm, 1, "only the surviving worker can be warmed");
        let state = stats.lock().unwrap();
        assert_eq!(state.killed, 1);
        assert_eq!(state.canceled, 1);
        assert_eq!(state.active, 1);
        drop(state);
        pool.shutdown();
    }

    #[test]
    fn status_does_not_block_on_busy_worker_slot() {
        let stats = shared();
        let pool = WorkerPool::with_limits(1, 4).unwrap();
        let lease = pool.acquire(mock_factory(Arc::clone(&stats), 5_000)).unwrap();
        // 模拟 convert 正卡在 read_line：该 job 的 worker 槽锁被长时间持有。
        let guard = lease.slot.lock().unwrap_or_else(PoisonError::into_inner);
        let started = Instant::now();
        let status = pool.status();
        let elapsed = started.elapsed();
        drop(guard);

        assert!(
            elapsed < Duration::from_millis(500),
            "status() must not wait for the in-flight worker slot (took {elapsed:?})"
        );
        assert_eq!(status.busy, 1);
        assert_eq!(status.workers.len(), 1);
        assert_eq!(status.workers[0].pid, lease.pid());
        assert!(status.workers[0].ready);
        drop(lease);
    }

    /* ---------------- P1：真实 Python 子进程（无窗口、不加载模型） ---------------- */

    const REAL_ECHO_CODE: &str = r#"
import json, sys
sys.stderr.write('x' * 1048576)
sys.stderr.flush()
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    sys.stdout.write('###RESULT ' + json.dumps({'echo': line}) + '\n')
    sys.stdout.flush()
"#;

    fn python_exe() -> Option<PathBuf> {
        if let Ok(path) = std::env::var("FUFUMIDI_PYTHON") {
            let path = PathBuf::from(path);
            if path.is_file() {
                return Some(path);
            }
        }
        let bundled = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../resources/python/python.exe");
        if bundled.is_file() {
            return Some(bundled);
        }
        for candidate in ["python", "python3"] {
            let ok = Command::new(candidate)
                .arg("--version")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|status| status.success())
                .unwrap_or(false);
            if ok {
                return Some(PathBuf::from(candidate));
            }
        }
        None
    }

    fn missing_python(test: &str) -> bool {
        if python_exe().is_some() {
            false
        } else {
            eprintln!("{test}: skipped (python runtime not found)");
            true
        }
    }

    fn real_echo_factory() -> impl FnOnce(JobId, Arc<AtomicBool>) -> Result<Box<dyn WorkerProc>, String> {
        |_id, _cancel| {
            let python = python_exe().ok_or_else(|| "python runtime not found".to_string())?;
            let mut cmd = Command::new(python);
            cmd.args(["-u", "-c", REAL_ECHO_CODE])
                .env("PYTHONIOENCODING", "utf-8")
                .env("PYTHONUTF8", "1");
            ChildWorker::spawn(cmd)
                .map(|worker| Box::new(worker) as Box<dyn WorkerProc>)
                .map_err(|err| err.to_string())
        }
    }

    fn real_silent_factory() -> impl FnOnce(JobId, Arc<AtomicBool>) -> Result<Box<dyn WorkerProc>, String> {
        |_id, _cancel| {
            let python = python_exe().ok_or_else(|| "python runtime not found".to_string())?;
            let mut cmd = Command::new(python);
            cmd.args(["-u", "-c", "import time\ntime.sleep(8)\n"]);
            ChildWorker::spawn(cmd)
                .map(|worker| Box::new(worker) as Box<dyn WorkerProc>)
                .map_err(|err| err.to_string())
        }
    }

    #[test]
    fn real_child_worker_echoes_without_stderr_blocking() {
        if missing_python("real_child_worker_echoes_without_stderr_blocking") {
            return;
        }
        let mut cmd = Command::new(python_exe().unwrap());
        cmd.args(["-u", "-c", REAL_ECHO_CODE])
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONUTF8", "1");
        let mut worker = ChildWorker::spawn(cmd).expect("spawn python echo worker");
        assert!(worker.pid() > 0);
        assert_eq!(worker.emergency_pid(), Some(worker.pid()));
        assert_eq!(worker.try_wait().unwrap(), None, "fresh worker must be alive");

        worker.send("hello").unwrap();
        let line = worker.read_line().unwrap().expect("echo response");
        let payload = line.strip_prefix("###RESULT ").expect("protocol prefix");
        let value: serde_json::Value = serde_json::from_str(payload).unwrap();
        assert_eq!(value["echo"], "hello");

        worker.send("世界").unwrap();
        let line = worker.read_line().unwrap().expect("unicode echo response");
        let value: serde_json::Value =
            serde_json::from_str(line.strip_prefix("###RESULT ").unwrap()).unwrap();
        assert_eq!(value["echo"], "世界");

        worker.kill().unwrap();
        assert!(worker.try_wait().unwrap().is_some());
        worker.kill().unwrap(); // 幂等
    }

    #[test]
    fn real_pool_cancel_unblocks_reading_worker_and_reaps_it() {
        if missing_python("real_pool_cancel_unblocks_reading_worker_and_reaps_it") {
            return;
        }
        let pool = Arc::new(WorkerPool::with_reuse(1).unwrap());
        let lease = pool.acquire(real_silent_factory()).expect("acquire real worker");
        let id = lease.id();
        assert!(lease.pid().is_some());
        let cancel_pool = Arc::clone(&pool);
        let cancel = thread::spawn(move || {
            thread::sleep(Duration::from_millis(120));
            cancel_pool.cancel(id)
        });

        let started = Instant::now();
        let outcome = lease.read_line();
        let elapsed = started.elapsed();
        assert!(
            elapsed < Duration::from_secs(5),
            "read stayed blocked after cancel: {elapsed:?}"
        );
        match &outcome {
            Ok(None) | Err(PoolError::WorkerGone) | Err(PoolError::Io(_)) => {}
            other => panic!("unexpected read result after cancel: {other:?}"),
        }
        assert!(lease.is_canceled());
        assert!(cancel.join().unwrap(), "cancel should hit the live job");
        drop(lease);

        let status = pool.status();
        assert_eq!(status.busy, 0);
        assert_eq!(status.canceled, 1);
        assert_eq!(status.warm, 0, "canceled worker must not be recycled");
        assert!(status.workers.is_empty());

        // 取消杀掉 worker 之后，下一次请求必须能重新拉起。
        let lease = pool.acquire(real_echo_factory()).expect("pool must restart after cancel");
        lease.send("after-cancel").unwrap();
        let line = lease.read_line().unwrap().expect("response after restart");
        assert!(line.contains("after-cancel"));
        drop(lease);
        assert_eq!(pool.status().spawned, 2, "restart must spawn a fresh child");
        pool.shutdown();
    }


    const REAL_ONCE_CODE: &str = r#"
import json, sys
line = sys.stdin.readline()
if line:
    sys.stdout.write('###RESULT ' + json.dumps({'echo': line.strip()}) + '\n')
    sys.stdout.flush()
"#;

    fn real_once_factory() -> impl FnOnce(JobId, Arc<AtomicBool>) -> Result<Box<dyn WorkerProc>, String> {
        |_id, _cancel| {
            let python = python_exe().ok_or_else(|| "python runtime not found".to_string())?;
            let mut cmd = Command::new(python);
            cmd.args(["-u", "-c", REAL_ONCE_CODE])
                .env("PYTHONIOENCODING", "utf-8")
                .env("PYTHONUTF8", "1");
            ChildWorker::spawn(cmd)
                .map(|worker| Box::new(worker) as Box<dyn WorkerProc>)
                .map_err(|err| err.to_string())
        }
    }

    #[test]
    fn real_pool_restarts_after_child_eof() {
        if missing_python("real_pool_restarts_after_child_eof") {
            return;
        }
        let pool = Arc::new(WorkerPool::with_reuse(1).unwrap());
        let first_pid = {
            let lease = pool.acquire(real_once_factory()).expect("first acquire");
            let pid = lease.pid().expect("worker pid");
            lease.send("one").unwrap();
            let line = lease.read_line().unwrap().expect("one-shot response");
            assert!(line.contains("one"));
            assert_eq!(lease.read_line().unwrap(), None, "one-shot worker must EOF");
            // 生产 run_convert 在 EOF 时会 mark_broken；这里照做，确保不会把 EOF 的 worker 暖起来。
            lease.mark_broken();
            pid
        };
        assert_eq!(pool.status().warm, 0, "EOF worker must not be warmed");

        // EOF 之后下一次请求必须能重新拉起一个新 worker。
        let lease = pool.acquire(real_echo_factory()).expect("restart after EOF");
        assert_ne!(lease.pid().unwrap(), first_pid);
        lease.send("two").unwrap();
        let line = lease.read_line().unwrap().expect("restarted worker response");
        assert!(line.contains("two"));
        drop(lease);
        assert_eq!(pool.status().spawned, 2);
        pool.shutdown();
    }

    #[test]
    fn real_pool_reuses_warm_worker_between_jobs() {
        if missing_python("real_pool_reuses_warm_worker_between_jobs") {
            return;
        }
        let pool = Arc::new(WorkerPool::with_reuse(1).unwrap());
        let first_pid = {
            let lease = pool.acquire(real_echo_factory()).expect("first acquire");
            assert!(!lease.reused(), "first real job must spawn a fresh worker");
            lease.send("first").unwrap();
            let line = lease.read_line().unwrap().expect("first response");
            assert!(line.contains("\"first\""));
            lease.pid().unwrap()
        };
        let status = pool.status();
        assert_eq!(status.warm, 1);
        assert!(status.warm_alive);
        assert_eq!(status.warm_pid, Some(first_pid));
        assert_eq!(status.spawned, 1);

        let lease = pool.acquire(real_echo_factory()).expect("second acquire");
        assert_eq!(lease.pid(), Some(first_pid), "warm child must be reused");
        assert!(lease.reused(), "second real job must report warm reuse");
        lease.send("second").unwrap();
        let line = lease.read_line().unwrap().expect("second response");
        assert!(line.contains("\"second\""));
        drop(lease);
        assert_eq!(pool.status().spawned, 1, "second job must not spawn a new child");

        pool.shutdown();
        let status = pool.status();
        assert_eq!(status.warm, 0);
        assert_eq!(status.busy, 0);
    }

    #[test]
    fn real_cap_two_workers_run_independently() {
        if missing_python("real_cap_two_workers_run_independently") {
            return;
        }
        let pool = WorkerPool::with_limits_reuse(2, 8, true).unwrap();
        let lease_a = pool.acquire(real_echo_factory()).expect("first worker");
        let lease_b = pool.acquire(real_echo_factory()).expect("second worker");
        let pid_a = lease_a.pid().expect("first pid");
        let pid_b = lease_b.pid().expect("second pid");
        assert_ne!(pid_a, pid_b, "cap=2 must spawn two independent children");

        // 两个子进程各有自己的 stdin/stdout：同时写入并各自读回，互不串线。
        lease_a.send("alpha").unwrap();
        lease_b.send("beta").unwrap();
        let line_a = lease_a.read_line().unwrap().expect("alpha response");
        let line_b = lease_b.read_line().unwrap().expect("beta response");
        assert!(line_a.contains("alpha"));
        assert!(line_b.contains("beta"));
        assert_eq!(pool.status().busy, 2);

        drop(lease_a);
        drop(lease_b);
        assert_eq!(pool.status().warm, 2, "both healthy children stay warm under cap=2");
        pool.shutdown();
        assert_eq!(pool.status().warm, 0);
    }
}
