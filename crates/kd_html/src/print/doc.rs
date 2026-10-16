//! Prettier's document IR and its printer (`printDocToString`), for the part
//! the HTML printer uses: text, concatenation, indent, groups (with ids and
//! forced breaks), fill, if-break, indent-if-break, the three kinds of line,
//! break-parent and dedent-to-root.
//!
//! Documents live in an arena and are addressed by [`DocId`]. Why an arena:
//! prettier shares sub-documents (a group is both measured and printed) and
//! mutates group nodes (`propagateBreaks` marks a group as broken); ids make
//! both natural, and a page's documents are dropped together.
//!
//! What is not here, because the HTML printer never builds it: cursor,
//! label, line-suffix, trim, and `align` other than "back to the root".
//!
//! Also not here: a page width. kamado formats as if the width were
//! unlimited (prettier's `printWidth: 100000` is what v2 used for almost every
//! page), so nothing wraps for being long: a group is broken exactly when it
//! holds a forced break (`propagateBreaks`), and everything else stays flat.
//! That is what lets the printer skip `fits` for groups and the measuring of
//! text, which was a tenth of the time of a page. A line wider than 100000
//! columns, which prettier would have wrapped, is the one output that differs.

/// An id in a [`Docs`] arena.
pub type DocId = u32;

/// A group id (`Symbol` in prettier) used by `if-break` and `indent-if-break`.
pub type GroupId = u32;

#[derive(Debug, Clone)]
enum Node {
	Text(String),
	Concat(Vec<DocId>),
	Indent(DocId),
	DedentToRoot(DocId),
	Group {
		contents: DocId,
		brk: bool,
		id: Option<GroupId>,
	},
	Fill(Vec<DocId>),
	IfBreak {
		break_contents: DocId,
		flat_contents: DocId,
		group_id: Option<GroupId>,
	},
	IndentIfBreak {
		contents: DocId,
		group_id: GroupId,
		negate: bool,
	},
	Line {
		soft: bool,
		hard: bool,
		literal: bool,
	},
	BreakParent,
}

/// The arena, and the builders.
#[derive(Debug)]
pub struct Docs {
	nodes: Vec<Node>,
	next_group: GroupId,
	/// Where the wide-character width of a text is computed (`false` for pure
	/// ASCII texts, which is the common case, is decided per text).
	_private: (),
}

/// The empty string.
pub const EMPTY: DocId = 0;
/// `line`: a space, or a newline when the group breaks.
pub const LINE: DocId = 1;
/// `softline`: nothing, or a newline when the group breaks.
pub const SOFTLINE: DocId = 2;
/// A newline that always breaks, without breaking the parent group.
pub const HARDLINE_WITHOUT_BREAK_PARENT: DocId = 3;
/// `breakParent`.
pub const BREAK_PARENT: DocId = 4;
/// `hardline`: a newline, and the enclosing groups break.
pub const HARDLINE: DocId = 5;
/// A newline that does not indent, and breaks the enclosing groups.
pub const LITERALLINE: DocId = 7;

impl Default for Docs {
	fn default() -> Self {
		Self::new()
	}
}

impl Docs {
	#[must_use]
	pub fn new() -> Docs {
		let mut d = Docs {
			nodes: Vec::with_capacity(256),
			next_group: 0,
			_private: (),
		};
		d.nodes.push(Node::Text(String::new())); // 0
		d.nodes.push(Node::Line {
			soft: false,
			hard: false,
			literal: false,
		}); // 1
		d.nodes.push(Node::Line {
			soft: true,
			hard: false,
			literal: false,
		}); // 2
		d.nodes.push(Node::Line {
			soft: false,
			hard: true,
			literal: false,
		}); // 3
		d.nodes.push(Node::BreakParent); // 4
		d.nodes.push(Node::Concat(vec![3, 4])); // 5 hardline
		d.nodes.push(Node::Line {
			soft: false,
			hard: true,
			literal: true,
		}); // 6
		d.nodes.push(Node::Concat(vec![6, 4])); // 7 literalline
		d
	}

	fn push(&mut self, node: Node) -> DocId {
		let id = self.nodes.len() as DocId;
		self.nodes.push(node);
		id
	}

	/// A text. The empty text is [`EMPTY`].
	pub fn text(&mut self, s: impl Into<String>) -> DocId {
		let s = s.into();
		if s.is_empty() {
			return EMPTY;
		}
		self.push(Node::Text(s))
	}

