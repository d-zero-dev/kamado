//! Prettier's `print-preprocess` for HTML: the ten rewriting steps that turn
//! the parsed tree into the one the printer reads (whitespace extracted into
//! flags, display values, space sensitivity), in prettier's order.

use super::angular::Span;
use super::ast::{Ast, Display, Kind, Node, NodeId, Retain};
use super::util;

/// What the HTML whitespace sensitivity option decides.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WhitespaceSensitivity {
	Css,
	Strict,
	Ignore,
}

/// Post-order walk over every node reachable from the root (children before
/// the node itself), like prettier's `ast.walk`. The visitor may change the
/// children of the node it is given and of those children (the conditional comment step
/// takes the end comment out of the element it merged), through the methods of
/// [`Ast`] that do it. A debug build checks, after each visit, that the children
/// of the visited node and of each of its children agree with their places and parent.
fn walk(ast: &mut Ast, mut visit: impl FnMut(&mut Ast, NodeId)) {
	// Collect post-order first: the visitors only edit the visited node's own
	// children list, so the ids collected stay valid (removed ones are skipped
	// by the visitors that remove them: they run after their children).
	let mut order = Vec::with_capacity(ast.node_count());
	let mut stack: Vec<(NodeId, bool)> = vec![(ast.root, false)];
	while let Some((id, expanded)) = stack.pop() {
		if expanded {
			order.push(id);
		} else {
			stack.push((id, true));
			for &c in ast.node(id).children().iter().rev() {
				stack.push((c, false));
			}
		}
	}
	for id in order {
		visit(ast, id);
		debug_assert!(
			ast.children_agree(id)
				&& ast
					.node(id)
					.children()
					.iter()
					.all(|&c| ast.children_agree(c)),
			"stale places under node {id}"
		);
	}
}

fn has_children(node: &Node) -> bool {
	matches!(
		node.kind,
		Kind::Root | Kind::Element | Kind::IeConditionalComment
	)
}

/// `isScriptLikeTag`
#[must_use]
pub fn is_script_like(node: &Node) -> bool {
	node.kind == Kind::Element
		&& matches!(
			node.full_name().as_str(),
			"script" | "style" | "svg:style" | "svg:script"
		) || (node.kind == Kind::Element
		&& node.is_unknown_namespace()
		&& matches!(node.name.as_str(), "script" | "style"))
}

/// The CSS `white-space` value prettier assumes for an element.
#[must_use]
pub fn white_space(node: &Node) -> &'static str {
	if node.kind == Kind::Element && (node.namespace.is_none() || node.is_unknown_namespace()) {
		match node.name.as_str() {
			"listing" | "plaintext" | "pre" | "xmp" => return "pre",
			"nobr" => return "nowrap",
			"table" => return "initial",
			"textarea" => return "pre-wrap",
			_ => {}
		}
	}
	"normal"
}

/// `isPreLikeNode`
#[must_use]
pub fn is_pre_like(node: &Node) -> bool {
	white_space(node).starts_with("pre")
}

fn display_of_name(name: &str) -> Option<Display> {
	Some(match name {
		"area" | "base" | "basefont" | "datalist" | "head" | "link" | "meta" | "noembed"
		| "noframes" | "rp" | "style" | "title" => Display::None,
		"param" | "script" | "html" | "body" | "address" | "blockquote" | "center" | "dialog"
		| "div" | "figure" | "figcaption" | "footer" | "form" | "header" | "hr" | "legend"
		| "listing" | "main" | "p" | "plaintext" | "pre" | "search" | "xmp" | "article"
		| "aside" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "hgroup" | "nav" | "section"
		| "dir" | "dd" | "dl" | "dt" | "menu" | "ol" | "ul" | "fieldset" | "details"
		| "summary" | "option" | "optgroup" | "source" | "track" => Display::Block,
		"template" => Display::Inline,
		"slot" => Display::Contents,
		"ruby" => Display::Ruby,
		"rt" => Display::RubyText,
		"li" => Display::ListItem,
		"table" => Display::Table,
		"caption" => Display::TableCaption,
		"colgroup" => Display::TableColumnGroup,
		"col" => Display::TableColumn,
		"thead" => Display::TableHeaderGroup,
		"tbody" => Display::TableRowGroup,
		"tfoot" => Display::TableFooterGroup,
		"tr" => Display::TableRow,
		"td" | "th" => Display::TableCell,
		"input" | "button" | "marquee" | "select" | "meter" | "progress" | "object" | "video"
		| "audio" => Display::InlineBlock,
		_ => return None,
	})
}

