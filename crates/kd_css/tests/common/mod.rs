//! What the cssnano comparison tests share: the check, and the list of
//! decisions where `kd_css` deliberately answers differently.

use std::collections::BTreeSet;

/// A place where `kd_css` does not give cssnano's answer on purpose.
///
/// A case differs from cssnano's output only by decisions: replacing, in
/// `kd_css`'s output, each `mine` fragment of a decision whose `input`
/// fragment occurs in the case by its `cssnano` fragment must give cssnano's
/// output exactly. So both answers are asserted, and an entry goes stale (the
/// golden test fails) when either side changes or no case needs it.
pub struct Decision {
	/// Text that makes the decision apply: a fragment of the input.
	pub input: &'static str,
	/// What cssnano writes.
	pub cssnano: &'static str,
	/// What `kd_css` writes instead.
	pub mine: &'static str,
	/// The decision, in a few words; the reasons are in the module
	/// documentation of the rule family.
	pub why: &'static str,
}

const fn d(
	input: &'static str,
	mine: &'static str,
	cssnano: &'static str,
	why: &'static str,
) -> Decision {
	Decision {
		input,
		cssnano,
		mine,
		why,
	}
}

pub const DECISIONS: &[Decision] = &[
	// properties the minifier does not know keep their values
	d(
		"foo:0px",
		"foo:0px",
		"foo:0",
		"the value of an unknown property only loses white space",
	),
	d(
		"colour:RED",
		"colour:RED",
		"colour:red",
		"the value of an unknown property only loses white space",
	),
	d(
		"-x-margin:0px",
		"-x-margin:0px",
		"-x-margin:0",
		"an unknown vendor prefix makes an unknown property",
	),
	// "nothing" written shorter (what clean-css does and cssnano does not).
	// `border: none` is not among them: it resets the width to `medium`, which
	// `0` does not, so a later `border-style` would show a different line.
	d(
		"background:none",
		"background:0 0",
		"background:none",
		"`background: none` is `background: 0 0`",
	),
	d(
		"background:transparent",
		"background:0 0",
		"background:transparent",
		"`background: transparent` is `background: 0 0`",
	),
	// fonts
	d(
		"\"KaTeX_SansSerif\"",
		"font-family:KaTeX_SansSerif",
		"font-family:\"KaTeX_SansSerif\"",
		"a family name keeps its quotes only when a whole word of it is a keyword",
	),
	// numbers
	d(
		"height:0%",
		"height:0%",
		"height:0",
		"0% is not 0 where a percentage can mean `auto` (height, top)",
	),
	d(
		"width:0%",
		"width:0%",
		"width:0",
		"0% is not 0 where a percentage can mean `auto` (width)",
	),
	d(
		"var(--x,0px)",
		"var(--x,0px)",
		"var(--x,0)",
		"a var() fallback keeps its unit (it may end up in a calc())",
	),
	d(
		"margin:1E3px",
		"margin:1000px;margin:1e-7px",
		"margin:1e-7px",
		"an overridden margin is not dropped (merge-longhand is not ported)",
	),
	d(
		"animation:foo 1s steps(1,start) steps(1,end) steps(4,end)",
		"animation:foo 1s step-start step-end steps(4)",
		"animation:foo step-end steps(4) 1s step-start",
		"a keyword with no slot left leaves the animation unordered",
	),
	// custom properties
	d(
		"--space: ;",
		"--space: ;",
		"--space:;",
		"a custom property that is only white space keeps one space (the space toggle)",
	),
	d(
		"--b:#FFF",
		"--b:#FFF",
		"--b:#fff",
		"custom property values are kept as written",
	),
	d(
		"--c: calc( 1px  +  2px )",
		"--c:calc( 1px  +  2px )",
		"--c:3px",
		"custom property values are kept as written",
	),
	d(
		"--a:/* c */ 1px",
		"--a:/* c */ 1px",
		"--a:1px",
		"comments in custom property values are kept",
	),
	d(
		"--y: RED",
		"--y:RED",
		"--y:red",
		"custom property values are kept as written",
	),
	d(
		"--z: url( \"a.png\" )",
		"--z:url( \"a.png\" )",
		"--z:url(a.png)",
		"custom property values are kept as written",
	),
	// calc
	d(
		"calc(1px+2px)",
		"calc(1px+2px)",
		"3px",
		"an invalid calc() is not repaired",
	),
	d(
		"calc(-1 * var(--x))",
		"calc(-1*var(--x))",
		"calc(var(--x)*-1)",
		"the operands of a calc() are not reordered",
	),
	// urls
	d(
		"src:url(\"a.woff2\")",
		"url(\"a.woff2\") format",
		"url(a.woff2) format",
		"the url() of a font src keeps its quotes",
	),
	d(
		"url('a.woff')",
		"url(\"a.woff\") format",
		"url(a.woff) format",
		"the url() of a font src keeps its quotes",
	),
	d(
		"@namespace svg url(",
		"@namespace svg url(http://www.w3.org/2000/svg);@namespace url(http://www.w3.org/1999/xhtml)",
		"@namespace svg \"http://www.w3.org/2000/svg\";@namespace \"http://www.w3.org/1999/xhtml\";",
		"@namespace params are not rewritten",
	),
	// at-rules
	d(
		"@container (min-width: 400px)",
		"@container (min-width:400px)",
		"@container (min-width: 400px)",
		"white space in a container query goes",
	),
	d(
		"(max-width:  500px)",
		"(max-width:500px)",
		"(max-width:  500px)",
		"white space in a container query goes",
	),
	d(
		"@unknown foo  bar {a   :  b  ;  c:d}",
		"@unknown foo  bar{a   :  b  ;  c:d}",
		"@unknown foo  bar{a:b;c:d}",
		"an unknown at-rule keeps its block as written",
	),
	d(
		"@import \"a\";",
		"@import \"a\"",
		"@import \"a\";",
		"the last statement needs no `;`",
	),
	// selectors and rules
	d(
		"a\n\tb{x:1}",
		"a b{x:1}",
		"a\n\tb{x:1}",
		"a line break between compounds is a space",
	),
	d(
		"a[href=\"x\" i]{x:1}",
		"a[href=x i]{x:1;x:2}",
		"a[href=x i]{x:1}a[href=x i]{x:2}",
		"adjacent rules with the same minified selector are merged",
	),
	d(
		"a{x:y;/*! keep */}",
		"a{x:y;/*! keep */}",
		"a{x:y/*! keep */}",
		"a `;` stays before a kept comment (without it the comment would read as part of the value)",
	),
	d(
		"a{b:c}\n;\nd{e:f}",
		"a{b:c}; d{e:f}",
		"a{b:c}\n;d{e:f}",
		"a stray `;` before a rule stays part of its selector",
	),
	d(
		"a { b : c ; } ; b { c : d }",
		"a{b:c}; b{c:d}",
		"a{b:c} ;b{c:d}",
		"a stray `;` before a rule stays part of its selector",
	),
];

