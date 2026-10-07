//! Fixed-size thread pool for CPU-bound page work, standard library only.
//!
//! Design: one shared FIFO queue behind a mutex plus a condition variable,
//! not per-thread work-stealing deques. Why: a page job costs tens to
//! hundreds of microseconds, so the queue lock (sub-microsecond, uncontended
//! most of the time) is noise, while a correct lock-free Chase–Lev deque is
//! several hundred lines of `unsafe`. Jobs are submitted largest first by
//! the caller (LPT scheduling) so the tail of the build is short; that
//! matters more than steal latency at this granularity.
//!
//! `scope` runs a batch of jobs and waits for all of them, propagating the
//! first panic, so callers never leak work past a build step.

use std::collections::VecDeque;
use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};

type Job = Box<dyn FnOnce() + Send + 'static>;

struct Shared {
	queue: Mutex<QueueState>,
	available: Condvar,
	/// Signalled when `pending` drops to zero.
	idle: Condvar,
}

struct QueueState {
	jobs: VecDeque<Job>,
	/// Jobs queued or running.
	pending: usize,
	shutting_down: bool,
	/// The payload of the first panic in a job, replayed by `scope` / `wait`.
	panic: Option<Box<dyn std::any::Any + Send + 'static>>,
}

/// A pool of worker threads.
///
/// # Example
///
/// ```
/// use std::sync::atomic::{AtomicUsize, Ordering};
/// use std::sync::Arc;
///
/// let pool = kd_pool::Pool::new(4);
/// let hits = Arc::new(AtomicUsize::new(0));
/// pool.scope(|s| {
///     for _ in 0..100 {
///         let hits = Arc::clone(&hits);
///         s.spawn(move || {
///             hits.fetch_add(1, Ordering::Relaxed);
///         });
///     }
/// });
/// assert_eq!(hits.load(Ordering::Relaxed), 100);
/// ```
pub struct Pool {
	shared: Arc<Shared>,
	workers: Vec<JoinHandle<()>>,
	size: usize,
}

impl Pool {
	/// Creates a pool with `size` threads (at least one).
	#[must_use]
	pub fn new(size: usize) -> Pool {
		let size = size.max(1);
		let shared = Arc::new(Shared {
			queue: Mutex::new(QueueState {
				jobs: VecDeque::new(),
				pending: 0,
				shutting_down: false,
				panic: None,
			}),
			available: Condvar::new(),
			idle: Condvar::new(),
		});
		let workers = (0..size)
			.map(|i| {
				let shared = Arc::clone(&shared);
				thread::Builder::new()
					.name(format!("kd-pool-{i}"))
					.spawn(move || worker_loop(&shared))
					.expect("spawn pool thread")
			})
			.collect();
		Pool {
			shared,
			workers,
			size,
		}
	}

	/// Creates a pool sized to the available parallelism of the machine.
	#[must_use]
	pub fn with_available_parallelism() -> Pool {
		let n = thread::available_parallelism()
			.map(|n| n.get())
			.unwrap_or(1);
		Pool::new(n)
	}

	/// Number of worker threads.
	#[must_use]
	pub fn size(&self) -> usize {
		self.size
	}

