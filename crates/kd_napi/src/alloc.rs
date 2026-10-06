//! The allocator of the addon: small blocks come from per-thread free lists.
//!
//! Why: building a page allocates and frees tens of thousands of small
//! blocks (strings, tree nodes, printer documents), and with every core busy
//! the system allocator is a measurable share of the time (profiles showed
//! about 40% of the CPU in `malloc`/`free`/`memmove` in the HTML stages) and
//! the reason threads scale worse than they should. Blocks up to
//! [`MAX_SMALL`] bytes are carved out of 256 KiB chunks per size class and
//! recycled through a free list owned by the thread that frees them; nothing
//! is returned to the system, which suits a process that builds a site and
//! exits. Larger blocks and unusual alignments go to the system allocator.
//!
//! Safety argument, in one place: a block handed out for a small layout is
//! always a whole block of its size class (from a chunk, or, when the
//! thread's cache is being torn down, from the system allocator with the
//! class size), so it can be put on a free list of that class by any thread.
//! A free list only ever holds blocks of its own class. Blocks are 16-byte
//! aligned because the class sizes are multiples of 16 and chunks are 16-byte
//! aligned.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::UnsafeCell;
use std::ptr::null_mut;

/// The size classes, in bytes (every one a multiple of 16).
const CLASSES: [usize; 12] = [16, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024];
/// The largest block served from the pools.
pub const MAX_SMALL: usize = 1024;
/// How much is taken from the system at a time for one class.
const CHUNK: usize = 256 * 1024;
const ALIGN: usize = 16;

/// The class of a size (`size <= MAX_SMALL`).
fn class_of(size: usize) -> usize {
	CLASSES.iter().position(|&c| size <= c).unwrap_or(0)
}

/// One thread's pools: a free list, and the unused rest of the current chunk,
/// per class. A free block's first word is the next free block.
struct Cache {
	free: [*mut u8; CLASSES.len()],
	bump: [*mut u8; CLASSES.len()],
	end: [*mut u8; CLASSES.len()],
}

thread_local! {
	static CACHE: UnsafeCell<Cache> = const {
		UnsafeCell::new(Cache {
			free: [null_mut(); CLASSES.len()],
			bump: [null_mut(); CLASSES.len()],
			end: [null_mut(); CLASSES.len()],
		})
	};
}

/// The allocator. Install it with `#[global_allocator]`.
pub struct PoolAlloc;

impl Cache {
	/// A block of class `class`, or null when the system has none to give.
	///
	/// # Safety
	///
	/// Only the thread that owns the cache calls this.
	unsafe fn take(&mut self, class: usize) -> *mut u8 {
		let head = self.free[class];
		if !head.is_null() {
			// SAFETY: a block on a free list is at least a pointer wide and
			// aligned to 16; its first word was written by `give`.
			self.free[class] = unsafe { *head.cast::<*mut u8>() };
			return head;
		}
		let size = CLASSES[class];
		if (self.end[class] as usize) - (self.bump[class] as usize) < size {
			// SAFETY: a non-zero size and a power-of-two alignment.
			let chunk = unsafe { System.alloc(Layout::from_size_align_unchecked(CHUNK, ALIGN)) };
			if chunk.is_null() {
				return null_mut();
			}
			self.bump[class] = chunk;
			// SAFETY: `chunk` points at `CHUNK` bytes.
			self.end[class] = unsafe { chunk.add(CHUNK) };
		}
		let block = self.bump[class];
		// SAFETY: at least `size` bytes remain before `end`.
		self.bump[class] = unsafe { block.add(size) };
		block
	}

	/// Puts a block of class `class` on the free list.
	///
	/// # Safety
	///
	/// `block` is a whole, unused block of that class.
	unsafe fn give(&mut self, class: usize, block: *mut u8) {
		// SAFETY: a block holds at least 16 bytes and is 16-byte aligned.
		unsafe { *block.cast::<*mut u8>() = self.free[class] };
		self.free[class] = block;
	}
}