/// Checks one case; the error says what is wrong. On success, the indexes of
/// the decisions the case needed.
pub fn check(input: &str, cssnano: &str) -> Result<Vec<usize>, String> {
	let mine = kd_css::minify(input).map_err(|e| format!("minify failed: {e}"))?;
	let again = kd_css::minify(&mine).map_err(|e| format!("minify of the output failed: {e}"))?;
	if again != mine {
		return Err(format!(
			"not idempotent\n  input: {input:?}\n  once:  {mine:?}\n  twice: {again:?}"
		));
	}
	if cssnano == "__ERROR__" || mine == cssnano {
		return Ok(Vec::new());
	}
	let mut adjusted = mine.clone();
	let mut used = Vec::new();
	for (i, decision) in DECISIONS.iter().enumerate() {
		if input.contains(decision.input) && adjusted.contains(decision.mine) {
			adjusted = adjusted.replace(decision.mine, decision.cssnano);
			used.push(i);
		}
	}
	if adjusted == cssnano {
		Ok(used)
	} else {
		Err(format!(
			"differs from cssnano beyond the listed decisions\n  input:   {input:?}\n  cssnano: {cssnano:?}\n  mine:    {mine:?}\n  adjusted by {:?}: {adjusted:?}",
			used.iter().map(|&i| DECISIONS[i].why).collect::<Vec<_>>()
		))
	}
}

/// Checks cases of `(input, cssnano's output)`; fails with all the problems.
/// Returns the decisions the cases needed.
pub fn check_all(cases: &[(&str, &str)]) -> BTreeSet<usize> {
	let mut problems = Vec::new();
	let mut used = BTreeSet::new();
	for (input, cssnano) in cases {
		match check(input, cssnano) {
			Ok(u) => used.extend(u),
			Err(e) => problems.push(e),
		}
	}
	assert!(
		problems.is_empty(),
		"{} of {} cases fail:\n{}",
		problems.len(),
		cases.len(),
		problems.join("\n")
	);
	used
}