	pub fn concat(&mut self, parts: Vec<DocId>) -> DocId {
		self.push(Node::Concat(parts))
	}

	pub fn indent(&mut self, contents: DocId) -> DocId {
		self.push(Node::Indent(contents))
	}

	/// `dedentToRoot`: the contents are printed from column zero.
	pub fn dedent_to_root(&mut self, contents: DocId) -> DocId {
		self.push(Node::DedentToRoot(contents))
	}

	pub fn group(&mut self, contents: DocId) -> DocId {
		self.push(Node::Group {
			contents,
			brk: false,
			id: None,
		})
	}

	pub fn group_with(
		&mut self,
		contents: DocId,
		should_break: bool,
		id: Option<GroupId>,
	) -> DocId {
		self.push(Node::Group {
			contents,
			brk: should_break,
			id,
		})
	}

	/// A fresh group id.
	pub fn new_group_id(&mut self) -> GroupId {
		self.next_group += 1;
		self.next_group
	}

	pub fn fill(&mut self, parts: Vec<DocId>) -> DocId {
		self.push(Node::Fill(parts))
	}

	/// `ifBreak(break_contents, flat_contents, { groupId })`.
	pub fn if_break(
		&mut self,
		break_contents: DocId,
		flat_contents: DocId,
		group_id: Option<GroupId>,
	) -> DocId {
		self.push(Node::IfBreak {
			break_contents,
			flat_contents,
			group_id,
		})
	}

	/// `indentIfBreak(contents, { groupId, negate })`.
	pub fn indent_if_break(&mut self, contents: DocId, group_id: GroupId, negate: bool) -> DocId {
		self.push(Node::IndentIfBreak {
			contents,
			group_id,
			negate,
		})
	}

	/// `join(separator, docs)`.
	pub fn join(&mut self, separator: DocId, docs: &[DocId]) -> Vec<DocId> {
		let mut parts = Vec::with_capacity(docs.len() * 2);
		for (i, &d) in docs.iter().enumerate() {
			if i != 0 {
				parts.push(separator);
			}
			parts.push(d);
		}
		parts
	}

	/// `replaceEndOfLine(text, replacement)`: the text with each newline
	/// replaced by `replacement` (`literalline` by default).
	pub fn replace_end_of_line(&mut self, text: &str, replacement: DocId) -> DocId {
		if !text.contains('\n') {
			return self.text(text);
		}
		let pieces: Vec<DocId> = text.split('\n').map(|p| self.text(p)).collect();
		let joined = self.join(replacement, &pieces);
		self.concat(joined)
	}

	/// A copy of `doc` with `f` applied to every text (prettier's `mapDoc`
	/// used to rewrite strings). Documents are small where this is used
	/// (attribute values), so the recursion is shallow.
	pub fn map_text(&mut self, doc: DocId, f: &dyn Fn(&str) -> String) -> DocId {
		let node = self.nodes[doc as usize].clone();
		match node {
			Node::Text(s) => {
				let mapped = f(&s);
				if mapped == s { doc } else { self.text(mapped) }
			}
			Node::Concat(parts) => {
				let mapped: Vec<DocId> = parts.iter().map(|&p| self.map_text(p, f)).collect();
				self.concat(mapped)
			}
			Node::Fill(parts) => {
				let mapped: Vec<DocId> = parts.iter().map(|&p| self.map_text(p, f)).collect();
				self.fill(mapped)
			}
			Node::Indent(c) => {
				let c = self.map_text(c, f);
				self.indent(c)
			}
			Node::DedentToRoot(c) => {
				let c = self.map_text(c, f);
				self.dedent_to_root(c)
			}
			Node::Group { contents, brk, id } => {
				let contents = self.map_text(contents, f);
				self.group_with(contents, brk, id)
			}
			Node::IfBreak {
				break_contents,
				flat_contents,
				group_id,
			} => {
				let b = self.map_text(break_contents, f);
				let l = self.map_text(flat_contents, f);
				self.if_break(b, l, group_id)
			}
			Node::IndentIfBreak {
				contents,
				group_id,
				negate,
			} => {
				let c = self.map_text(contents, f);
				self.indent_if_break(c, group_id, negate)
			}
			Node::Line { .. } | Node::BreakParent => doc,
		}
	}

