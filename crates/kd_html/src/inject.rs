//! `html.inject`: static markup written into the head or body of a document.
//!
//! Only full documents take part: a fragment has no `<head>` or `<body>` to
//! write into, and guessing one would put markup in places v2 never did.
//! A document without a `<body>` skips the body positions for the same
//! reason (the parser does not invent one).
//!
//! The same markup is never written twice: if the target already contains
//! the serialized form of what would be inserted, the injection is skipped.
//! That keeps a page that already carries the tag (written by hand, or by an
//! earlier build step) from getting a second copy.

use crate::dom::NodeId;
use crate::page::Page;
use crate::rules::fragment;
use crate::serialize::{inner_html, outer_html};

/// Where in the document the markup goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InjectPosition {
	HeadStart,
	HeadEnd,
	BodyStart,
	BodyEnd,
}

/// When an injection applies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InjectMode {
	Build,
	Serve,
	Both,
}

/// What the pipeline is doing right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
	Build,
	Serve,
}

/// One injection.
///
/// # Example
///
/// ```
/// use kd_html::{inject::{apply, Inject, InjectMode, InjectPosition, Phase}, page::Page};
/// let mut page = Page::parse("<html><head><title>t</title></head><body></body></html>");
/// let injects = [Inject::new(InjectPosition::HeadEnd, InjectMode::Both, "<link rel=\"x\">")];
/// apply(&mut page, &injects, Phase::Build);
/// assert_eq!(page.serialize(), "<html><head><title>t</title><link rel=\"x\"></head><body></body></html>");
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Inject {
	pub position: InjectPosition,
	pub mode: InjectMode,
	pub html: String,
}

impl Inject {
	#[must_use]
	pub fn new(position: InjectPosition, mode: InjectMode, html: &str) -> Inject {
		Inject {
			position,
			mode,
			html: html.to_owned(),
		}
	}

	fn applies_in(&self, phase: Phase) -> bool {
		matches!(
			(self.mode, phase),
			(InjectMode::Both, _)
				| (InjectMode::Build, Phase::Build)
				| (InjectMode::Serve, Phase::Serve)
		)
	}
}

fn named_child(page: &Page, parent: NodeId, name: &str) -> Option<NodeId> {
	page.doc
		.children(parent)
		.find(|&c| page.doc.element(c).is_some_and(|e| e.name == name))
}

/// Applies the injections that belong to `phase`, in order.
pub fn apply(page: &mut Page, injects: &[Inject], phase: Phase) {
	let Some(root) = page.root else {
		return;
	};
	for inject in injects.iter().filter(|i| i.applies_in(phase)) {
		let (tag, at_start) = match inject.position {
			InjectPosition::HeadStart => ("head", true),
			InjectPosition::HeadEnd => ("head", false),
			InjectPosition::BodyStart => ("body", true),
			InjectPosition::BodyEnd => ("body", false),
		};
		let Some(target) = named_child(page, root, tag) else {
			continue;
		};
		let nodes = fragment(&mut page.doc, &inject.html);
		if nodes.is_empty() {
			continue;
		}
		let wanted: String = nodes.iter().map(|&n| outer_html(&page.doc, n)).collect();
		if inner_html(&page.doc, target).contains(&wanted) {
			continue;
		}
		if at_start {
			for n in nodes.into_iter().rev() {
				page.doc.prepend_child(target, n);
			}
		} else {
			for n in nodes {
				page.doc.append_child(target, n);
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	const DOC: &str =
		"<!doctype html><html><head><title>t</title></head><body><p>x</p></body></html>";

	fn run(html: &str, injects: &[Inject], phase: Phase) -> String {
		let mut page = Page::parse(html);
		apply(&mut page, injects, phase);
		page.serialize()
	}

	#[test]
	fn the_four_positions() {
		let cases = [
			(
				InjectPosition::HeadStart,
				"<html><head><i></i><title>t</title></head><body><p>x</p></body></html>",
			),
			(
				InjectPosition::HeadEnd,
				"<html><head><title>t</title><i></i></head><body><p>x</p></body></html>",
			),
			(
				InjectPosition::BodyStart,
				"<html><head><title>t</title></head><body><i></i><p>x</p></body></html>",
			),
			(
				InjectPosition::BodyEnd,
				"<html><head><title>t</title></head><body><p>x</p><i></i></body></html>",
			),
		];
		for (position, expected) in cases {
			let i = [Inject::new(position, InjectMode::Both, "<i></i>")];
			assert_eq!(run(DOC, &i, Phase::Build), expected, "{position:?}");
		}
	}

	#[test]
	fn several_nodes_keep_their_order_at_the_start() {
		let i = [Inject::new(
			InjectPosition::HeadStart,
			InjectMode::Both,
			"<a></a><b></b>",
		)];
		assert_eq!(
			run(DOC, &i, Phase::Build),
			"<html><head><a></a><b></b><title>t</title></head><body><p>x</p></body></html>"
		);
	}

	#[test]
	fn modes_select_the_phase() {
		let build = [Inject::new(
			InjectPosition::HeadEnd,
			InjectMode::Build,
			"<i></i>",
		)];
		let serve = [Inject::new(
			InjectPosition::HeadEnd,
			InjectMode::Serve,
			"<i></i>",
		)];
		assert!(run(DOC, &build, Phase::Build).contains("<i></i>"));
		assert!(!run(DOC, &build, Phase::Serve).contains("<i></i>"));
		assert!(run(DOC, &serve, Phase::Serve).contains("<i></i>"));
		assert!(!run(DOC, &serve, Phase::Build).contains("<i></i>"));
	}

	#[test]
	fn the_same_markup_is_not_written_twice() {
		let i = [
			Inject::new(
				InjectPosition::HeadEnd,
				InjectMode::Both,
				"<link rel=\"x\" href=\"/a.css\">",
			),
			Inject::new(
				InjectPosition::HeadEnd,
				InjectMode::Both,
				"<link rel=\"x\" href=\"/a.css\">",
			),
		];
		assert_eq!(
			run(DOC, &i, Phase::Build),
			"<html><head><title>t</title><link rel=\"x\" href=\"/a.css\"></head><body><p>x</p></body></html>"
		);
		let handwritten = "<html><head><link href=\"/a.css\" rel=\"x\"></head><body></body></html>";
		let again = [Inject::new(
			InjectPosition::HeadEnd,
			InjectMode::Both,
			"<link href=/a.css rel=x>",
		)];
		assert_eq!(run(handwritten, &again, Phase::Build), handwritten);
	}

	#[test]
	fn fragments_and_missing_targets_are_left_alone() {
		let i = [Inject::new(
			InjectPosition::HeadEnd,
			InjectMode::Both,
			"<i></i>",
		)];
		assert_eq!(run("<p>x</p>", &i, Phase::Build), "<p>x</p>");
		let body = [Inject::new(
			InjectPosition::BodyEnd,
			InjectMode::Both,
			"<i></i>",
		)];
		assert_eq!(
			run("<html><head></head></html>", &body, Phase::Build),
			"<html><head></head></html>"
		);
	}

	#[test]
	fn an_empty_injection_is_a_no_op() {
		let i = [Inject::new(InjectPosition::HeadEnd, InjectMode::Both, "")];
		assert_eq!(run(DOC, &i, Phase::Build), run(DOC, &[], Phase::Build));
	}
}