fn display_from_comment_word(word: &str) -> Display {
	match word {
		"block" => Display::Block,
		"inline" => Display::Inline,
		"inline-block" => Display::InlineBlock,
		"list-item" => Display::ListItem,
		"none" => Display::None,
		"contents" => Display::Contents,
		"ruby" => Display::Ruby,
		"ruby-text" => Display::RubyText,
		"table" => Display::Table,
		"table-caption" => Display::TableCaption,
		"table-column-group" => Display::TableColumnGroup,
		"table-column" => Display::TableColumn,
		"table-header-group" => Display::TableHeaderGroup,
		"table-row-group" => Display::TableRowGroup,
		"table-footer-group" => Display::TableFooterGroup,
		"table-row" => Display::TableRow,
		"table-cell" => Display::TableCell,
		_ => Display::Other,
	}
}

/// `display: <word>` in a comment right before the node.
fn display_directive(value: &str) -> Option<&str> {
	let rest = value
		.trim_start_matches(util::is_js_space)
		.strip_prefix("display:")?;
	let rest = rest.trim_start_matches(util::is_js_space);
	let end = rest
		.find(|c: char| !c.is_ascii_lowercase())
		.unwrap_or(rest.len());
	let (word, tail) = rest.split_at(end);
	if word.is_empty() || !tail.trim_matches(util::is_js_space).is_empty() {
		return None;
	}
	Some(word)
}

fn css_display(ast: &Ast, id: NodeId, sensitivity: WhitespaceSensitivity) -> Display {
	if let Some(prev) = ast.prev(id)
		&& ast.node(prev).kind == Kind::Comment
		&& let Some(word) = display_directive(&ast.node(prev).value)
	{
		return display_from_comment_word(word);
	}
	let node = ast.node(id);
	let mut in_foreign_object = false;
	if node.kind == Kind::Element && node.namespace.as_deref() == Some("svg") {
		let mut cursor = Some(id);
		while let Some(c) = cursor {
			if ast.node(c).full_name() == "svg:foreignObject" {
				in_foreign_object = true;
				break;
			}
			cursor = ast.node(c).parent();
		}
		if !in_foreign_object {
			return if node.name == "svg" {
				Display::InlineBlock
			} else {
				Display::Block
			};
		}
	}
	match sensitivity {
		WhitespaceSensitivity::Strict => Display::Inline,
		WhitespaceSensitivity::Ignore => Display::Block,
		WhitespaceSensitivity::Css => {
			if node.kind == Kind::Element
				&& (node.namespace.is_none() || in_foreign_object || node.is_unknown_namespace())
				&& let Some(d) = display_of_name(&node.name)
			{
				d
			} else {
				Display::Inline
			}
		}
	}
}

fn is_block_like(d: Display) -> bool {
	matches!(
		d,
		Display::Block
			| Display::ListItem
			| Display::Table
			| Display::TableCaption
			| Display::TableColumnGroup
			| Display::TableColumn
			| Display::TableHeaderGroup
			| Display::TableRowGroup
			| Display::TableFooterGroup
			| Display::TableRow
			| Display::TableCell
	)
}

/// First child / last child / dangling spaces are sensitive unless the
/// parent's display is block-like or inline-block.
fn is_inline_container_display(d: Display) -> bool {
	!is_block_like(d) && d != Display::InlineBlock
}

fn is_leading_space_sensitive(ast: &Ast, id: NodeId) -> bool {
	let node = ast.node(id);
	let r = {
		let prev = ast.prev(id);
		if node.kind == Kind::Text
			&& let Some(p) = prev
			&& ast.node(p).kind == Kind::Text
		{
			true
		} else if let Some(parent) = node.parent() {
			let parent_node = ast.node(parent);
			if parent_node.css_display == Display::None {
				false
			} else if is_pre_like(parent_node) {
				true
			} else {
				!((prev.is_none()
					&& (parent_node.kind == Kind::Root
						|| is_pre_like(node)
						|| is_script_like(parent_node)
						|| !is_inline_container_display(parent_node.css_display)))
					|| prev.is_some_and(|p| is_block_like(ast.node(p).css_display)))
			}
		} else {
			false
		}
	};
	if r && ast.prev(id).is_none()
		&& node
			.parent()
			.is_some_and(|p| ast.node(p).tag_def.ignore_first_lf)
	{
		return false;
	}
	r
}

