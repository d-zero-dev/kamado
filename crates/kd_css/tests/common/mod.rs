//! What the cssnano comparison tests share: the check, and the list of cases
//! where `kd_css` deliberately answers differently.

/// A case where `kd_css` does not give cssnano's answer on purpose. Both
/// answers are asserted, so the entry goes stale (and the test fails) when
/// either side changes.
pub struct Deliberate {
	pub input: &'static str,
	pub cssnano: &'static str,
	pub mine: &'static str,
	pub why: &'static str,
}

/// The deliberate differences. `why` says which decision it is; the decisions
/// are explained in the module documentation of the rule family.
pub const DELIBERATE: &[Deliberate] = &[];

/// Checks one case; the error says what is wrong.
pub fn check(input: &str, cssnano: &str) -> Result<(), String> {
	let mine = kd_css::minify(input).map_err(|e| format!("minify failed: {e}"))?;
	let again = kd_css::minify(&mine).map_err(|e| format!("minify of the output failed: {e}"))?;
	if again != mine {
		return Err(format!(
			"not idempotent\n  input: {input:?}\n  once:  {mine:?}\n  twice: {again:?}"
		));
	}
	let listed = DELIBERATE.iter().find(|d| d.input == input);
	if cssnano == "__ERROR__" || mine == cssnano {
		return match listed {
			Some(d) if mine == cssnano => Err(format!(
				"the deliberate difference ({}) is gone: {input:?}",
				d.why
			)),
			_ => Ok(()),
		};
	}
	match listed {
		Some(d) if d.cssnano == cssnano && d.mine == mine => Ok(()),
		Some(d) => Err(format!(
			"the deliberate difference ({}) changed\n  input:   {input:?}\n  cssnano: {cssnano:?} (listed {:?})\n  mine:    {mine:?} (listed {:?})",
			d.why, d.cssnano, d.mine
		)),
		None => Err(format!(
			"differs from cssnano\n  input:   {input:?}\n  cssnano: {cssnano:?}\n  mine:    {mine:?}"
		)),
	}
}

/// Checks cases of `(input, cssnano's output)`; fails with all the problems.
pub fn check_all(cases: &[(&str, &str)]) {
	let problems: Vec<String> = cases
		.iter()
		.filter_map(|(input, cssnano)| check(input, cssnano).err())
		.collect();
	assert!(
		problems.is_empty(),
		"{} of {} cases fail:\n{}",
		problems.len(),
		cases.len(),
		problems.join("\n")
	);
}