	/// Runs `f`, which may spawn jobs through the scope, and returns after
	/// every job spawned in the scope has finished. If any job panicked, the
	/// first panic is re-raised here, after all other jobs finished.
	pub fn scope<R>(&self, f: impl FnOnce(&Scope<'_>) -> R) -> R {
		let scope = Scope { pool: self };
		let result = f(&scope);
		self.wait();
		result
	}

	/// Blocks until no job is queued or running, then re-raises the first
	/// job panic if there was one.
	pub fn wait(&self) {
		let mut state = self.shared.queue.lock().unwrap_or_else(|e| e.into_inner());
		while state.pending > 0 {
			state = self
				.shared
				.idle
				.wait(state)
				.unwrap_or_else(|e| e.into_inner());
		}
		if let Some(payload) = state.panic.take() {
			drop(state);
			resume_unwind(payload);
		}
	}

	fn submit(&self, job: Job) {
		let mut state = self.shared.queue.lock().unwrap_or_else(|e| e.into_inner());
		state.pending += 1;
		state.jobs.push_back(job);
		drop(state);
		self.shared.available.notify_one();
	}
}

impl Drop for Pool {
	fn drop(&mut self) {
		{
			let mut state = self.shared.queue.lock().unwrap_or_else(|e| e.into_inner());
			state.shutting_down = true;
		}
		self.shared.available.notify_all();
		for worker in self.workers.drain(..) {
			let _ = worker.join();
		}
	}
}

/// Handle for spawning jobs inside [`Pool::scope`].
pub struct Scope<'a> {
	pool: &'a Pool,
}

impl Scope<'_> {
	/// Queues a job. It runs on some pool thread before `scope` returns.
	pub fn spawn(&self, job: impl FnOnce() + Send + 'static) {
		self.pool.submit(Box::new(job));
	}
}

fn worker_loop(shared: &Shared) {
	loop {
		let job = {
			let mut state = shared.queue.lock().unwrap_or_else(|e| e.into_inner());
			loop {
				if let Some(job) = state.jobs.pop_front() {
					break Some(job);
				}
				if state.shutting_down {
					break None;
				}
				state = shared
					.available
					.wait(state)
					.unwrap_or_else(|e| e.into_inner());
			}
		};
		let Some(job) = job else {
			return;
		};
		let outcome = catch_unwind(AssertUnwindSafe(job));
		let mut state = shared.queue.lock().unwrap_or_else(|e| e.into_inner());
		if let Err(payload) = outcome
			&& state.panic.is_none()
		{
			state.panic = Some(payload);
		}
		state.pending -= 1;
		if state.pending == 0 {
			shared.idle.notify_all();
		}
	}
}

