//! `define`: global identifiers and member chains replaced by constant
//! expressions, as esbuild's `define` does (`process.env.NODE_ENV` becomes
//! `"production"`).
//!
//! The parser keeps no scopes, so a name is replaced wherever it is used as a
//! value, including where a local binding of the same name shadows it.
//! esbuild leaves those alone. Why accepted: a define names a global
//! (`DEBUG`, `process.env.X`), and a file that declares a local of that name
//! is rare and would be confusing to read either way.
//!
//! A chain is matched on the source text: `process . env . NODE_ENV` matches
//! with white space between the parts, `process?.env` and `process["env"]`
//! do not (esbuild does not match them either).

use crate::ast::{Edit, EditKind};

/// One define: the dotted name, split, and the expression that replaces it.
struct Rule<'a> {
	parts: Vec<&'a str>,
	value: String,
}

fn is_ident_byte(b: u8) -> bool {
	b.is_ascii_alphanumeric() || b == b'_' || b == b'$' || b >= 0x80
}

/// Whether `value` stands for one operand wherever it is put, so that it needs no
/// parentheses: a name or a number (`true`, `1.5`, `DEBUG`), or a string literal with no
/// escape. An operator (`-1`, `a/b`, `a ? b : c`) does not: `x - FOO` with `FOO` as `-1`
/// must not become `x--1`.
fn is_simple(value: &str) -> bool {
	let bytes = value.as_bytes();
	if bytes.len() >= 2 && matches!(bytes[0], b'"' | b'\'') && bytes[bytes.len() - 1] == bytes[0] {
		let inner = &bytes[1..bytes.len() - 1];
		return !inner.contains(&bytes[0]) && !inner.contains(&b'\\');
	}
	!value.is_empty() && value.bytes().all(|b| is_ident_byte(b) || b == b'.')
}

/// The end of the chain `parts[1..]` after an identifier that ends at
/// `from`, or `None` when the source does not continue that way.
fn match_rest(src: &[u8], from: usize, rest: &[&str]) -> Option<usize> {
	let skip_ws = |mut i: usize| {
		while src.get(i).is_some_and(|b| b.is_ascii_whitespace()) {
			i += 1;
		}
		i
	};
	let mut pos = from;
	for part in rest {
		pos = skip_ws(pos);
		if src.get(pos) != Some(&b'.') {
			return None;
		}
		pos = skip_ws(pos + 1);
		let end = pos + part.len();
		if src.get(pos..end) != Some(part.as_bytes())
			|| src.get(end).is_some_and(|b| is_ident_byte(*b))
		{
			return None;
		}
		pos = end;
	}
	Some(pos)
}

/// The edits that carry out `define` for the references of a file.
///
/// `refs` are the byte ranges of identifiers used as values and `shorthand`
/// the start offsets of those that are object shorthands (`{ DEBUG }`, which
/// becomes `{ DEBUG: true }`).
pub(crate) fn edits(
	src: &str,
	refs: &[(usize, usize)],
	shorthand: &[usize],
	define: &[(String, String)],
) -> Vec<Edit> {
	let rules: Vec<Rule<'_>> = define
		.iter()
		.map(|(name, value)| Rule {
			parts: name.split('.').collect(),
			value: if is_simple(value) {
				value.clone()
			} else {
				format!("({value})")
			},
		})
		.collect();
	let bytes = src.as_bytes();
	let mut out = Vec::new();
	let mut taken_until = 0;
	for &(start, end) in refs {
		if start < taken_until {
			continue;
		}
		let name = &src[start..end];
		// The longest rule that matches wins (`process.env.NODE_ENV` over
		// `process.env`).
		let best = rules
			.iter()
			.filter(|r| r.parts[0] == name)
			.filter_map(|r| match_rest(bytes, end, &r.parts[1..]).map(|e| (r, e)))
			.max_by_key(|(r, _)| r.parts.len());
		let Some((rule, rule_end)) = best else {
			continue;
		};
		let text = if shorthand.contains(&start) {
			format!("{name}: {}", rule.value)
		} else {
			rule.value.clone()
		};
		out.push(Edit {
			start,
			end: rule_end,
			kind: EditKind::Replace(text),
		});
		taken_until = rule_end;
	}
	out
}

#[cfg(test)]
mod tests {
	use crate::{Options, compile};

	fn run(src: &str, jsx: bool, define: &[(&str, &str)]) -> String {
		let define: Vec<(String, String)> = define
			.iter()
			.map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
			.collect();
		compile(
			src,
			&Options {
				runtime: "file:///rt.js",
				jsx,
				ts: true,
				elide_imports: false,
				rewrite: &|_| None,
				define: &define,
			},
		)
		.unwrap()
		.code
	}

	#[test]
	fn a_dotted_name_is_replaced_wherever_it_is_used_as_a_value() {
		let defs = [("process.env.NODE_ENV", "\"production\"")];
		assert_eq!(
			run(
				"if (process.env.NODE_ENV === 'production') run(process . env . NODE_ENV);",
				false,
				&defs
			),
			"if (\"production\" === 'production') run(\"production\");"
		);
		// Other chains, properties of other objects and strings stay.
		assert_eq!(
			run(
				"a(process.env.OTHER, process.envx, x.process.env.NODE_ENV, 'process.env.NODE_ENV');",
				false,
				&defs
			),
			"a(process.env.OTHER, process.envx, x.process.env.NODE_ENV, 'process.env.NODE_ENV');"
		);
	}

	#[test]
	fn a_value_with_an_operator_is_parenthesized_so_that_it_cannot_join_its_neighbours() {
		let defs = [
			("NEG", "-1"),
			("DIV", "a/b"),
			("PICK", "x?1:2"),
			("DEBUG", "true"),
			("TEXT", "\"a-b/c:d\""),
		];
		assert_eq!(
			run("f(x - NEG, y / DIV, PICK, DEBUG, TEXT);", false, &defs),
			"f(x - (-1), y / (a/b), (x?1:2), true, \"a-b/c:d\");"
		);
	}

	#[test]
	fn the_longest_matching_name_wins() {
		let defs = [("process.env", "{}"), ("process.env.MODE", "'dev'")];
		assert_eq!(
			run("a(process.env.MODE, process.env.X);", false, &defs),
			"a('dev', ({}).X);"
		);
	}

	#[test]
	fn a_value_that_is_not_simple_is_parenthesized_and_a_shorthand_becomes_a_property() {
		let defs = [("DEBUG", "true"), ("__CONFIG__", "{\"a\":1}")];
		assert_eq!(
			run("const o = { DEBUG, x: __CONFIG__.a };", false, &defs),
			"const o = { DEBUG: true, x: ({\"a\":1}).a };"
		);
	}

	#[test]
	fn a_define_applies_inside_jsx_expressions_too() {
		let out = run(
			"export default () => <p title={DEBUG ? 'a' : 'b'}>{DEBUG && 'x'}</p>;",
			true,
			&[("DEBUG", "false")],
		);
		assert!(out.contains("false ? 'a' : 'b'"), "{out}");
		assert!(out.contains("false && 'x'"), "{out}");
		assert!(!out.contains("DEBUG"), "{out}");
	}
}