fn is_trailing_space_sensitive(ast: &Ast, id: NodeId) -> bool {
	let node = ast.node(id);
	let next = ast.next(id);
	if node.kind == Kind::Text
		&& let Some(n) = next
		&& ast.node(n).kind == Kind::Text
	{
		return true;
	}
	let Some(parent) = node.parent() else {
		return false;
	};
	let parent_node = ast.node(parent);
	if parent_node.css_display == Display::None {
		return false;
	}
	if is_pre_like(parent_node) {
		return true;
	}
	!((next.is_none()
		&& (parent_node.kind == Kind::Root
			|| is_pre_like(node)
			|| is_script_like(parent_node)
			|| !is_inline_container_display(parent_node.css_display)))
		|| next.is_some_and(|n| is_block_like(ast.node(n).css_display)))
}

fn is_dangling_space_sensitive(node: &Node) -> bool {
	is_inline_container_display(node.css_display) && !is_script_like(node)
}

// ----- the steps -----

fn remove_ignorable_first_lf(ast: &mut Ast) {
	walk(ast, |ast, id| {
		let node = ast.node(id);
		if node.kind != Kind::Element || !node.tag_def.ignore_first_lf {
			return;
		}
		let Some(&first) = node.children().first() else {
			return;
		};
		if ast.node(first).kind == Kind::Text && ast.node(first).value.starts_with('\n') {
			if ast.node(first).value.len() == 1 {
				ast.remove_first_child(id);
			} else {
				ast.node_mut(first).value.remove(0);
			}
		}
	});
}

fn merge_if_conditional_start_end_comment_into_element_opening_tag(ast: &mut Ast) {
	walk(ast, |ast, id| {
		if !has_children(ast.node(id)) {
			return;
		}
		// The elements that took the place of a start comment: the end comment that opened each
		// of them goes after the pass over the list, which cannot reach into their lists.
		let mut merged = Vec::new();
		ast.retain_children(id, |nodes, child, prev, _| {
			let first = nodes[child].children().first().copied();
			let matches = nodes[child].kind == Kind::Element
				&& prev.is_some_and(|p| {
					nodes[p].kind == Kind::IeConditionalStartComment
						&& nodes[p].span.end == nodes[child].start_span.start
				}) && first.is_some_and(|f| {
				nodes[f].kind == Kind::IeConditionalEndComment
					&& nodes[f].span.start == nodes[child].start_span.end
			});
			let (Some(prev), Some(first), true) = (prev, first, matches) else {
				return Retain::Keep;
			};
			let opening = Span {
				start: nodes[prev].span.start,
				end: nodes[first].span.end,
			};
			let whole = Span {
				start: opening.start,
				end: nodes[child].span.end,
			};
			let condition = nodes[prev].condition.clone();
			let n = &mut nodes[child];
			n.condition = condition;
			n.span = whole;
			n.start_span = opening;
			merged.push(child);
			// The start comment before the child goes away: the child takes its place.
			Retain::InPlaceOfPrev
		});
		for child in merged {
			ast.remove_first_child(child);
		}
	});
}

fn merge_cdata_into_text(ast: &mut Ast) {
	merge_text(
		ast,
		|n| n.kind == Kind::Cdata,
		|n| format!("<![CDATA[{}]]>", n.value),
	);
}

/// Prettier's `mergeNodeIntoText`: turns the nodes `matches` selects into
/// text, and merges every text node into the text before it.
fn merge_text(ast: &mut Ast, matches: impl Fn(&Node) -> bool, value_of: impl Fn(&Node) -> String) {
	walk(ast, |ast, id| {
		if !has_children(ast.node(id)) {
			return;
		}
		ast.retain_children(id, |nodes, child, prev, _| {
			if nodes[child].kind != Kind::Text && !matches(&nodes[child]) {
				return Retain::Keep;
			}
			if nodes[child].kind != Kind::Text {
				let value = value_of(&nodes[child]);
				let n = &mut nodes[child];
				n.kind = Kind::Text;
				n.value = value;
			}
			match prev {
				Some(p) if nodes[p].kind == Kind::Text => {
					let (value, end) = (nodes[child].value.clone(), nodes[child].span.end);
					let a = &mut nodes[p];
					a.value.push_str(&value);
					a.span.end = end;
					Retain::Drop
				}
				_ => Retain::Keep,
			}
		});
	});
}

