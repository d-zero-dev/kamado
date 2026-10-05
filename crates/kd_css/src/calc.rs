//! Constant folding of `calc()`: what postcss-calc does for expressions made
//! of numbers, dimensions and percentages.
//!
//! `calc(1px + 2px)` is `3px`, `calc(2 * 3em)` is `6em`, `calc(100% - 0px)` is
//! `100%`, `calc(100% - 20px + 10px)` is `calc(100% - 10px)`.
//!
//! The arithmetic is exact (decimal, not floating point) and a result that
//! would need more than five decimals is not folded: cssnano rounds to five
//! (`calc(100%/3)` is `33.33333%`), kd_css leaves such an expression as it is.
//! Expressions with `var()`, `env()` or any other function inside are left
//! alone as well, and so are units that cannot be added (`1s + 500ms`).

use crate::value::{ValueNode, stringify, unit};

/// A decimal number: `mantissa / 10^scale`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Dec {
	m: i128,
	e: u32,
}

const MAX_SCALE: u32 = 18;

impl Dec {
	fn parse(text: &str) -> Option<Dec> {
		let (neg, digits) = match text.as_bytes().first()? {
			b'-' => (true, &text[1..]),
			b'+' => (false, &text[1..]),
			_ => (false, text),
		};
		let (int, frac) = match digits.split_once('.') {
			Some((i, f)) => (i, f),
			None => (digits, ""),
		};
		if int.is_empty() && frac.is_empty() {
			return None;
		}
		if !int.bytes().chain(frac.bytes()).all(|c| c.is_ascii_digit()) {
			return None;
		}
		if frac.len() as u32 > MAX_SCALE || int.len() + frac.len() > 30 {
			return None;
		}
		let mut m: i128 = 0;
		for c in int.bytes().chain(frac.bytes()) {
			m = m.checked_mul(10)?.checked_add(i128::from(c - b'0'))?;
		}
		if neg {
			m = -m;
		}
		Some(Dec { m, e: frac.len() as u32 }.normal())
	}

	fn normal(mut self) -> Dec {
		while self.e > 0 && self.m % 10 == 0 {
			self.m /= 10;
			self.e -= 1;
		}
		if self.m == 0 {
			self.e = 0;
		}
		self
	}

	fn rescale(self, e: u32) -> Option<i128> {
		let mut m = self.m;
		for _ in self.e..e {
			m = m.checked_mul(10)?;
		}
		Some(m)
	}

	fn add(self, o: Dec) -> Option<Dec> {
		let e = self.e.max(o.e);
		let m = self.rescale(e)?.checked_add(o.rescale(e)?)?;
		Some(Dec { m, e }.normal())
	}

	fn neg(self) -> Dec {
		Dec { m: -self.m, e: self.e }
	}

	fn mul(self, o: Dec) -> Option<Dec> {
		let e = self.e + o.e;
		if e > MAX_SCALE {
			return None;
		}
		Some(Dec { m: self.m.checked_mul(o.m)?, e }.normal())
	}

	/// An exact quotient with at most five decimals.
	fn div(self, o: Dec) -> Option<Dec> {
		if o.m == 0 {
			return None;
		}
		for k in 0..=5u32 {
			let mut num = self.m;
			for _ in 0..(o.e + k) {
				num = num.checked_mul(10)?;
			}
			if num % o.m == 0 {
				let r = Dec { m: num / o.m, e: self.e + k }.normal();
				return (r.e <= 5).then_some(r);
			}
		}
		None
	}

	fn is_zero(self) -> bool {
		self.m == 0
	}

	fn text(self) -> String {
		let neg = self.m < 0;
		let digits = self.m.unsigned_abs().to_string();
		let e = self.e as usize;
		let body = if e == 0 {
			digits
		} else if digits.len() > e {
			format!("{}.{}", &digits[..digits.len() - e], &digits[digits.len() - e..])
		} else {
			format!(".{}{}", "0".repeat(e - digits.len()), digits)
		};
		if neg { format!("-{body}") } else { body }
	}
}

/// What the tokens of a calc expression are.
enum Tok {
	Num(Dec, String),
	Op(char),
	Group(Vec<Tok>),
}