	/// Whether printing `doc` is certain to break the line (prettier's
	/// `willBreak`).
	#[must_use]
	pub fn will_break(&self, doc: DocId) -> bool {
		let mut stack = vec![doc];
		while let Some(d) = stack.pop() {
			match &self.nodes[d as usize] {
				Node::Group { brk: true, .. }
				| Node::BreakParent
				| Node::Line { hard: true, .. } => {
					return true;
				}
				Node::Group { contents, .. } => stack.push(*contents),
				Node::Concat(parts) | Node::Fill(parts) => stack.extend(parts.iter().copied()),
				Node::Indent(c) | Node::DedentToRoot(c) => stack.push(*c),
				Node::IfBreak {
					break_contents,
					flat_contents,
					..
				} => {
					stack.push(*break_contents);
					stack.push(*flat_contents);
				}
				Node::IndentIfBreak { contents, .. } => stack.push(*contents),
				Node::Text(_) | Node::Line { .. } => {}
			}
		}
		false
	}

	/// Marks every group that contains a forced break as broken, outward
	/// (prettier's `propagateBreaks`). A shared group is visited once.
	fn propagate_breaks(&mut self, root: DocId) {
		enum Step {
			Enter(DocId),
			Exit(DocId),
		}
		let mut visited = vec![false; self.nodes.len()];
		let mut group_stack: Vec<DocId> = Vec::new();
		let mut stack = vec![Step::Enter(root)];
		while let Some(step) = stack.pop() {
			match step {
				Step::Exit(id) => {
					if let Node::Group { brk, .. } = &self.nodes[id as usize] {
						let broken = *brk;
						group_stack.pop();
						if broken {
							self.break_parent_group(&group_stack);
						}
					}
				}
				Step::Enter(id) => {
					match &self.nodes[id as usize] {
						Node::BreakParent => self.break_parent_group(&group_stack),
						Node::Group { contents, .. } => {
							let contents = *contents;
							group_stack.push(id);
							if visited[id as usize] {
								// Already traversed: only its own "broken" state matters.
								stack.push(Step::Exit(id));
								continue;
							}
							visited[id as usize] = true;
							stack.push(Step::Exit(id));
							stack.push(Step::Enter(contents));
						}
						Node::Concat(parts) | Node::Fill(parts) => {
							for &p in parts.iter().rev() {
								stack.push(Step::Enter(p));
							}
						}
						Node::Indent(c) | Node::DedentToRoot(c) => stack.push(Step::Enter(*c)),
						Node::IfBreak {
							break_contents,
							flat_contents,
							..
						} => {
							stack.push(Step::Enter(*flat_contents));
							stack.push(Step::Enter(*break_contents));
						}
						Node::IndentIfBreak { contents, .. } => stack.push(Step::Enter(*contents)),
						Node::Text(_) | Node::Line { .. } => {}
					}
				}
			}
		}
	}

	fn break_parent_group(&mut self, group_stack: &[DocId]) {
		if let Some(&parent) = group_stack.last()
			&& let Node::Group { brk, .. } = &mut self.nodes[parent as usize]
			&& !*brk
		{
			*brk = true;
		}
	}
}

// ---------------------------------------------------------------------------
// printing

/// How the printer lays out.
#[derive(Debug, Clone, Copy)]
pub struct PrintOptions {
	pub tab_width: usize,
	pub use_tabs: bool,
	/// A text that starts with `>` or `/>` (the end of a tag that prettier let
	/// the next node borrow) follows what stands before it with no line break
	/// of its own: the line that would have been put before it is taken back.
	/// Why a text can be taken for such an end: the serializer writes a `>` of
	/// the text of a page as `&gt;`, so a text that starts with one is a tag's.
	pub glue_markers: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Mode {
	Break,
	Flat,
}

#[derive(Clone, Copy)]
struct Cmd {
	/// Indentation levels.
	indent: usize,
	mode: Mode,
	doc: DocId,
	/// For a fill: how many parts have been printed already.
	fill_offset: usize,
}

struct Printer<'a> {
	docs: &'a Docs,
	options: PrintOptions,
	group_modes: Vec<Option<Mode>>,
	out: String,
	/// The stack of [`Printer::fits_flat`], kept to reuse its allocation.
	scratch: Vec<Cmd>,
	/// Where the last line break (not a literal one) began and where its
	/// indentation ended in `out`.
	last_line: Option<(usize, usize)>,
}

