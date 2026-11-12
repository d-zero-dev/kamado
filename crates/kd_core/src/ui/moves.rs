//! The order in which a batch of moves is made (RFC §14.2, "一括編集"): a set of moves
//! `from → to` that are meant to happen at once (`/a/` → `/b/` and `/b/` → `/c/`; `/a/` and
//! `/b/` exchanged) is put in a row of steps that can be made one after another, each into a
//! place that is free when its turn comes.
//!
//! This is the ordering of a parallel move (Leroy, "Tilting at windmills with Coq":
//! <https://xavierleroy.org/parallel-move/doc/Parmov.html>), with names for places instead of
//! registers: a move waits for the move that leaves the place it goes to; moves that wait for
//! each other in a ring cannot start, so one of them is parked in a temporary name and brought
//! to its place when the ring has opened.
//!
//! It is a pure function of the moves, so that it is tested without a file system. The caller
//! has checked that no two moves leave the same place or go to the same place, and that no move
//! goes where it already is.

/// One step of the order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Step {
	/// Makes the move `i` (an index into the moves given).
	Move(usize),
	/// Moves what the move `i` leaves to the temporary name: the place it was in is free after
	/// this, and the place it goes to is not yet taken.
	Park(usize, String),
	/// Moves what was parked (by the same `Park`) from its temporary name to where the move `i`
	/// goes.
	Retrieve(usize, String),
}

/// Puts `moves` (`(from, to)` pairs) in an order that can be made one by one. `temporary`
/// gives a name for a place that is to be parked: it is called with the place, and must give a
/// name no other place has, nor any name it gave before.
///
/// A move that waits for none goes first, in the order given (it goes where nothing is left;
/// in the chain `a→b→c` the first to go is `b→c`). When none is ready,
/// every move that is left is in a ring, and the first (in the order given) is parked: no two
/// moves leave the same place or go to the same place, so each move is waited for by at most
/// one and waits for at most one, the moves make chains and rings and nothing else, and a chain
/// always has an end that is ready.
///
/// # Example
///
/// ```text
/// let moves = vec![("/a/".to_string(), "/b/".to_string()), ("/b/".to_string(), "/a/".to_string())];
/// let steps = order(&moves, |from| format!("{from}.tmp"));
/// assert_eq!(steps, vec![
///     Step::Park(0, "/a/.tmp".to_string()),
///     Step::Move(1),
///     Step::Retrieve(0, "/a/.tmp".to_string()),
/// ]);
/// ```
pub(crate) fn order(
	moves: &[(String, String)],
	mut temporary: impl FnMut(&str) -> String,
) -> Vec<Step> {
	let n = moves.len();
	// The move that leaves the place `p` (so the one a move into `p` waits for).
	let leaving: std::collections::HashMap<&str, usize> = moves
		.iter()
		.enumerate()
		.map(|(i, (from, _))| (from.as_str(), i))
		.collect();
	// `blocker[i]`: the move that must be made before `i` can go into its place.
	let blocker: Vec<Option<usize>> = moves
		.iter()
		.map(|(_, to)| leaving.get(to.as_str()).copied())
		.collect();
	// A move is ready when the move it waits for is done, or parked (it has left its place).
	let mut done = vec![false; n];
	let mut parked: Vec<Option<String>> = vec![None; n];
	let mut steps = Vec::with_capacity(n + 2);
	let mut remaining = n;
	let mut retrievals: Vec<usize> = Vec::new();
	while remaining > 0 {
		let mut progressed = false;
		for i in 0..n {
			if done[i] || parked[i].is_some() {
				continue;
			}
			// A move into a place that is left by a move not done (and not parked: a parked one
			// has left already) is not ready.
			let ready = match blocker[i] {
				None => true,
				Some(j) => done[j] || parked[j].is_some(),
			};
			if ready {
				steps.push(Step::Move(i));
				done[i] = true;
				remaining -= 1;
				progressed = true;
			}
		}
		if !progressed {
			// Only rings are left: park the first move of one.
			let Some(i) = (0..n).find(|&i| !done[i] && parked[i].is_none()) else {
				break;
			};
			let name = temporary(&moves[i].0);
			steps.push(Step::Park(i, name.clone()));
			parked[i] = Some(name);
			retrievals.push(i);
			remaining -= 1;
		}
	}
	for i in retrievals {
		if let Some(name) = parked[i].take() {
			steps.push(Step::Retrieve(i, name));
		}
	}
	steps
}

#[cfg(test)]
mod tests {
	use super::*;

	fn moves(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
		pairs
			.iter()
			.map(|(a, b)| ((*a).to_string(), (*b).to_string()))
			.collect()
	}

	fn tmp(from: &str) -> String {
		format!("{from}.tmp")
	}

	/// Makes the steps on a set of places and returns what is at each place, failing if a step
	/// goes into a place that is taken: the check that the order is one a file system allows.
	fn run(
		pairs: &[(String, String)],
		steps: &[Step],
	) -> std::collections::BTreeMap<String, usize> {
		let mut at: std::collections::BTreeMap<String, usize> = pairs
			.iter()
			.enumerate()
			.map(|(i, (from, _))| (from.clone(), i))
			.collect();
		let mut held: std::collections::HashMap<usize, String> = std::collections::HashMap::new();
		for step in steps {
			match step {
				Step::Move(i) => {
					let item = at.remove(&pairs[*i].0).expect("the place it leaves has it");
					assert_eq!(item, *i, "the place holds what the move moves");
					assert!(
						at.insert(pairs[*i].1.clone(), item).is_none(),
						"move {i} goes into a place that is taken"
					);
				}
				Step::Park(i, name) => {
					let item = at.remove(&pairs[*i].0).expect("the place it leaves has it");
					assert_eq!(item, *i);
					assert!(
						at.insert(name.clone(), item).is_none(),
						"the name {name} is taken"
					);
					held.insert(*i, name.clone());
				}
				Step::Retrieve(i, name) => {
					assert_eq!(held.remove(i).as_deref(), Some(name.as_str()));
					let item = at.remove(name).expect("the parked item is there");
					assert!(
						at.insert(pairs[*i].1.clone(), item).is_none(),
						"retrieve {i} goes into a place that is taken"
					);
				}
			}
		}
		assert!(
			held.is_empty(),
			"everything parked was brought to its place"
		);
		at
	}