/// A number with a unit, as one token.
fn number_token(word: &str) -> Option<Tok> {
	let (number, u) = unit(word)?;
	if !u.bytes().all(|c| c.is_ascii_alphabetic() || c == b'%') {
		return None;
	}
	let d = if number.contains(['e', 'E']) {
		// `1e3` is `1000`: through a float, which is exact enough for what
		// people write.
		let f: f64 = number.trim_start_matches('+').parse().ok()?;
		Dec::parse(&crate::numeric::js_number(f)?)?
	} else {
		Dec::parse(number)?
	};
	Some(Tok::Num(d, u.to_owned()))
}

fn tokens(nodes: &[ValueNode]) -> Option<Vec<Tok>> {
	let mut out = Vec::new();
	for n in nodes {
		match n {
			ValueNode::Space(_) => {}
			ValueNode::Word(w) => match w.as_str() {
				"+" | "-" | "*" | "/" => out.push(Tok::Op(w.chars().next()?)),
				_ => {
					// Inside plain parentheses `2*10px` is one word.
					let mut rest = w.as_str();
					loop {
						let cut = rest.find(['*', '/']);
						let (piece, tail) = match cut {
							Some(i) => (&rest[..i], Some(&rest[i..])),
							None => (rest, None),
						};
						out.push(number_token(piece)?);
						match tail {
							Some(t) => {
								out.push(Tok::Op(t.chars().next()?));
								rest = &t[1..];
								if rest.is_empty() {
									return None;
								}
							}
							None => break,
						}
					}
				}
			},
			ValueNode::Function { name, nodes, .. }
				if name.is_empty() || name.eq_ignore_ascii_case("calc") =>
			{
				out.push(Tok::Group(tokens(nodes)?));
			}
			_ => return None,
		}
	}
	Some(out)
}

/// A sum of terms, one per unit: (lower-case unit, unit as written, amount).
#[derive(Clone)]
struct Sum(Vec<(String, String, Dec)>);

impl Sum {
	fn constant(&self) -> Option<Dec> {
		match self.0.as_slice() {
			[(k, _, d)] if k.is_empty() => Some(*d),
			[] => Some(Dec { m: 0, e: 0 }),
			_ => None,
		}
	}

	fn scale(&self, by: Dec) -> Option<Sum> {
		let mut out = Vec::new();
		for (k, u, d) in &self.0 {
			out.push((k.clone(), u.clone(), d.mul(by)?));
		}
		Some(Sum(out))
	}

	fn add(&self, o: &Sum, negate: bool) -> Option<Sum> {
		let mut out = self.0.clone();
		for (k, u, d) in &o.0 {
			let d = if negate { d.neg() } else { *d };
			match out.iter_mut().find(|(k2, _, _)| k2 == k) {
				Some((_, _, d2)) => *d2 = d2.add(d)?,
				None => out.push((k.clone(), u.clone(), d)),
			}
		}
		Some(Sum(out))
	}
}

struct Eval<'a> {
	toks: &'a [Tok],
	pos: usize,
}

impl Eval<'_> {
	fn peek_op(&self) -> Option<char> {
		match self.toks.get(self.pos) {
			Some(Tok::Op(c)) => Some(*c),
			_ => None,
		}
	}

	fn expr(&mut self) -> Option<Sum> {
		let mut acc = self.term()?;
		while let Some(op @ ('+' | '-')) = self.peek_op() {
			self.pos += 1;
			let rhs = self.term()?;
			acc = acc.add(&rhs, op == '-')?;
		}
		Some(acc)
	}

	fn term(&mut self) -> Option<Sum> {
		let mut acc = self.factor()?;
		while let Some(op @ ('*' | '/')) = self.peek_op() {
			self.pos += 1;
			let rhs = self.factor()?;
			acc = if op == '*' {
				match (acc.constant(), rhs.constant()) {
					(Some(a), _) => rhs.scale(a)?,
					(_, Some(b)) => acc.scale(b)?,
					_ => return None,
				}
			} else {
				let d = rhs.constant()?;
				// Division by an exact decimal: scale by its reciprocal when
				// every amount divides exactly.
				let mut out = Vec::new();
				for (k, u, a) in &acc.0 {
					out.push((k.clone(), u.clone(), a.div(d)?));
				}
				Sum(out)
			};
		}
		Some(acc)
	}

	fn factor(&mut self) -> Option<Sum> {
		let t = self.toks.get(self.pos)?;
		match t {
			Tok::Num(d, u) => {
				self.pos += 1;
				Some(Sum(vec![(u.to_ascii_lowercase(), u.clone(), *d)]))
			}
			Tok::Group(inner) => {
				self.pos += 1;
				let mut e = Eval { toks: inner, pos: 0 };
				let v = e.expr()?;
				(e.pos == inner.len()).then_some(v)
			}
			Tok::Op(c @ ('-' | '+')) => {
				self.pos += 1;
				let v = self.factor()?;
				if *c == '-' { v.scale(Dec { m: -1, e: 0 }) } else { Some(v) }
			}
			Tok::Op(_) => None,
		}
	}
}

