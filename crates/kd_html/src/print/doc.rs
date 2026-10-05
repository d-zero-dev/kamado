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
	pub print_width: usize,
	pub tab_width: usize,
	pub use_tabs: bool,
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

fn is_wide(c: char) -> bool {
	let cp = c as u32;
	matches!(cp,
		0x1100..=0x115F | 0x231A..=0x231B | 0x2329..=0x232A | 0x23E9..=0x23EC | 0x23F0 | 0x23F3
		| 0x25FD..=0x25FE | 0x2614..=0x2615 | 0x2648..=0x2653 | 0x267F | 0x2693 | 0x26A1
		| 0x26AA..=0x26AB | 0x26BD..=0x26BE | 0x26C4..=0x26C5 | 0x26CE | 0x26D4 | 0x26EA
		| 0x26F2..=0x26F3 | 0x26F5 | 0x26FA | 0x26FD | 0x2705 | 0x270A..=0x270B | 0x2728
		| 0x274C | 0x274E | 0x2753..=0x2755 | 0x2757 | 0x2795..=0x2797 | 0x27B0 | 0x27BF
		| 0x2B1B..=0x2B1C | 0x2B50 | 0x2B55 | 0x2E80..=0x303E | 0x3041..=0x33FF
		| 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xA000..=0xA4CF | 0xA960..=0xA97F
		| 0xAC00..=0xD7A3 | 0xF900..=0xFAFF | 0xFE10..=0xFE19 | 0xFE30..=0xFE6F
		| 0xFF00..=0xFF60 | 0xFFE0..=0xFFE6 | 0x1F300..=0x1F64F | 0x1F900..=0x1F9FF
		| 0x20000..=0x3FFFD
	)
}

/// The display width of `text` in columns (CJK and emoji count as two, marks
/// and control characters as zero). An approximation of prettier's
/// `getStringWidth`, exact for ASCII and for the common wide ranges.
fn string_width(text: &str) -> usize {
	if text.is_ascii() {
		return text.len();
	}
	let mut width = 0;
	for c in text.chars() {
		let cp = c as u32;
		if cp <= 31 || (127..=159).contains(&cp) {
			continue;
		}
		if (768..=879).contains(&cp) || (65024..=65039).contains(&cp) {
			continue;
		}
		width += if is_wide(c) { 2 } else { 1 };
	}
	width
}

struct Printer<'a> {
	docs: &'a Docs,
	options: PrintOptions,
	group_modes: Vec<Option<Mode>>,
	out: String,
	position: usize,
	should_remeasure: bool,
}