impl Printer<'_> {
	fn indent_value(&self, levels: usize) -> String {
		if self.options.use_tabs {
			"\t".repeat(levels)
		} else {
			" ".repeat(levels * self.options.tab_width)
		}
	}

	fn group_mode(&self, id: GroupId) -> Option<Mode> {
		self.group_modes.get(id as usize).copied().flatten()
	}

	fn set_group_mode(&mut self, id: GroupId, mode: Mode) {
		let i = id as usize;
		if self.group_modes.len() <= i {
			self.group_modes.resize(i + 1, None);
		}
		self.group_modes[i] = Some(mode);
	}

	/// Whether the parts of a fill, `initial`, can be laid out flat: what
	/// prettier's `fits` answers with `mustBeFlat` and an unlimited width. It
	/// is false only when a group that holds a forced break comes before the
	/// first line break; running into a line break first, or the end, is true.
	///
	/// `initial` is a stack: its last element is looked at first.
	fn fits_flat(&mut self, initial: &[Cmd]) -> bool {
		// One stack for every call: a fill asks once or twice per part.
		let mut commands = std::mem::take(&mut self.scratch);
		commands.clear();
		commands.extend_from_slice(initial);
		let flat = self.scan_flat(&mut commands);
		self.scratch = commands;
		flat
	}

	fn scan_flat(&self, commands: &mut Vec<Cmd>) -> bool {
		loop {
			let Some(cmd) = commands.pop() else {
				return true;
			};
			let Cmd {
				mode,
				doc,
				fill_offset,
				..
			} = cmd;
			match &self.docs.nodes[doc as usize] {
				Node::Text(_) => {}
				Node::Concat(parts) => {
					for &p in parts.iter().rev() {
						commands.push(Cmd {
							mode,
							doc: p,
							..cmd
						});
					}
				}
				Node::Fill(parts) => {
					for index in (fill_offset..parts.len()).rev() {
						commands.push(Cmd {
							mode,
							doc: parts[index],
							fill_offset: 0,
							indent: cmd.indent,
						});
					}
				}
				Node::Indent(c) | Node::DedentToRoot(c) => {
					commands.push(Cmd {
						mode,
						doc: *c,
						fill_offset: 0,
						indent: cmd.indent,
					});
				}
				Node::IndentIfBreak { contents, .. } => {
					commands.push(Cmd {
						mode,
						doc: *contents,
						fill_offset: 0,
						indent: cmd.indent,
					});
				}
				Node::Group { contents, brk, .. } => {
					if *brk {
						return false;
					}
					commands.push(Cmd {
						mode,
						doc: *contents,
						fill_offset: 0,
						indent: cmd.indent,
					});
				}
				Node::IfBreak {
					break_contents,
					flat_contents,
					group_id,
				} => {
					let group_mode = match group_id {
						Some(id) => self.group_mode(*id).unwrap_or(Mode::Flat),
						None => mode,
					};
					let contents = if group_mode == Mode::Break {
						*break_contents
					} else {
						*flat_contents
					};
					if contents != EMPTY {
						commands.push(Cmd {
							mode,
							doc: contents,
							fill_offset: 0,
							indent: cmd.indent,
						});
					}
				}
				Node::Line { hard, .. } => {
					if mode == Mode::Break || *hard {
						return true;
					}
				}
				Node::BreakParent => {}
			}
		}
	}

	fn run(&mut self, root: DocId) {
		let mut commands: Vec<Cmd> = vec![Cmd {
			indent: 0,
			mode: Mode::Break,
			doc: root,
			fill_offset: 0,
		}];
		while let Some(cmd) = commands.pop() {
			let Cmd {
				indent,
				mode,
				doc,
				fill_offset,
			} = cmd;
			match &self.docs.nodes[doc as usize] {
				Node::Text(s) => {
					if self.options.glue_markers
						&& (s.starts_with('>') || s.starts_with("/>"))
						&& let Some((start, end)) = self.last_line
						&& self.out.len() == end
					{
						self.out.truncate(start);
						// Used once: what is written after may bring the output
						// back to the length of `end`.
						self.last_line = None;
					}
					self.out.push_str(s);
				}
				Node::Concat(parts) => {
					for &p in parts.iter().rev() {
						commands.push(Cmd {
							indent,
							mode,
							doc: p,
							fill_offset: 0,
						});
					}
				}
				Node::Indent(c) => {
					commands.push(Cmd {
						indent: indent + 1,
						mode,
						doc: *c,
						fill_offset: 0,
					});
				}
				Node::DedentToRoot(c) => {
					commands.push(Cmd {
						indent: 0,
						mode,
						doc: *c,
						fill_offset: 0,
					});
				}
				Node::Group { contents, brk, id } => {
					// With no width to run out of, a group is broken exactly when it
					// holds a forced break, whatever the mode it is met in.
					let command = Cmd {
						indent,
						mode: if *brk { Mode::Break } else { Mode::Flat },
						doc: *contents,
						fill_offset: 0,
					};
					if let Some(id) = id {
						self.set_group_mode(*id, command.mode);
					}
					commands.push(command);
				}
				Node::Fill(parts) => {
					let length = parts.len() - fill_offset;
					if length == 0 {
						continue;
					}
					let content = parts[fill_offset];
					let content_flat = Cmd {
						indent,
						mode: Mode::Flat,
						doc: content,
						fill_offset: 0,
					};
					let content_break = Cmd {
						indent,
						mode: Mode::Break,
						doc: content,
						fill_offset: 0,
					};
					let content_fits = self.fits_flat(&[content_flat]);
					if length == 1 {
						commands.push(if content_fits {
							content_flat
						} else {
							content_break
						});
						continue;
					}
					let whitespace = parts[fill_offset + 1];
					let whitespace_flat = Cmd {
						indent,
						mode: Mode::Flat,
						doc: whitespace,
						fill_offset: 0,
					};
					let whitespace_break = Cmd {
						indent,
						mode: Mode::Break,
						doc: whitespace,
						fill_offset: 0,
					};
					if length == 2 {
						if content_fits {
							commands.push(whitespace_flat);
							commands.push(content_flat);
						} else {
							commands.push(whitespace_break);
							commands.push(content_break);
						}
						continue;
					}
					let second_content = parts[fill_offset + 2];
					let remaining_command = Cmd {
						indent,
						mode,
						doc,
						fill_offset: fill_offset + 2,
					};
					let second_flat = Cmd {
						indent,
						mode: Mode::Flat,
						doc: second_content,
						fill_offset: 0,
					};
					// content, whitespace, second content, measured flat, in that order
					let pair_fits = self.fits_flat(&[second_flat, whitespace_flat, content_flat]);
					commands.push(remaining_command);
					if pair_fits {
						commands.push(whitespace_flat);
						commands.push(content_flat);
					} else if content_fits {
						commands.push(whitespace_break);
						commands.push(content_flat);
					} else {
						commands.push(whitespace_break);
						commands.push(content_break);
					}
				}
				Node::IfBreak {
					break_contents,
					flat_contents,
					group_id,
				} => {
					let group_mode = match group_id {
						Some(id) => self.group_mode(*id),
						None => Some(mode),
					};
					let contents = match group_mode {
						Some(Mode::Break) => *break_contents,
						Some(Mode::Flat) => *flat_contents,
						None => EMPTY,
					};
					if contents != EMPTY {
						commands.push(Cmd {
							indent,
							mode,
							doc: contents,
							fill_offset: 0,
						});
					}
				}
				Node::IndentIfBreak {
					contents,
					group_id,
					negate,
				} => {
					let group_mode = self.group_mode(*group_id);
					let indented = match group_mode {
						Some(Mode::Break) => !*negate,
						Some(Mode::Flat) => *negate,
						None => false,
					};
					let indent = if indented { indent + 1 } else { indent };
					// prettier pushes `breakContents` (indented) or `flatContents`
					// (the plain contents) with the *current* indent for the
					// indented case, via `indent(contents)`; the effect is the
					// same as adding a level here.
					if group_mode.is_some() {
						commands.push(Cmd {
							indent,
							mode,
							doc: *contents,
							fill_offset: 0,
						});
					}
				}
				Node::Line {
					soft,
					hard,
					literal,
				} => match mode {
					Mode::Flat if !*hard => {
						if !*soft {
							self.out.push(' ');
						}
					}
					_ => {
						if *literal {
							self.out.push('\n');
						} else {
							self.trim_trailing_whitespace();
							let start = self.out.len();
							self.out.push('\n');
							let value = self.indent_value(indent);
							self.out.push_str(&value);
							self.last_line = Some((start, self.out.len()));
						}
					}
				},
				Node::BreakParent => {}
			}
		}
	}

	fn trim_trailing_whitespace(&mut self) {
		let trimmed = self.out.trim_end_matches([' ', '\t']).len();
		self.out.truncate(trimmed);
	}
}