fn extract_whitespaces(ast: &mut Ast) {
	walk(ast, |ast, id| {
		if !has_children(ast.node(id)) {
			return;
		}
		let children = ast.node(id).children();
		if children.is_empty()
			|| (children.len() == 1
				&& ast.node(children[0]).kind == Kind::Text
				&& util::trim(&ast.node(children[0]).value).is_empty())
		{
			// A node whose only child is white space keeps no child, only the flag. It returns
			// before `is_whitespace_sensitive` and `is_indentation_sensitive` are set, so that
			// they stay false for it, `<pre> </pre>` included: the printer reads them as they
			// stand.
			ast.node_mut(id).has_dangling_spaces = !children.is_empty();
			ast.clear_children(id);
			return;
		}
		let node = ast.node(id);
		let whitespace_sensitive = is_script_like(node)
			|| node.kind == Kind::Text /* never */ && false
			|| is_pre_like(node);
		let indentation_sensitive = is_pre_like(node);
		if !whitespace_sensitive {
			// A text of white space only is left out of the list, which is not `Vec::remove` (a
			// move of everything behind it, for each one) because a parent can have thousands of
			// children with a line break between each two.
			ast.retain_children(id, |nodes, o, prev, next| {
				if nodes[o].kind != Kind::Text {
					return Retain::Keep;
				}
				// Only the lengths of the white space at both ends are kept, so that the text is
				// cut in place and not copied into new strings.
				let value = &nodes[o].value;
				let leading = util::leading_ws(value).len();
				let rest = &value[leading..];
				let trailing = util::trailing_ws(rest).len();
				let text_is_empty = rest.len() == trailing;
				if text_is_empty {
					if leading != 0 || trailing != 0 {
						if let Some(p) = prev {
							nodes[p].has_trailing_spaces = true;
						}
						if let Some(n) = next {
							nodes[n].has_leading_spaces = true;
						}
					}
					return Retain::Drop;
				}
				{
					let n = &mut nodes[o];
					let end = n.value.len() - trailing;
					n.value.truncate(end);
					if leading != 0 {
						n.value.drain(..leading);
					}
					n.span = Span {
						start: n.span.start + leading,
						end: n.span.end - trailing,
					};
				}
				if leading != 0 {
					if let Some(p) = prev {
						nodes[p].has_trailing_spaces = true;
					}
					nodes[o].has_leading_spaces = true;
				}
				if trailing != 0 {
					nodes[o].has_trailing_spaces = true;
					if let Some(n) = next {
						nodes[n].has_leading_spaces = true;
					}
				}
				Retain::Keep
			});
		}
		let n = ast.node_mut(id);
		n.is_whitespace_sensitive = whitespace_sensitive;
		n.is_indentation_sensitive = indentation_sensitive;
	});
}

fn add_css_display(ast: &mut Ast, sensitivity: WhitespaceSensitivity) {
	walk(ast, |ast, id| {
		let d = css_display(ast, id, sensitivity);
		ast.node_mut(id).css_display = d;
	});
}

fn add_is_self_closing(ast: &mut Ast) {
	walk(ast, |ast, id| {
		let n = ast.node(id);
		let value = !has_children(n)
			|| (n.kind == Kind::Element
				&& (n.tag_def.is_void || n.end_span.is_some_and(|e| e == n.start_span)));
		ast.node_mut(id).is_self_closing = value;
	});
}

fn add_has_htm_component_closing_tag(ast: &mut Ast) {
	walk(ast, |ast, id| {
		if ast.node(id).kind != Kind::Element {
			return;
		}
		let value = ast.node(id).end_span.is_some_and(|e| {
			let text = ast.slice(e);
			is_htm_closing(text)
		});
		ast.node_mut(id).has_htm_component_closing_tag = value;
	});
}