fn is_small(layout: Layout) -> bool {
	layout.size() <= MAX_SMALL && layout.align() <= ALIGN
}

// SAFETY: see the module documentation: blocks are valid, distinct while
// live and sized for their layout; the system allocator backs everything else.
unsafe impl GlobalAlloc for PoolAlloc {
	unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
		if !is_small(layout) {
			// SAFETY: forwarded with the caller's layout.
			return unsafe { System.alloc(layout) };
		}
		let class = class_of(layout.size().max(1));
		let from_cache = CACHE.try_with(|cache| {
			// SAFETY: the cache belongs to this thread; no other reference lives.
			unsafe { (*cache.get()).take(class) }
		});
		match from_cache {
			Ok(block) => block,
			// The thread is shutting down and its cache is gone: a block of the
			// class size from the system (it is never returned to it).
			Err(_) => {
				// SAFETY: a non-zero size and a power-of-two alignment.
				unsafe { System.alloc(Layout::from_size_align_unchecked(CLASSES[class], ALIGN)) }
			}
		}
	}

	unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
		if !is_small(layout) {
			// SAFETY: forwarded with the layout it was allocated with.
			unsafe { System.dealloc(ptr, layout) };
			return;
		}
		let class = class_of(layout.size().max(1));
		// A thread that is shutting down leaks the block, which is harmless.
		let _ = CACHE.try_with(|cache| {
			// SAFETY: the cache belongs to this thread; `ptr` is a whole block of
			// this class (see the module documentation).
			unsafe { (*cache.get()).give(class, ptr) };
		});
	}

	unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
		// SAFETY: the caller guarantees a valid layout for `new_size`.
		let new_layout = unsafe { Layout::from_size_align_unchecked(new_size, layout.align()) };
		if !is_small(layout) && !is_small(new_layout) {
			// SAFETY: both came from the system allocator.
			return unsafe { System.realloc(ptr, layout, new_size) };
		}
		if is_small(layout)
			&& is_small(new_layout)
			&& class_of(layout.size().max(1)) == class_of(new_size.max(1))
		{
			return ptr;
		}
		// SAFETY: a new block, a copy of what fits, and the old block released.
		unsafe {
			let new = self.alloc(new_layout);
			if !new.is_null() {
				std::ptr::copy_nonoverlapping(ptr, new, layout.size().min(new_size));
				self.dealloc(ptr, layout);
			}
			new
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn layout(size: usize, align: usize) -> Layout {
		Layout::from_size_align(size, align).unwrap()
	}

	#[test]
	fn classes_are_sorted_aligned_and_cover_every_small_size() {
		assert!(CLASSES.windows(2).all(|w| w[0] < w[1]));
		assert!(CLASSES.iter().all(|c| c % ALIGN == 0));
		assert_eq!(*CLASSES.last().unwrap(), MAX_SMALL);
		for size in 1..=MAX_SMALL {
			assert!(CLASSES[class_of(size)] >= size, "{size}");
			let class = class_of(size);
			assert!(
				class == 0 || CLASSES[class - 1] < size,
				"{size} is not in the smallest class that fits"
			);
		}
	}

	#[test]
	fn live_blocks_do_not_overlap_and_keep_what_was_written() {
		let a = PoolAlloc;
		let mut live: Vec<(*mut u8, Layout, u8)> = Vec::new();
		for i in 0..20_000usize {
			let size = 1 + (i * 37) % 1200;
			let lay = layout(size, if i % 5 == 0 { 8 } else { 1 });
			// SAFETY: a valid layout; the block is written and checked within its size.
			unsafe {
				let p = a.alloc(lay);
				assert!(!p.is_null());
				let tag = (i % 251) as u8;
				std::ptr::write_bytes(p, tag, size);
				live.push((p, lay, tag));
			}
			if i % 3 == 0 {
				let (p, lay, tag) = live.swap_remove(i % live.len());
				// SAFETY: the block is live and was written with `tag`.
				unsafe {
					assert!(
						std::slice::from_raw_parts(p, lay.size())
							.iter()
							.all(|&b| b == tag)
					);
					a.dealloc(p, lay);
				}
			}
		}
		for (p, lay, tag) in live {
			// SAFETY: the block is live and was written with `tag`.
			unsafe {
				assert!(
					std::slice::from_raw_parts(p, lay.size())
						.iter()
						.all(|&b| b == tag)
				);
				a.dealloc(p, lay);
			}
		}
	}

	#[test]
	fn small_blocks_are_sixteen_byte_aligned_and_reused() {
		let a = PoolAlloc;
		// SAFETY: valid layouts and blocks released once.
		unsafe {
			let p = a.alloc(layout(40, 8));
			assert_eq!(p as usize % ALIGN, 0);
			a.dealloc(p, layout(40, 8));
			let q = a.alloc(layout(48, 8));
			assert_eq!(p, q, "the block of the class came back");
			a.dealloc(q, layout(48, 8));
		}
	}

	#[test]
	fn large_blocks_and_big_alignments_go_to_the_system() {
		let a = PoolAlloc;
		// SAFETY: valid layouts and blocks released once.
		unsafe {
			let big = a.alloc(layout(1 << 20, 8));
			assert!(!big.is_null());
			std::ptr::write_bytes(big, 7, 1 << 20);
			a.dealloc(big, layout(1 << 20, 8));
			let aligned = a.alloc(layout(64, 64));
			assert_eq!(aligned as usize % 64, 0);
			a.dealloc(aligned, layout(64, 64));
		}
	}

	#[test]
	fn realloc_keeps_the_content_when_a_block_grows_shrinks_or_changes_pool() {
		let a = PoolAlloc;
		// SAFETY: valid layouts; each pointer is the latest from `realloc`.
		unsafe {
			let mut lay = layout(10, 1);
			let mut p = a.alloc(lay);
			for i in 0..10 {
				*p.add(i) = i as u8;
			}
			// Same class: the same block.
			let same = a.realloc(p, lay, 16);
			assert_eq!(same, p);
			lay = layout(16, 1);
			// Another class, then out of the pools, then back into them.
			for new_size in [200, 5000, 100_000, 300, 12] {
				p = a.realloc(p, lay, new_size);
				lay = layout(new_size, 1);
				assert!(
					std::slice::from_raw_parts(p, 10)
						.iter()
						.enumerate()
						.all(|(i, &b)| b == i as u8)
				);
			}
			a.dealloc(p, lay);
		}
	}

	#[test]
	fn blocks_freed_on_another_thread_are_safe_to_reuse() {
		let a = &PoolAlloc;
		let blocks: Vec<usize> = (0..5000)
			.map(|i| {
				// SAFETY: a valid layout; the pointer is handed over as an integer.
				unsafe { a.alloc(layout(8 + i % 900, 8)) as usize }
			})
			.collect();
		std::thread::scope(|scope| {
			let freeing = scope.spawn(|| {
				for (i, &p) in blocks.iter().enumerate() {
					// SAFETY: each block is released once, with its layout.
					unsafe { a.dealloc(p as *mut u8, layout(8 + i % 900, 8)) };
				}
				// And then used again on this thread.
				let again: Vec<usize> = (0..5000)
					.map(|i| unsafe { a.alloc(layout(8 + i % 900, 8)) as usize })
					.collect();
				let mut seen = std::collections::HashSet::new();
				assert!(
					again.iter().all(|p| *p != 0 && seen.insert(*p)),
					"no block handed out twice"
				);
				for (i, &p) in again.iter().enumerate() {
					unsafe { a.dealloc(p as *mut u8, layout(8 + i % 900, 8)) };
				}
			});
			freeing.join().unwrap();
		});
	}
}