/// Prints `doc` with `options`.
#[must_use]
pub fn print(docs: &mut Docs, doc: DocId, options: PrintOptions) -> String {
	docs.propagate_breaks(doc);
	let mut printer = Printer {
		docs,
		options,
		group_modes: Vec::new(),
		out: String::new(),
		scratch: Vec::new(),
		last_line: None,
	};
	printer.run(doc);
	printer.out
}

#[cfg(test)]
mod tests {
	use super::*;

	fn opts(tabs: bool) -> PrintOptions {
		PrintOptions {
			tab_width: 2,
			use_tabs: tabs,
			glue_markers: false,
		}
	}

	fn t(d: &mut Docs, s: &str) -> DocId {
		d.text(s)
	}

	#[test]
	fn a_group_without_a_forced_break_stays_flat_however_long() {
		let mut d = Docs::new();
		let (a, b, c) = (t(&mut d, "a"), t(&mut d, "b"), t(&mut d, "c"));
		let inner = d.concat(vec![LINE, b]);
		let ind = d.indent(inner);
		let g = d.concat(vec![a, ind, LINE, c]);
		let g = d.group(g);
		assert_eq!(print(&mut d, g, opts(false)), "a b c");

		let long = "x".repeat(500);
		let mut d = Docs::new();
		let (a, b) = (t(&mut d, &long), t(&mut d, &long));
		let g = d.concat(vec![a, LINE, b]);
		let g = d.group(g);
		assert_eq!(print(&mut d, g, opts(false)), format!("{long} {long}"));
	}