/// Runs `jobs` on the pool and collects their results in input order.
///
/// # Example
///
/// ```
/// let pool = kd_pool::Pool::new(2);
/// let squares = kd_pool::map(&pool, vec![1, 2, 3], |n| n * n);
/// assert_eq!(squares, vec![1, 4, 9]);
/// ```
pub fn map<T, R>(pool: &Pool, items: Vec<T>, f: impl Fn(T) -> R + Send + Sync + 'static) -> Vec<R>
where
	T: Send + 'static,
	R: Send + 'static,
{
	let n = items.len();
	let slots: Arc<Mutex<Vec<Option<R>>>> = Arc::new(Mutex::new((0..n).map(|_| None).collect()));
	let f = Arc::new(f);
	let done = Arc::new(AtomicUsize::new(0));
	pool.scope(|s| {
		for (i, item) in items.into_iter().enumerate() {
			let slots = Arc::clone(&slots);
			let f = Arc::clone(&f);
			let done = Arc::clone(&done);
			s.spawn(move || {
				let r = f(item);
				slots.lock().unwrap_or_else(|e| e.into_inner())[i] = Some(r);
				done.fetch_add(1, Ordering::Release);
			});
		}
	});
	let slots = Arc::try_unwrap(slots)
		.ok()
		.expect("all jobs finished")
		.into_inner()
		.unwrap_or_else(|e| e.into_inner());
	slots
		.into_iter()
		.map(|slot| slot.expect("every slot filled"))
		.collect()
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::sync::atomic::AtomicUsize;
	use std::time::Duration;

	#[test]
	fn runs_every_job_exactly_once() {
		let pool = Pool::new(4);
		let counter = Arc::new(AtomicUsize::new(0));
		pool.scope(|s| {
			for _ in 0..1000 {
				let counter = Arc::clone(&counter);
				s.spawn(move || {
					counter.fetch_add(1, Ordering::Relaxed);
				});
			}
		});
		assert_eq!(counter.load(Ordering::Relaxed), 1000);
	}

	#[test]
	fn scope_waits_for_slow_jobs() {
		let pool = Pool::new(2);
		let finished = Arc::new(AtomicUsize::new(0));
		pool.scope(|s| {
			for _ in 0..4 {
				let finished = Arc::clone(&finished);
				s.spawn(move || {
					thread::sleep(Duration::from_millis(20));
					finished.fetch_add(1, Ordering::SeqCst);
				});
			}
		});
		assert_eq!(finished.load(Ordering::SeqCst), 4);
	}

	#[test]
	fn jobs_run_on_pool_threads_in_parallel() {
		let pool = Pool::new(4);
		let names = Arc::new(Mutex::new(Vec::new()));
		pool.scope(|s| {
			for _ in 0..8 {
				let names = Arc::clone(&names);
				s.spawn(move || {
					thread::sleep(Duration::from_millis(10));
					names
						.lock()
						.unwrap()
						.push(thread::current().name().unwrap_or("").to_string());
				});
			}
		});
		let names = names.lock().unwrap();
		assert_eq!(names.len(), 8);
		assert!(names.iter().all(|n| n.starts_with("kd-pool-")));
	}

	#[test]
	fn two_jobs_can_be_running_at_the_same_moment() {
		// Each of the two waits for the other at the barrier: a pool that ran one job at
		// a time would never get past it (the test would hang, not pass by luck).
		let pool = Pool::new(2);
		let barrier = Arc::new(std::sync::Barrier::new(2));
		let met = Arc::new(AtomicUsize::new(0));
		pool.scope(|s| {
			for _ in 0..2 {
				let barrier = Arc::clone(&barrier);
				let met = Arc::clone(&met);
				s.spawn(move || {
					barrier.wait();
					met.fetch_add(1, Ordering::SeqCst);
				});
			}
		});
		assert_eq!(met.load(Ordering::SeqCst), 2);
	}

	#[test]
	fn map_preserves_input_order() {
		let pool = Pool::new(3);
		let out = map(&pool, (0..50).collect(), |n| {
			// Reverse the finishing order so position must not depend on timing.
			thread::sleep(Duration::from_micros((50 - n) as u64 * 50));
			n * 2
		});
		assert_eq!(out, (0..50).map(|n| n * 2).collect::<Vec<_>>());
	}

	#[test]
	fn panics_are_propagated_after_the_scope_finishes() {
		let pool = Pool::new(2);
		let others = Arc::new(AtomicUsize::new(0));
		let result = catch_unwind(AssertUnwindSafe(|| {
			pool.scope(|s| {
				s.spawn(|| panic!("boom"));
				for _ in 0..10 {
					let others = Arc::clone(&others);
					s.spawn(move || {
						others.fetch_add(1, Ordering::SeqCst);
					});
				}
			});
		}));
		let payload = result.expect_err("scope should re-raise the job panic");
		assert_eq!(payload.downcast_ref::<&str>(), Some(&"boom"));
		assert_eq!(others.load(Ordering::SeqCst), 10, "other jobs still ran");
		// The pool is still usable afterwards.
		let after = Arc::new(AtomicUsize::new(0));
		pool.scope(|s| {
			let after = Arc::clone(&after);
			s.spawn(move || {
				after.fetch_add(1, Ordering::SeqCst);
			});
		});
		assert_eq!(after.load(Ordering::SeqCst), 1);
	}

	#[test]
	fn size_is_at_least_one() {
		assert_eq!(Pool::new(0).size(), 1);
		assert_eq!(Pool::new(3).size(), 3);
		assert!(Pool::with_available_parallelism().size() >= 1);
	}

	#[test]
	fn dropping_an_idle_pool_joins_its_threads() {
		let pool = Pool::new(2);
		pool.scope(|s| s.spawn(|| {}));
		drop(pool);
	}
}