	fn lands(pairs: &[(&str, &str)]) {
		let m = moves(pairs);
		let steps = order(&m, tmp);
		let at = run(&m, &steps);
		let expected: std::collections::BTreeMap<String, usize> = m
			.iter()
			.enumerate()
			.map(|(i, (_, to))| (to.clone(), i))
			.collect();
		assert_eq!(
			at, expected,
			"every item ends where its move says: {steps:?}"
		);
	}

	#[test]
	fn no_moves_make_no_steps() {
		assert_eq!(order(&[], tmp), vec![]);
	}

	#[test]
	fn independent_moves_keep_the_order_given() {
		let m = moves(&[("/a/", "/x/"), ("/b/", "/y/")]);
		assert_eq!(order(&m, tmp), vec![Step::Move(0), Step::Move(1)]);
	}

	#[test]
	fn a_move_waits_for_the_one_that_leaves_its_place() {
		// /a/ -> /b/ goes into the place /b/ -> /c/ leaves, so it comes second.
		let m = moves(&[("/a/", "/b/"), ("/b/", "/c/")]);
		assert_eq!(order(&m, tmp), vec![Step::Move(1), Step::Move(0)]);
	}

	#[test]
	fn a_chain_is_made_from_its_end() {
		lands(&[
			("/a/", "/b/"),
			("/b/", "/c/"),
			("/c/", "/d/"),
			("/d/", "/e/"),
		]);
		let m = moves(&[("/a/", "/b/"), ("/b/", "/c/"), ("/c/", "/d/")]);
		assert_eq!(
			order(&m, tmp),
			vec![Step::Move(2), Step::Move(1), Step::Move(0)]
		);
	}

	#[test]
	fn an_exchange_parks_one_of_the_two() {
		let m = moves(&[("/a/", "/b/"), ("/b/", "/a/")]);
		assert_eq!(
			order(&m, tmp),
			vec![
				Step::Park(0, "/a/.tmp".to_string()),
				Step::Move(1),
				Step::Retrieve(0, "/a/.tmp".to_string()),
			]
		);
		lands(&[("/a/", "/b/"), ("/b/", "/a/")]);
	}

	#[test]
	fn a_ring_of_three_uses_one_temporary_name() {
		let m = moves(&[("/a/", "/b/"), ("/b/", "/c/"), ("/c/", "/a/")]);
		let steps = order(&m, tmp);
		let parks = steps.iter().filter(|s| matches!(s, Step::Park(..))).count();
		assert_eq!(parks, 1, "{steps:?}");
		lands(&[("/a/", "/b/"), ("/b/", "/c/"), ("/c/", "/a/")]);
	}

	#[test]
	fn a_ring_with_a_tail_is_made_whole() {
		let chain_and_ring = [
			("/a/", "/b/"),
			("/b/", "/a/"),
			("/x/", "/y/"),
			("/y/", "/z/"),
		];
		let steps = order(&moves(&chain_and_ring), tmp);
		let parks = steps.iter().filter(|s| matches!(s, Step::Park(..))).count();
		assert_eq!(parks, 1, "only the ring is parked: {steps:?}");
		lands(&chain_and_ring);
		lands(&[
			("/c/", "/x/"),
			("/a/", "/b/"),
			("/b/", "/a/"),
			("/x/", "/y/"),
		]);
	}

	#[test]
	fn two_rings_are_each_opened() {
		let pairs = [
			("/a/", "/b/"),
			("/b/", "/a/"),
			("/c/", "/d/"),
			("/d/", "/c/"),
		];
		let m = moves(&pairs);
		let steps = order(&m, tmp);
		let parks = steps.iter().filter(|s| matches!(s, Step::Park(..))).count();
		assert_eq!(parks, 2, "{steps:?}");
		lands(&pairs);
	}

	#[test]
	fn every_permutation_of_four_places_is_made_in_an_order_a_file_system_allows() {
		let places = ["/p/", "/q/", "/r/", "/s/"];
		let mut permutation = [0usize, 1, 2, 3];
		// Heap's algorithm would do; four places have 24, so a plain recursion is clearer.
		fn each(k: usize, p: &mut [usize; 4], f: &mut impl FnMut(&[usize; 4])) {
			if k == p.len() {
				f(p);
				return;
			}
			for i in k..p.len() {
				p.swap(k, i);
				each(k + 1, p, f);
				p.swap(k, i);
			}
		}
		let mut count = 0;
		each(0, &mut permutation, &mut |p| {
			// A place that stays where it is is not a move (the caller does not make one).
			let pairs: Vec<(&str, &str)> = (0..4)
				.filter(|&i| p[i] != i)
				.map(|i| (places[i], places[p[i]]))
				.collect();
			lands(&pairs);
			count += 1;
		});
		assert_eq!(count, 24);
	}
}