	#[test]
	fn a_group_marked_broken_breaks_its_lines() {
		let mut d = Docs::new();
		let (a, b, c) = (t(&mut d, "a"), t(&mut d, "b"), t(&mut d, "c"));
		let inner = d.concat(vec![LINE, b]);
		let ind = d.indent(inner);
		let g = d.concat(vec![a, ind, LINE, c]);
		let g = d.group_with(g, true, None);
		assert_eq!(print(&mut d, g, opts(false)), "a\n  b\nc");
	}

	#[test]
	fn a_hardline_breaks_every_enclosing_group() {
		let mut d = Docs::new();
		let (a, b, c) = (t(&mut d, "a"), t(&mut d, "b"), t(&mut d, "c"));
		let g = d.concat(vec![a, LINE, b, HARDLINE, c]);
		let g = d.group(g);
		assert_eq!(print(&mut d, g, opts(false)), "a\nb\nc");
	}

	#[test]
	fn indentation_uses_tabs_when_asked() {
		let mut d = Docs::new();
		let (a, b, c) = (t(&mut d, "a"), t(&mut d, "b"), t(&mut d, "c"));
		let inner = d.concat(vec![HARDLINE, c]);
		let inner = d.indent(inner);
		let mid = d.concat(vec![HARDLINE, b, inner]);
		let mid = d.indent(mid);
		let g = d.concat(vec![a, mid]);
		let g = d.group(g);
		assert_eq!(print(&mut d, g, opts(true)), "a\n\tb\n\t\tc");
	}

	#[test]
	fn fill_keeps_words_on_one_line() {
		let mut d = Docs::new();
		let words: Vec<DocId> = ["one", "two", "three", "four", "five", "six"]
			.iter()
			.map(|w| d.text(*w))
			.collect();
		let parts = d.join(LINE, &words);
		let f = d.fill(parts);
		assert_eq!(print(&mut d, f, opts(false)), "one two three four five six");
	}

	#[test]
	fn fill_breaks_before_a_part_that_holds_a_forced_break() {
		let mut d = Docs::new();
		let (a, b, c) = (t(&mut d, "a"), t(&mut d, "b"), t(&mut d, "c"));
		let inner = d.concat(vec![b, HARDLINE, c]);
		let broken = d.group(inner);
		let parts = d.join(LINE, &[a, broken, a]);
		let f = d.fill(parts);
		assert_eq!(print(&mut d, f, opts(false)), "a\nb\nc\na");
	}