/// The folded text of the calc expression `nodes`, when folding shortens it.
fn fold(nodes: &[ValueNode], original: &str) -> Option<String> {
	let toks = tokens(nodes)?;
	if toks.is_empty() {
		return None;
	}
	let mut e = Eval { toks: &toks, pos: 0 };
	let sum = e.expr()?;
	if e.pos != toks.len() {
		return None;
	}
	let terms: Vec<&(String, String, Dec)> = sum.0.iter().filter(|(_, _, d)| !d.is_zero()).collect();
	let text = match terms.as_slice() {
		// A zero keeps its unit here; dropping it is the number rules' job,
		// which know the properties where `0` is not `0px`.
		[] => match sum.0.first() {
			Some((_, u, _)) => format!("0{u}"),
			None => "0".to_owned(),
		},
		[(_, u, d)] => format!("{}{}", d.text(), u),
		many => {
			let mut s = String::from("calc(");
			for (i, (_, u, d)) in many.iter().enumerate() {
				if i == 0 {
					s.push_str(&format!("{}{}", d.text(), u));
				} else if d.m < 0 {
					s.push_str(&format!(" - {}{}", d.neg().text(), u));
				} else {
					s.push_str(&format!(" + {}{}", d.text(), u));
				}
			}
			s.push(')');
			s
		}
	};
	(text.len() < original.len()).then_some(text)
}

/// Folds the `calc()` calls of a parsed value that can be folded.
///
/// # Example
///
/// ```
/// use kd_css::calc::fold_calc;
///
/// assert_eq!(fold_calc("calc(1px + 2px)"), "3px");
/// assert_eq!(fold_calc("calc(100% - 20px + 10px)"), "calc(100% - 10px)");
/// assert_eq!(fold_calc("calc(100% - var(--a))"), "calc(100% - var(--a))");
/// ```
pub fn fold_calc(value: &str) -> String {
	if !value.to_ascii_lowercase().contains("calc(") {
		return value.to_owned();
	}
	let mut nodes = crate::value::parse(value);
	let mut changed = false;
	fold_in(&mut nodes, &mut changed);
	if changed { stringify(&nodes) } else { value.to_owned() }
}

fn fold_in(nodes: &mut [ValueNode], changed: &mut bool) {
	for i in 0..nodes.len() {
		let (is_calc, prefixed, is_url) = match &nodes[i] {
			ValueNode::Function { name, .. } => (
				name.eq_ignore_ascii_case("calc")
					|| name.eq_ignore_ascii_case("-webkit-calc")
					|| name.eq_ignore_ascii_case("-moz-calc"),
				!name.eq_ignore_ascii_case("calc"),
				name.eq_ignore_ascii_case("url"),
			),
			_ => continue,
		};
		if is_url {
			continue;
		}
		if is_calc {
			let original = stringify(&nodes[i..=i]);
			let folded = match &nodes[i] {
				ValueNode::Function { nodes: inner, .. } => fold(inner, &original),
				_ => None,
			};
			// A prefixed calc() is only replaced by a plain value.
			if let Some(text) = folded
				&& !(prefixed && text.starts_with("calc("))
			{
				nodes[i] = ValueNode::Word(text);
				*changed = true;
				continue;
			}
		}
		if let ValueNode::Function { nodes: inner, .. } = &mut nodes[i] {
			fold_in(inner, changed);
		}
	}
}