/// `/^<\s*\/\s*\/\s*>$/`
fn is_htm_closing(text: &str) -> bool {
	let rest = text.strip_prefix('<');
	let Some(rest) = rest else { return false };
	let rest = rest.trim_start_matches(util::is_js_space);
	let Some(rest) = rest.strip_prefix('/') else {
		return false;
	};
	let rest = rest.trim_start_matches(util::is_js_space);
	let Some(rest) = rest.strip_prefix('/') else {
		return false;
	};
	rest.trim_start_matches(util::is_js_space) == ">"
}

fn add_is_space_sensitive(ast: &mut Ast) {
	walk(ast, |ast, id| {
		if !has_children(ast.node(id)) {
			return;
		}
		let children = ast.node(id).children().to_vec();
		if children.is_empty() {
			let v = is_dangling_space_sensitive(ast.node(id));
			ast.node_mut(id).is_dangling_space_sensitive = v;
			return;
		}
		for &c in &children {
			let (l, t) = (
				is_leading_space_sensitive(ast, c),
				is_trailing_space_sensitive(ast, c),
			);
			let n = ast.node_mut(c);
			n.is_leading_space_sensitive = l;
			n.is_trailing_space_sensitive = t;
		}
		for (i, &c) in children.iter().enumerate() {
			let prev_trailing = i
				.checked_sub(1)
				.map(|j| ast.node(children[j]).is_trailing_space_sensitive);
			let next_leading = children
				.get(i + 1)
				.map(|&n| ast.node(n).is_leading_space_sensitive);
			let n = ast.node_mut(c);
			n.is_leading_space_sensitive =
				prev_trailing.is_none_or(|p| p) && n.is_leading_space_sensitive;
			n.is_trailing_space_sensitive =
				next_leading.is_none_or(|p| p) && n.is_trailing_space_sensitive;
		}
	});
}

fn merge_simple_element_into_text(ast: &mut Ast) {
	walk(ast, |ast, id| {
		if !has_children(ast.node(id)) {
			return;
		}
		ast.retain_children(id, |nodes, child, prev, next| {
			let n = &nodes[child];
			let simple = n.kind == Kind::Element
				&& n.attrs.is_empty()
				&& n.children().len() == 1
				&& nodes[n.children()[0]].kind == Kind::Text
				&& !util::has_ws(&nodes[n.children()[0]].value)
				&& !nodes[n.children()[0]].has_leading_spaces
				&& !nodes[n.children()[0]].has_trailing_spaces
				&& n.is_leading_space_sensitive
				&& !n.has_leading_spaces
				&& n.is_trailing_space_sensitive
				&& !n.has_trailing_spaces
				&& prev.is_some_and(|p| nodes[p].kind == Kind::Text)
				&& next.is_some_and(|x| nodes[x].kind == Kind::Text);
			let (true, Some(p), Some(x)) = (simple, prev, next) else {
				return Retain::Keep;
			};
			let raw = nodes[child].raw_name();
			let inner = nodes[nodes[child].children()[0]].value.clone();
			let next_value = nodes[x].value.clone();
			let (next_end, next_trailing_sensitive, next_has_trailing) = (
				nodes[x].span.end,
				nodes[x].is_trailing_space_sensitive,
				nodes[x].has_trailing_spaces,
			);
			let a = &mut nodes[p];
			a.value = format!("{}<{raw}>{inner}</{raw}>{next_value}", a.value);
			a.span.end = next_end;
			a.is_trailing_space_sensitive = next_trailing_sensitive;
			a.has_trailing_spaces = next_has_trailing;
			// leave out the element and the text after it: the merged text is the one before
			// them, and what comes next is looked at with it as its `prev`
			Retain::DropWithNext
		});
	});
}

/// Runs prettier's preprocessing on a freshly parsed tree.
pub fn run(ast: &mut Ast, sensitivity: WhitespaceSensitivity) {
	remove_ignorable_first_lf(ast);
	merge_if_conditional_start_end_comment_into_element_opening_tag(ast);
	merge_cdata_into_text(ast);
	extract_whitespaces(ast);
	add_css_display(ast, sensitivity);
	add_is_self_closing(ast);
	add_has_htm_component_closing_tag(ast);
	add_is_space_sensitive(ast);
	merge_simple_element_into_text(ast);
}