impl Printer<'_> {
	fn indent_value(&self, levels: usize) -> (String, usize) {
		if self.options.use_tabs {
			("\t".repeat(levels), levels * self.options.tab_width)
		} else {
			let n = levels * self.options.tab_width;
			(" ".repeat(n), n)
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

	/// Whether `next` (and what follows it, from `rest`) fits in `remaining`
	/// columns up to the first possible line break.
	///
	/// `initial` is a stack: its last element is looked at first.
	fn fits(
		&self,
		initial: &[Cmd],
		rest: &[Cmd],
		mut remaining: isize,
		must_be_flat: bool,
	) -> bool {
		let mut rest_index = rest.len();
		let mut has_pending_space = false;
		let mut commands: Vec<Cmd> = initial.to_vec();
		while remaining >= 0 {
			let Some(cmd) = commands.pop().or_else(|| {
				if rest_index == 0 {
					None
				} else {
					rest_index -= 1;
					Some(rest[rest_index])
				}
			}) else {
				return true;
			};
			let Cmd {
				mode,
				doc,
				fill_offset,
				..
			} = cmd;
			match &self.docs.nodes[doc as usize] {
				Node::Text(s) => {
					if !s.is_empty() {
						if has_pending_space {
							remaining -= 1;
							has_pending_space = false;
						}
						remaining -= string_width(s) as isize;
					}
				}
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
					if must_be_flat && *brk {
						return false;
					}
					let group_mode = if *brk { Mode::Break } else { mode };
					commands.push(Cmd {
						mode: group_mode,
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
				Node::Line { soft, hard, .. } => {
					if mode == Mode::Break || *hard {
						return true;
					}
					if !*soft {
						has_pending_space = true;
					}
				}
				Node::BreakParent => {}
			}
		}
		false
	}

	fn run(&mut self, root: DocId) {
		let width = self.options.print_width as isize;
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
					if !s.is_empty() {
						self.out.push_str(s);
						if !commands.is_empty() {
							self.position += string_width(s);
						}
					}
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
					let command = if mode == Mode::Flat && !self.should_remeasure {
						Cmd {
							indent,
							mode: if *brk { Mode::Break } else { Mode::Flat },
							doc: *contents,
							fill_offset: 0,
						}
					} else {
						self.should_remeasure = false;
						let remaining = width - self.position as isize;
						let flat = Cmd {
							indent,
							mode: Mode::Flat,
							doc: *contents,
							fill_offset: 0,
						};
						if !*brk && self.fits(&[flat], &commands, remaining, false) {
							flat
						} else {
							Cmd {
								indent,
								mode: Mode::Break,
								doc: *contents,
								fill_offset: 0,
							}
						}
					};
					if let Some(id) = id {
						self.set_group_mode(*id, command.mode);
					}
					commands.push(command);
				}
				Node::Fill(parts) => {
					let remaining = width - self.position as isize;
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
					let content_fits = self.fits(&[content_flat], &[], remaining, true);
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
					let pair_fits = self.fits(
						&[second_flat, whitespace_flat, content_flat],
						&[],
						remaining,
						true,
					);
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
							self.position += 1;
						}
					}
					_ => {
						if mode == Mode::Flat {
							self.should_remeasure = true;
						}
						if *literal {
							self.out.push('\n');
							self.position = 0;
						} else {
							self.trim_trailing_whitespace();
							self.out.push('\n');
							let (value, length) = self.indent_value(indent);
							self.out.push_str(&value);
							self.position = length;
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
		position: 0,
		should_remeasure: false,
	};
	printer.run(doc);
	printer.out
}

#[cfg(test)]
mod tests {
	use super::*;

	fn opts(width: usize, tabs: bool) -> PrintOptions {
		PrintOptions {
			print_width: width,
			tab_width: 2,
			use_tabs: tabs,
		}
	}

	fn t(d: &mut Docs, s: &str) -> DocId {
		d.text(s)
	}

	#[test]
	fn a_group_that_fits_stays_flat_and_one_that_does_not_breaks() {
		let mut d = Docs::new();
		let (a, b, c) = (t(&mut d, "a"), t(&mut d, "b"), t(&mut d, "c"));
		let inner = d.concat(vec![LINE, b]);
		let ind = d.indent(inner);
		let g = d.concat(vec![a, ind, LINE, c]);
		let g = d.group(g);
		assert_eq!(print(&mut d, g, opts(80, false)), "a b c");

		let mut d = Docs::new();
		let (a, b, c) = (t(&mut d, "aaaa"), t(&mut d, "bbbb"), t(&mut d, "cccc"));
		let inner = d.concat(vec![LINE, b]);
		let ind = d.indent(inner);
		let g = d.concat(vec![a, ind, LINE, c]);
		let g = d.group(g);
		assert_eq!(print(&mut d, g, opts(8, false)), "aaaa\n  bbbb\ncccc");
	}

	#[test]
	fn a_hardline_breaks_every_enclosing_group() {
		let mut d = Docs::new();
		let (a, b, c) = (t(&mut d, "a"), t(&mut d, "b"), t(&mut d, "c"));
		let g = d.concat(vec![a, LINE, b, HARDLINE, c]);
		let g = d.group(g);
		assert_eq!(print(&mut d, g, opts(80, false)), "a\nb\nc");
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
		assert_eq!(print(&mut d, g, opts(80, true)), "a\n\tb\n\t\tc");
	}

	#[test]
	fn fill_packs_words_into_lines() {
		let mut d = Docs::new();
		let words: Vec<DocId> = ["one", "two", "three", "four", "five", "six"]
			.iter()
			.map(|w| d.text(*w))
			.collect();
		let parts = d.join(LINE, &words);
		let f = d.fill(parts);
		assert_eq!(
			print(&mut d, f, opts(12, false)),
			"one two\nthree four\nfive six"
		);
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
		let g = d.group(g);
		assert_eq!(print(&mut d, g, opts(4, false)), "(\n  xxxx\n  )");
		let mut d = Docs::new();
		let open = t(&mut d, "(");
		let x = t(&mut d, "xxxx");
		let close = t(&mut d, ")");
		let inner = d.concat(vec![SOFTLINE, x, SOFTLINE]);
		let inner = d.indent(inner);
		let g = d.concat(vec![open, inner, close]);
		let g = d.group(g);
		assert_eq!(print(&mut d, g, opts(80, false)), "(xxxx)");
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
		assert_eq!(print(&mut d, all, opts(80, false)), "a\nbBRK");
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
		assert_eq!(print(&mut d, all, opts(3, false)), "x y\nz");

		let mut d = Docs::new();
		let id = d.new_group_id();
		let (x, y, z) = (t(&mut d, "xxxx"), t(&mut d, "yyyy"), t(&mut d, "z"));
		let inner = d.concat(vec![x, LINE, y]);
		let g = d.group_with(inner, false, Some(id));
		let body = d.concat(vec![HARDLINE, z]);
		let iib = d.indent_if_break(body, id, false);
		let all = d.concat(vec![g, iib]);
		assert_eq!(print(&mut d, all, opts(5, false)), "xxxx\nyyyy\n  z");
	}

	#[test]
	fn trailing_whitespace_before_a_newline_is_removed() {
		let mut d = Docs::new();
		let (a, sp, b) = (t(&mut d, "a"), t(&mut d, " "), t(&mut d, "b"));
		let all = d.concat(vec![a, sp, HARDLINE, b]);
		assert_eq!(print(&mut d, all, opts(80, false)), "a\nb");
	}

	#[test]
	fn a_literalline_does_not_indent() {
		let mut d = Docs::new();
		let (a, b) = (t(&mut d, "a"), t(&mut d, "b"));
		let inner = d.concat(vec![LITERALLINE, b]);
		let inner = d.indent(inner);
		let g = d.concat(vec![a, inner]);
		let g = d.group(g);
		assert_eq!(print(&mut d, g, opts(80, false)), "a\nb");
	}

	#[test]
	fn wide_characters_count_two_columns() {
		let mut d = Docs::new();
		let (jp, ab) = (t(&mut d, "日本語"), t(&mut d, "ab"));
		let g = d.concat(vec![jp, LINE, ab]);
		let g = d.group(g);
		assert_eq!(print(&mut d, g, opts(6, false)), "日本語\nab");
		let mut d = Docs::new();
		let (jp, ab) = (t(&mut d, "日本語"), t(&mut d, "ab"));
		let g = d.concat(vec![jp, LINE, ab]);
		let g = d.group(g);
		assert_eq!(print(&mut d, g, opts(9, false)), "日本語 ab");
	}

	#[test]
	fn dedent_to_root_prints_from_column_zero() {
		let mut d = Docs::new();
		let (a, b) = (t(&mut d, "a"), t(&mut d, "b"));
		let inner = d.concat(vec![HARDLINE, b]);
		let ded = d.dedent_to_root(inner);
		let ind = d.indent(ded);
		let all = d.concat(vec![a, ind]);
		assert_eq!(print(&mut d, all, opts(80, false)), "a\nb");
	}
}
