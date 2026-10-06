//! A scoped parallel map over a slice, for the phases of a build that are the
//! same work for every page (reading and hashing the sources, compiling the
//! modules).
//!
//! Why not the pool of `kd_pool`: its jobs must be `'static`, and these phases
//! borrow the config and the plan. Scoped threads borrow freely, and the
//! phases are short enough that starting a few threads each time costs
//! nothing next to the work.

use std::sync::atomic::{AtomicUsize, Ordering};

/// Items handed to a thread at a time: big enough that the shared counter is
/// not contended, small enough that the last thread does not run alone long.
const CHUNK: usize = 16;

/// Applies `f` to every item on up to `threads` threads and returns the
/// results in the order of the items.
///
/// # Example
///
/// ```
/// let squares = kd_core::parallel::map(&[1, 2, 3, 4], 2, |n| n * n);
/// assert_eq!(squares, [1, 4, 9, 16]);
/// ```
pub fn map<T: Sync, R: Send>(items: &[T], threads: usize, f: impl Fn(&T) -> R + Sync) -> Vec<R> {
	let threads = threads.clamp(1, items.len().div_ceil(CHUNK).max(1));
	if threads == 1 {
		return items.iter().map(f).collect();
	}
	let next = AtomicUsize::new(0);
	let mut parts: Vec<Vec<(usize, R)>> = std::thread::scope(|scope| {
		let workers: Vec<_> = (0..threads)
			.map(|_| {
				scope.spawn(|| {
					let mut mine = Vec::new();
					loop {
						let start = next.fetch_add(CHUNK, Ordering::Relaxed);
						if start >= items.len() {
							break;
						}
						for (offset, item) in items[start..(start + CHUNK).min(items.len())]
							.iter()
							.enumerate()
						{
							mine.push((start + offset, f(item)));
						}
					}
					mine
				})
			})
			.collect();
		workers
			.into_iter()
			.map(|w| w.join().unwrap_or_else(|e| std::panic::resume_unwind(e)))
			.collect()
	});
	let mut all: Vec<(usize, R)> = parts.drain(..).flatten().collect();
	all.sort_by_key(|(i, _)| *i);
	all.into_iter().map(|(_, r)| r).collect()
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn results_come_back_in_the_order_of_the_items_on_any_thread_count() {
		let items: Vec<usize> = (0..1000).collect();
		for threads in [1, 2, 7, 64] {
			let out = map(&items, threads, |n| n * 3);
			assert_eq!(out, items.iter().map(|n| n * 3).collect::<Vec<_>>());
		}
	}

	#[test]
	fn an_empty_slice_and_borrowed_state_work() {
		let empty: [u8; 0] = [];
		assert!(map(&empty, 4, |b| *b).is_empty());
		let table = [10, 20, 30];
		assert_eq!(map(&[0usize, 2, 1], 3, |&i| table[i]), [10, 30, 20]);
	}

	#[test]
	fn work_is_spread_over_several_threads() {
		let items: Vec<usize> = (0..256).collect();
		let ids = map(&items, 4, |_| {
			std::thread::sleep(std::time::Duration::from_micros(200));
			std::thread::current().id()
		});
		let distinct: std::collections::HashSet<_> = ids.into_iter().collect();
		assert!(distinct.len() > 1);
	}
}