	#[test]
	fn softline_is_nothing_when_flat_and_a_newline_when_broken() {
		let mut d = Docs::new();
		let open = t(&mut d, "(");
		let x = t(&mut d, "xxxx");
		let close = t(&mut d, ")");
		let inner = d.concat(vec![SOFTLINE, x, SOFTLINE]);
		let inner = d.indent(inner);
		let g = d.concat(vec![open, inner, close]);
		let g = d.group_with(g, true, None);
		assert_eq!(print(&mut d, g, opts(false)), "(\n  xxxx\n  )");
		let mut d = Docs::new();
		let open = t(&mut d, "(");
		let x = t(&mut d, "xxxx");
		let close = t(&mut d, ")");
		let inner = d.concat(vec![SOFTLINE, x, SOFTLINE]);
		let inner = d.indent(inner);
		let g = d.concat(vec![open, inner, close]);
		let g = d.group(g);
		assert_eq!(print(&mut d, g, opts(false)), "(xxxx)");
	}

	#[test]
	fn if_break_follows_the_group_it_names() {
		let mut d = Docs::new();
		let id = d.new_group_id();
		let (a, b) = (t(&mut d, "a"), t(&mut d, "b"));
		let inner = d.concat(vec![a, LINE, b]);
		let g = d.group_with(inner, true, Some(id));
		let (brk, flat) = (t(&mut d, "BRK"), t(&mut d, "FLT"));
		let ib = d.if_break(brk, flat, Some(id));
		let all = d.concat(vec![g, ib]);
		assert_eq!(print(&mut d, all, opts(false)), "a\nbBRK");
	}

	#[test]
	fn indent_if_break_indents_only_when_its_group_broke() {
		let mut d = Docs::new();
		let id = d.new_group_id();
		let (x, y, z) = (t(&mut d, "x"), t(&mut d, "y"), t(&mut d, "z"));
		let inner = d.concat(vec![x, LINE, y]);
		let g = d.group_with(inner, false, Some(id));
		let body = d.concat(vec![HARDLINE, z]);
		let iib = d.indent_if_break(body, id, false);
		let all = d.concat(vec![g, iib]);
		assert_eq!(print(&mut d, all, opts(false)), "x y\nz");

		let mut d = Docs::new();
		let id = d.new_group_id();
		let (x, y, z) = (t(&mut d, "x"), t(&mut d, "y"), t(&mut d, "z"));
		let inner = d.concat(vec![x, LINE, y]);
		let g = d.group_with(inner, true, Some(id));
		let body = d.concat(vec![HARDLINE, z]);
		let iib = d.indent_if_break(body, id, false);
		let all = d.concat(vec![g, iib]);
		assert_eq!(print(&mut d, all, opts(false)), "x\ny\n  z");
	}

	#[test]
	fn trailing_whitespace_before_a_newline_is_removed() {
		let mut d = Docs::new();
		let (a, sp, b) = (t(&mut d, "a"), t(&mut d, " "), t(&mut d, "b"));
		let all = d.concat(vec![a, sp, HARDLINE, b]);
		assert_eq!(print(&mut d, all, opts(false)), "a\nb");
	}

	#[test]
	fn a_literalline_does_not_indent() {
		let mut d = Docs::new();
		let (a, b) = (t(&mut d, "a"), t(&mut d, "b"));
		let inner = d.concat(vec![LITERALLINE, b]);
		let inner = d.indent(inner);
		let g = d.concat(vec![a, inner]);
		let g = d.group(g);
		assert_eq!(print(&mut d, g, opts(false)), "a\nb");
	}

	#[test]
	fn wide_characters_do_not_make_a_group_break() {
		let mut d = Docs::new();
		let (jp, ab) = (t(&mut d, "日本語"), t(&mut d, "ab"));
		let g = d.concat(vec![jp, LINE, ab]);
		let g = d.group(g);
		assert_eq!(print(&mut d, g, opts(false)), "日本語 ab");
	}

	#[test]
	fn dedent_to_root_prints_from_column_zero() {
		let mut d = Docs::new();
		let (a, b) = (t(&mut d, "a"), t(&mut d, "b"));
		let inner = d.concat(vec![HARDLINE, b]);
		let ded = d.dedent_to_root(inner);
		let ind = d.indent(ded);
		let all = d.concat(vec![a, ind]);
		assert_eq!(print(&mut d, all, opts(false)), "a\nb");
	}
}
