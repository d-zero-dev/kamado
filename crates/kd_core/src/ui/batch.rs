//! A batch of edits made as one (RFC §14.2, "一括編集"): all of them, or none.
//!
//! Why the edits are not made in the order given: a batch is meant to happen at once, as a
//! spreadsheet is, so the order of its rows says nothing about which move frees the place of
//! another. The edits are put in the order that lets each find its place free (see `moves`),
//! and the page an edit names is the page as it was before the batch.
//!
//! Why each edit is made by the code of a single edit: the checks a place has to pass, the
//! `import`s that follow a moved page, the entry in `pages.overrides` that follows a URL are
//! the rules of one edit, and a second copy of them would be a second place to keep right.
//! What the batch adds is the order, one check of the hashes before anything is written, and
//! the journal that puts all of it back (see `Journal`).

use super::moves::{self, Step};
use super::{
	Change, Done, Edit, Fail, Journal, KeyChange, Meta, Overrides, Ui, Value, file_hash,
	hash_expected,
};
use std::fs;

/// The page files of the input directory, as one walk of it finds them (`discover_pages`), and
/// what the commits of a batch did to them since.
///
/// Why: planning the site again after an edit walks the input directory, and the walk is most
/// of what planning costs when the files are read from the plan cache. A batch of two hundred
/// moves would walk it two hundred times; the
/// batch knows what it moved, made and removed, so it walks once, then follows its own changes
/// (see `Journal`) and gives the list to the plan. Once the batch is made the directory is
/// walked once more and compared with the list, which would otherwise be a place for a
/// difference to go unnoticed.
pub(super) struct FoundFiles {
	/// The pages' paths relative to the input directory, sorted as the walk gives them.
	set: std::collections::BTreeSet<String>,
	files: Vec<kd_glob::Pattern>,
	ignore: Vec<kd_glob::Pattern>,
	/// `dir.input` with a closing `/`, what a path of the journal starts with.
	prefix: String,
	/// How many events of the journal have been followed.
	seen: usize,
}

impl FoundFiles {
	pub(super) fn walk(config: &kd_config::Config) -> Result<FoundFiles, String> {
		Ok(FoundFiles {
			set: crate::discover_pages(config)?.into_iter().collect(),
			files: crate::compile_globs(&config.pages.files)?,
			ignore: crate::compile_globs(&config.pages.ignore)?,
			prefix: format!("{}/", config.dir.input.trim_end_matches('/')),
			seen: 0,
		})
	}

	pub(super) fn list(&self) -> Vec<String> {
		self.set.iter().cloned().collect()
	}

	/// The path (relative to the input directory) if it is one the walk would find: a file the
	/// `pages.files` globs match and the `pages.ignore` globs do not.
	fn page(&self, path: &str) -> Option<String> {
		let rel = path.strip_prefix(&self.prefix)?;
		kd_site::matches_search(&self.files, &self.ignore, rel).then(|| rel.to_string())
	}

	/// Whether the walk would find the page file at `rel` (relative to the input directory).
	fn has(&self, rel: &str) -> bool {
		self.set.contains(rel)
	}

	/// Takes in what the events of the journal that were not followed yet did: a file moved
	/// away is no longer found at its old path (a file set aside to be removed is moved to a name
	/// no page has) and is found at its new one, and a file written where there was none is found.
	/// Says which page files that touched: the paths of the ones that went away, came or were
	/// written over, with the input directory in front, as a page has them.
	pub(super) fn follow(&mut self, events: &[super::Event]) -> std::collections::BTreeSet<String> {
		let mut changed = std::collections::BTreeSet::new();
		for event in events.get(self.seen..).unwrap_or_default() {
			match event {
				super::Event::Rename(from, to) => {
					if let Some(rel) = self.page(from) {
						self.set.remove(&rel);
						changed.insert(from.clone());
					}
					if let Some(rel) = self.page(to) {
						self.set.insert(rel);
						changed.insert(to.clone());
					}
				}
				super::Event::Write(path, old) => {
					if let Some(rel) = self.page(path) {
						if old.is_none() {
							self.set.insert(rel);
						}
						changed.insert(path.clone());
					}
				}
				super::Event::MadeDirs(_) => {}
			}
		}
		self.seen = events.len();
		changed
	}

	/// Whether the directory still has the page files this list says, as it is now.
	pub(super) fn agrees_with(&self, config: &kd_config::Config) -> Result<bool, String> {
		let walked: std::collections::BTreeSet<String> =
			crate::discover_pages(config)?.into_iter().collect();
		Ok(walked == self.set)
	}
}

/// Where the pages of the plan are, by the paths they have: `Ui::by_url` answers for the URL, and
/// the checks of `patch_plan` ask the same of the input path and the output path, which a scan
/// of every page would answer once per commit.
#[derive(Default)]
pub(super) struct PlanIndex {
	/// The pages that have a file, by the path of the file.
	by_input: std::collections::HashMap<String, usize>,
	by_output: std::collections::HashMap<String, usize>,
}

impl PlanIndex {
	pub(super) fn of(plan: &crate::Plan) -> PlanIndex {
		let mut index = PlanIndex::default();
		for (i, page) in plan.pages.iter().enumerate() {
			index.put(page, i);
		}
		index
	}

	fn put(&mut self, page: &crate::Page, i: usize) {
		if !page.is_virtual {
			self.by_input.insert(page.file.input_path.clone(), i);
		}
		self.by_output.insert(page.file.output_path.clone(), i);
	}

	fn drop_page(&mut self, page: &crate::Page) {
		if !page.is_virtual {
			self.by_input.remove(&page.file.input_path);
		}
		self.by_output.remove(&page.file.output_path);
	}
}

/// An edit of a batch, with its place in the request.
struct Item {
	index: usize,
	edit: Edit,
}

/// When an edit is made, in the order of the batch: first what frees places (a page that goes),
/// then the moves, then the pages that are made, then the pages that are given a file (a page
/// that is made can be given one), and last the keys of the pages as they are by then. A type and not a number, so that an edit that is added has to say
/// where it goes (the compiler asks) and a phase cannot be mistaken for another.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
	Frees,
	Moves,
	Creates,
	Materializes,
	Keys,
}

/// The phase of an edit, `None` for the edit a batch does not take (`revert`, see `edit_batch`).
fn phase(change: &Change) -> Option<Phase> {
	match change {
		Change::DeletePage | Change::Virtualize => Some(Phase::Frees),
		Change::MoveUrl(_) | Change::MovePath(_) => Some(Phase::Moves),
		Change::Create { .. } => Some(Phase::Creates),
		Change::Materialize(_) => Some(Phase::Materializes),
		Change::Key(_) => Some(Phase::Keys),
		Change::Revert { .. } => None,
	}
}

fn op_name(change: &Change) -> &'static str {
	match change {
		Change::Key(KeyChange::Set(..)) => "set",
		Change::Key(KeyChange::Delete(_)) => "delete",
		Change::MoveUrl(_) => "moveUrl",
		Change::MovePath(_) => "movePath",
		Change::Revert { .. } => "revert",
		Change::Create { .. } => "create",
		Change::Virtualize => "virtualize",
		Change::Materialize(_) => "materialize",
		Change::DeletePage => "deletePage",
	}
}

/// A path as typed, relative to the input directory, without the ways of writing the same
/// place that differ (`./a.html`, `/a.html`): two moves are put in an order by what they say,
/// so the same place has to be said the same way. A place written in a way that is not
/// recognized here is a collision when the move is made, never a wrong order.
pub(super) fn plain_path(typed: &str) -> String {
	let mut p = typed;
	loop {
		if let Some(rest) = p.strip_prefix("./") {
			p = rest;
		} else if let Some(rest) = p.strip_prefix('/') {
			p = rest;
		} else {
			return p.to_string();
		}
	}
}

/// `name` with `-kamado-tmp-<n>` before the extension (or the end, and before a closing `/`):
/// the place a move is parked at has the same directory as the place it leaves.
pub(super) fn temporary_name(place: &str, n: u32) -> String {
	// The root has no name to put the suffix on: its other self is a directory of the root.
	if place == "/" {
		return format!("/kamado-tmp-{n}/");
	}
	let (head, tail) = match place.strip_suffix('/') {
		Some(head) => (head, "/"),
		None => (place, ""),
	};
	let slash = head.rfind('/').map_or(0, |i| i + 1);
	let (dir, name) = head.split_at(slash);
	match name.rfind('.') {
		Some(dot) if dot > 0 => {
			format!("{dir}{}-kamado-tmp-{n}{}{tail}", &name[..dot], &name[dot..])
		}
		_ => format!("{dir}{name}-kamado-tmp-{n}{tail}"),
	}
}

/// A name for a place to be parked at that `is_taken` says is free.
pub(super) fn free_name(place: &str, is_taken: impl Fn(&str) -> bool) -> String {
	let mut n = 1;
	loop {
		let name = temporary_name(place, n);
		if !is_taken(&name) {
			return name;
		}
		n += 1;
	}
}

/// The error an edit gives for a batch: which of the edits, and what is wrong with it.
type Errors = Vec<(usize, Fail)>;

/// The place of a failure that no edit of the request is behind (the file of `pages.overrides`
/// could not be written, the site cannot be planned from what the batch made): its `index` is
/// `null` in the answer.
const NO_EDIT: usize = usize::MAX;

impl Ui {
	/// Makes the edits of `batch_json` (`{ "edits": [ … ] }`, each of the form of [`Ui::edit`]'s
	/// request) as one: all of them are made, or none (RFC §14.2). `revert` is not taken.
	///
	/// The order of `edits` is not the order they are made in: what frees places comes first,
	/// then the moves (in an order that finds each place free, exchanges and rings included),
	/// then what makes pages, then the keys. Every edit names the page as it is before the batch
	/// (a page the batch makes can be named by `materialize` and the keys), and every `expect` is
	/// checked against the files before the batch, before anything is written.
	///
	/// The answer is `{ "ok": true, "version", "overridesHash", "count", "warning"? }` (`version`
	/// is one more than before, `warning` says the files that could not be removed), or
	/// `{ "ok": false, "code", "message", "errors": [ { "index", "code", "message" } ] }` with
	/// nothing written and the version as it was. `errors` has every edit that cannot be made
	/// together with the others (found before anything is written), or the one edit that was
	/// refused while the batch was made (`index` is `null` for a failure no edit is behind).
	///
	/// # Errors
	///
	/// A message for a request that is not what it should be.
	///
	/// # Example
	///
	/// ```no_run
	/// let loaded = kd_core::load("/site/kamado.config.jsonc").unwrap();
	/// let mut ui = kd_core::Ui::open(loaded, &kd_core::BuildOptions::default()).unwrap();
	/// let answer = ui
	///     .edit_batch(r#"{"edits":[{"url":"/a/","expect":{"input":null},"change":{"op":"set","key":"title","value":"A"}}]}"#)
	///     .unwrap();
	/// assert!(answer.contains(r#""ok":"#));
	/// ```
	pub fn edit_batch(&mut self, batch_json: &str) -> Result<String, String> {
		let items = parse_batch(batch_json)?;
		self.left_behind.clear();
		if items.is_empty() {
			return Ok(self.batch_ok_json(0));
		}
		// The handle's copy of `pages.overrides` is what the checks and the edits read: it has to be
		// what the file holds.
		if let Some(o) = &self.overrides
			&& fs::read_to_string(&o.path).ok().as_deref() != Some(o.text.as_str())
		{
			self.plan_again(None)?;
		}
		let mut errors: Errors = Vec::new();
		self.check_batch(&items, &mut errors);
		if !errors.is_empty() {
			if errors.iter().any(|(_, f)| f.code == "conflict") {
				// A file is not what the editor saw: the handle reads the site again, as it does for
				// one edit, so that what the editor asks for next carries the hashes of the files.
				let _ = self.plan_again(None);
			}
			return Ok(batch_fail_json(&errors, None));
		}
		let version = self.version;
		self.touched.clear();
		self.found = Some(FoundFiles::walk(&self.loaded.config)?);
		self.index = Some(PlanIndex::of(&self.plan));
		self.batch = Some(Journal {
			defer: self.overrides.as_ref().map(|o| o.path.clone()),
			..Journal::default()
		});
		let made = self
			.make_batch(&items)
			.and_then(|()| self.flush_overrides().map_err(|f| (NO_EDIT, f)))
			.and_then(|()| self.check_found())
			.and_then(|()| self.plan_finally());
		let mut journal = self.batch.take().unwrap_or_default();
		self.found = None;
		self.index = None;
		self.touched.clear();
		match made {
			Ok(()) => {
				self.left_behind = journal.finish();
				// The plans made while the batch was made each counted a version; the batch counts one.
				self.version = version + 1;
				Ok(self.batch_ok_json(items.len()))
			}
			Err((index, failed)) => {
				let stuck = journal.put_back();
				// What the files hold now is what they held before the batch; the plan is made of
				// them again, because the edits made so far changed it.
				let reread = self.plan_again(None);
				if reread.is_ok() {
					// What is shown is what it was, so it is the version it was.
					self.version = version;
				}
				let mut message = failed.message;
				if !stuck.is_empty() {
					message.push_str(&format!(
						"; these could not be put back: {}",
						stuck.join("; ")
					));
				}
				if let Err(e) = reread {
					message.push_str(&format!(
						" (the site could not be read again, so the pages shown may not be what the files hold; read the site again: {e})"
					));
				}
				Ok(batch_fail_json(
					&[(
						index,
						Fail {
							code: failed.code,
							message,
						},
					)],
					Some(failed.code),
				))
			}
		}
	}

	/// Writes `pages.overrides` as the batch has it, if its commits held it back (see
	/// [`Journal::deferred`]): once, with what it held recorded to be put back like any write.
	pub(super) fn flush_overrides(&mut self) -> Result<(), Fail> {
		let Some(journal) = &mut self.batch else {
			return Ok(());
		};
		let (Some(text), Some(path)) = (journal.deferred.take(), journal.defer.clone()) else {
			return Ok(());
		};
		let old = match fs::read(&path) {
			Ok(bytes) => Some(bytes),
			Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
			Err(e) => return Err(super::io_fail(&path, &e)),
		};
		// Recorded before the write, so that a write that fails half way is put back too.
		journal.events.push(super::Event::Write(path.clone(), old));
		fs::write(&path, &text).map_err(|e| super::io_fail(&path, &e))?;
		if let Some(o) = &mut self.overrides
			&& o.path == path
		{
			o.hash = super::hash_hex(text.as_bytes());
			o.text = text;
		}
		Ok(())
	}

	/// Plans the site again, from the files, once the batch is made: what the plan said while it
	/// was made was kept up to date by hand (see `patch_plan`) and is not what the edits are
	/// answered with. The list of page files was checked against the directory just before; here
	/// the entries of `pages.overrides` are: the file that was written has to read as the model
	/// the edits kept, or something was written that is not what was meant, and nothing is kept.
	fn plan_finally(&mut self) -> Result<(), (usize, Fail)> {
		#[cfg(test)]
		let patched = self.plan.clone();
		let model = self.overrides.as_ref().map(|o| o.parsed.clone());
		self.plan_again(None).map_err(|e| {
			(
				NO_EDIT,
				Fail {
					code: "io",
					message: format!(
						"the site cannot be planned from what the batch made, so nothing was written: {e}"
					),
				},
			)
		})?;
		if let (Some(model), Some(o)) = (&model, &self.overrides)
			&& *model != o.parsed
		{
			return Err((
				NO_EDIT,
				Fail {
					code: "invalid",
					message: format!(
						"the edits would not read back as written in {}; nothing was written",
						o.path
					),
				},
			));
		}
		#[cfg(test)]
		self.assert_plan_agrees(patched);
		Ok(())
	}

	/// For the tests: the plan kept up to date by hand has the pages the plan from the files has
	/// (in an order of its own, which the plan from the files settles).
	#[cfg(test)]
	fn assert_plan_agrees(&self, patched: crate::Plan) {
		let by_url = |pages: &[crate::Page]| {
			let mut pages = pages.to_vec();
			pages.sort_by(|a, b| a.file.url.cmp(&b.file.url));
			pages
		};
		assert_eq!(
			by_url(&patched.pages),
			by_url(&self.plan.pages),
			"the plan kept up to date by hand is the plan of the files"
		);
	}

	/// Brings the plan up to date after a commit of the batch, without planning the whole site
	/// again: the pages of the page files that changed (`changed`: the paths of the ones that went
	/// away, came or were written over) and the pages of the entries of `pages.overrides` that
	/// the commit changed (`self.touched`) are made again, as the plan makes them, and the rest
	/// stay as they are. Says whether it could; if not, nothing was changed and the caller plans
	/// the site again.
	///
	/// Why not always: planning the site again reads, resolves and orders every page, and a batch
	/// of two hundred moves of a site of a hundred thousand pages would do that two hundred
	/// times. This answers only what the checks of the next edit read (which pages there are, with
	/// which URL, output path and metadata). It does not settle the order of the pages or the
	/// conflict policy: a change that touches them is left to the plan, and so is a change that
	/// this cannot be sure of. The plan that is made when the batch is over is the one the edits
	/// are answered with.
	pub(super) fn patch_plan(&mut self, changed: &std::collections::BTreeSet<String>) -> bool {
		let (Some(found), Some(index)) = (&self.found, &self.index) else {
			return false;
		};
		let dirs = self.dirs();
		let config = &self.loaded.config;
		let model = self.overrides.as_ref().map(|o| &o.parsed);
		// The pages the page files make now, before anything is changed.
		let mut built: Vec<crate::Assembled> = Vec::new();
		let prefix = format!("{}/", self.input_dir());
		for path in changed {
			let rel = path.strip_prefix(&prefix);
			if !rel.is_some_and(|rel| found.has(rel)) {
				continue;
			}
			let Ok((read, _)) = crate::read_files(path, None) else {
				return false;
			};
			let Ok(mut assembled) = crate::assemble_page(config, &dirs, path, read, false, true)
			else {
				return false;
			};
			assembled.page.body = None;
			assembled.page.body_pending = false;
			// A page that has an entry in `pages.overrides` is made with it (RFC §6).
			if let Some(entry) = model.and_then(|m| m.by_url.get(&assembled.page.file.url)) {
				if entry.is_virtual {
					return false;
				}
				assembled.page.meta = kd_site::meta::merge(&[&assembled.page.meta, &entry.meta]);
				assembled.page.lastmod = entry.lastmod.clone();
			}
			built.push(assembled);
		}
		// The pages of the page files that went away or were written over.
		let gone: std::collections::HashSet<usize> = changed
			.iter()
			.filter_map(|path| index.by_input.get(path).copied())
			.collect();
		// The pages of the entries that were changed: a virtual page is the entry, and the
		// entry of a page that has a file is merged into the page.
		let mut dropped: std::collections::HashSet<usize> = std::collections::HashSet::new();
		let mut virtuals: Vec<crate::Page> = Vec::new();
		let mut remade: Vec<(usize, kd_site::meta::Meta, Option<String>)> = Vec::new();
		for url in &self.touched {
			if built.iter().any(|a| a.page.file.url == *url) {
				continue;
			}
			let entry = model.and_then(|m| m.by_url.get(url));
			let existing = self.by_url.get(url).copied().filter(|i| !gone.contains(i));
			let virtual_page = |entry: &kd_site::meta::Override| -> Option<crate::Page> {
				let rel = kd_site::url_to_local_path(&entry.url, &config.pages.output_extension);
				let file = kd_site::page_file(&format!("{}/{rel}", self.input_dir()), &dirs);
				(file.url == entry.url).then(|| crate::Page {
					file,
					kind: crate::PageKind::Html,
					meta: entry.meta.clone(),
					body: None,
					body_pending: false,
					deps: std::collections::BTreeMap::new(),
					is_virtual: true,
					lastmod: entry.lastmod.clone(),
				})
			};
			match (existing, entry) {
				(Some(i), entry) if self.plan.pages[i].is_virtual => {
					dropped.insert(i);
					match entry {
						Some(e) if e.is_virtual => match virtual_page(e) {
							Some(page) => virtuals.push(page),
							None => return false,
						},
						Some(_) => return false,
						None => {}
					}
				}
				(Some(i), entry) => {
					let Some(cached) = self.cache.pages.get(&self.plan.pages[i].file.input_path)
					else {
						return false;
					};
					let mut meta = kd_site::meta::merge(&[&cached.in_file, &cached.side]);
					let mut lastmod = None;
					if let Some(e) = entry {
						meta = kd_site::meta::merge(&[&meta, &e.meta]);
						lastmod = e.lastmod.clone();
					}
					remade.push((i, meta, lastmod));
				}
				(None, Some(e)) if e.is_virtual => match virtual_page(e) {
					Some(page) => virtuals.push(page),
					None => return false,
				},
				(None, Some(_)) => return false,
				(None, None) => {}
			}
		}
		let stays = |i: usize| !gone.contains(&i) && !dropped.contains(&i);
		// Nothing that is made may take the place of a page that stays: its URL, its output
		// path (nor be the source of one, or have one that is a source), which the plan
		// settles by the conflict policy.
		let fresh: Vec<&crate::PageFile> = built
			.iter()
			.map(|a| &a.page.file)
			.chain(virtuals.iter().map(|p| &p.file))
			.collect();
		for (n, file) in fresh.iter().enumerate() {
			if fresh[..n]
				.iter()
				.any(|b| b.url == file.url || b.output_path == file.output_path)
			{
				return false;
			}
			let takes = |i: &usize| stays(*i);
			if self.by_url.get(&file.url).is_some_and(takes)
				|| index.by_output.get(&file.output_path).is_some_and(takes)
				// a page that stays has this output path as its source, or this source as its output
				|| index.by_input.get(&file.output_path).is_some_and(takes)
				|| index.by_output.get(&file.input_path).is_some_and(|i| {
					stays(*i) && !self.plan.pages[*i].is_virtual
				}) {
				return false;
			}
		}
		// Changing the plan, from here.
		for (i, meta, lastmod) in remade {
			let page = &mut self.plan.pages[i];
			page.meta = meta;
			page.lastmod = lastmod;
		}
		let mut removed: Vec<usize> = gone.iter().chain(&dropped).copied().collect();
		removed.sort_unstable_by(|a, b| b.cmp(a));
		removed.dedup();
		let index = self.index.get_or_insert_with(PlanIndex::default);
		for i in removed {
			let page = self.plan.pages.swap_remove(i);
			self.by_url.remove(&page.file.url);
			self.cache.pages.remove(&page.file.input_path);
			index.drop_page(&page);
			// The page that was last is where the removed one was.
			if let Some(moved) = self.plan.pages.get(i) {
				self.by_url.insert(moved.file.url.clone(), i);
				index.put(moved, i);
			}
		}
		let field = self.loaded.config.pages.output_path_field.clone();
		let made = built
			.into_iter()
			.map(|a| {
				if let Some(cached) = a.cached {
					self.cache
						.pages
						.insert(a.page.file.input_path.clone(), cached);
				}
				a.page
			})
			.chain(virtuals)
			.collect::<Vec<_>>();
		for page in made {
			for (k, _) in &page.meta {
				if Some(k) != field.as_ref() {
					self.columns.insert(k.clone());
				}
			}
			self.by_url
				.insert(page.file.url.clone(), self.plan.pages.len());
			index.put(&page, self.plan.pages.len());
			self.plan.pages.push(page);
		}
		self.cache_dirty = true;
		self.version += 1;
		true
	}

	/// Checks that the page files the batch followed are the ones the directory has now: the
	/// plan was made from the list, so a difference means the plan is not the files'.
	fn check_found(&self) -> Result<(), (usize, Fail)> {
		match self
			.found
			.as_ref()
			.map(|found| found.agrees_with(&self.loaded.config))
		{
			Some(Ok(true)) | None => Ok(()),
			Some(Ok(false)) => Err((
				NO_EDIT,
				Fail {
					code: "io",
					message: "the page files the batch left are not the ones it expected; nothing was written"
						.to_string(),
				},
			)),
			Some(Err(e)) => Err((
				NO_EDIT,
				Fail {
					code: "io",
					message: format!("the input directory cannot be read: {e}"),
				},
			)),
		}
	}

	fn batch_ok_json(&self, count: usize) -> String {
		let mut members = vec![
			("ok".to_owned(), Value::Bool(true)),
			("version".to_owned(), Value::Number(self.version as f64)),
			("overridesHash".to_owned(), self.overrides_hash_json()),
			("count".to_owned(), Value::Number(count as f64)),
		];
		if !self.left_behind.is_empty() {
			members.push((
				"warning".to_owned(),
				Value::String(format!(
					"the edits were made, but these files could not be removed and stay under another name: {}",
					self.left_behind.join("; ")
				)),
			));
		}
		Value::Object(members).to_json()
	}

	/// What can be told before anything is written: the pages the edits name, the hashes, and
	/// the edits that cannot be made together whatever order they are made in. Every problem
	/// is told, not the first.
	fn check_batch(&self, items: &[Item], errors: &mut Errors) {
		let mut hashes = std::collections::HashMap::new();
		let made_here: std::collections::HashSet<&str> = items
			.iter()
			.filter_map(|item| match &item.edit.change {
				Change::Create { url: Some(url), .. } => Some(url.as_str()),
				_ => None,
			})
			.collect();
		for item in items {
			let edit = &item.edit;
			let found = self.by_url.contains_key(&edit.url);
			match &edit.change {
				Change::Revert { .. } => errors.push((
					item.index,
					Fail {
						code: "invalid",
						message: "a batch does not take the edit \"revert\"".to_string(),
					},
				)),
				Change::Create { url, .. } => {
					// The URL of a page that is made has to be free once the batch has moved or
					// deleted what it is going to move or delete.
					let freed = |u: &str| {
						items.iter().any(|i| {
							i.edit.url == u
								&& matches!(
									i.edit.change,
									Change::DeletePage | Change::MoveUrl(_) | Change::MovePath(_)
								)
						})
					};
					if let Some(url) = url
						&& self.by_url.contains_key(url)
						&& !freed(url)
					{
						errors.push((
							item.index,
							Fail {
								code: "collision",
								message: format!("a page already has the URL {url}"),
							},
						));
					} else if let Err(f) = self.check_start(edit, &mut hashes) {
						errors.push((item.index, f));
					}
				}
				change => {
					// What comes after a page is made at a URL names the page that is made, not one
					// the batch deletes there: there is no start state of it to check.
					let after_creates = matches!(change, Change::Materialize(_) | Change::Key(_));
					let named_by_a_create = made_here.contains(edit.url.as_str());
					if named_by_a_create && after_creates {
						continue;
					}
					if !found {
						let message = if named_by_a_create {
							format!(
								"the page {} is made by this batch, so only \"materialize\", \"set\" and \"delete\" can name it",
								edit.url
							)
						} else {
							format!("there is no page with the URL {}", edit.url)
						};
						errors.push((
							item.index,
							Fail {
								code: "notFound",
								message,
							},
						));
					} else if let Some(message) = self.same_place(change, &edit.url) {
						errors.push((
							item.index,
							Fail {
								code: "invalid",
								message,
							},
						));
					} else if let Err(f) = self.check_start(edit, &mut hashes) {
						errors.push((item.index, f));
					}
				}
			}
		}
		overlaps(items, errors);
	}

	/// Why a move that leaves the page where it is is not made, said as a single edit says it.
	fn same_place(&self, change: &Change, url: &str) -> Option<String> {
		match change {
			Change::MoveUrl(to) if to == url => Some("the URL is the same as it was".to_string()),
			Change::MovePath(to) => {
				let at = *self.by_url.get(url)?;
				let page = &self.plan.pages[at];
				let prefix = format!("{}/", self.input_dir());
				let from = page.file.input_path.strip_prefix(&prefix)?;
				(!page.is_virtual && from == plain_path(to))
					.then(|| "the path is the same as it was".to_string())
			}
			_ => None,
		}
	}

	/// Checks that the hashes `expect` has are those of the files as they are before the batch
	/// (RFC §14.2): read from the disk, as one edit reads them, and each file once for the whole
	/// batch (`hashes`: `pages.overrides` is named by every edit that sets a key of a virtual
	/// page, and reading and hashing it for each would cost more than writing it). A field
	/// `expect` does not have is not asked for here: the edit asks for it when it is made, as a
	/// single edit would.
	fn check_start(
		&self,
		edit: &Edit,
		hashes: &mut std::collections::HashMap<String, Option<String>>,
	) -> Result<(), Fail> {
		let Value::Object(members) = &edit.expect else {
			return Ok(());
		};
		let page = self.by_url.get(&edit.url).map(|&i| &self.plan.pages[i]);
		let mut check = |field: &str, path: &str| -> Result<(), Fail> {
			if !hashes.contains_key(path) {
				let hash = file_hash(path).map_err(|e| super::io_fail(path, &e))?;
				hashes.insert(path.to_string(), hash);
			}
			hash_expected(&edit.expect, field, path, hashes[path].as_deref())
		};
		for (field, _) in members {
			match field.as_str() {
				"input" => {
					if let Some(page) = page.filter(|p| !p.is_virtual) {
						check("input", &page.file.input_path)?;
					}
				}
				"sidecar" => {
					if let Some(page) = page.filter(|p| !p.is_virtual) {
						check("sidecar", &crate::sidecar_path(&page.file.input_path))?;
					}
				}
				"overrides" => {
					if let Some(o) = &self.overrides {
						check("overrides", &o.path)?;
					}
				}
				_ => {}
			}
		}
		Ok(())
	}

	/// The hashes of the files as they are now, for the fields `original` has: the edits before
	/// this one may have written the files it names, and the hashes were checked before the
	/// batch began.
	fn expect_now(&self, url: &str, original: &Value) -> Result<Value, Fail> {
		let Value::Object(members) = original else {
			return Ok(original.clone());
		};
		let page = self.by_url.get(url).map(|&i| &self.plan.pages[i]);
		let mut now = Vec::with_capacity(members.len());
		for (field, value) in members {
			let hash = |path: &str| -> Result<Value, Fail> {
				Ok(file_hash(path)
					.map_err(|e| super::io_fail(path, &e))?
					.map_or(Value::Null, Value::String))
			};
			let fresh = match field.as_str() {
				"input" => match page.filter(|p| !p.is_virtual) {
					Some(page) => hash(&page.file.input_path)?,
					None => value.clone(),
				},
				"sidecar" => match page.filter(|p| !p.is_virtual) {
					Some(page) => hash(&crate::sidecar_path(&page.file.input_path))?,
					None => value.clone(),
				},
				// `pages.overrides` is not written while the batch is made (see
				// `Journal::deferred`), and the edits do not read its hash then; any other field
				// is not a hash of a file.
				_ => value.clone(),
			};
			now.push((field.clone(), fresh));
		}
		Ok(Value::Object(now))
	}

	/// Makes one edit of the batch at the page that has `url` now, with the hashes of the files as
	/// they are now (the edits before it may have written them; `original` was checked before
	/// the batch began).
	fn make_one(&mut self, url: &str, change: &Change, original: &Value) -> Result<Done, Fail> {
		let expect = self.expect_now(url, original)?;
		self.run_change(url, change, &expect)
	}

	/// Makes the edits in the order of their phases (see [`phase`]). Stops at the first that is
	/// refused, with its place in the request; what was made is for the caller to put back.
	fn make_batch(&mut self, items: &[Item]) -> Result<(), (usize, Fail)> {
		// The URL each page has now, by the URL it had before the batch.
		let mut now: std::collections::HashMap<String, String> = std::collections::HashMap::new();
		let current = |now: &std::collections::HashMap<String, String>, url: &str| {
			now.get(url).cloned().unwrap_or_else(|| url.to_string())
		};
		// The pages that have no file before the batch: a key set after the file is made is
		// written with the hashes of the file as the batch made it.
		let no_file_at_start: std::collections::HashSet<String> = items
			.iter()
			.filter_map(|item| match &item.edit.change {
				Change::Create { url: Some(url), .. } => Some(url.clone()),
				_ => None,
			})
			.chain(
				self.plan
					.pages
					.iter()
					.filter(|p| p.is_virtual)
					.map(|p| p.file.url.clone()),
			)
			.collect();
		// What frees places.
		for item in items
			.iter()
			.filter(|i| phase(&i.edit.change) == Some(Phase::Frees))
		{
			let url = current(&now, &item.edit.url);
			self.make_one(&url, &item.edit.change, &item.edit.expect)
				.map_err(|f| (item.index, f))?;
		}
		// The moves of URLs, then the moves of files, each in an order that finds the places free.
		self.make_url_moves(items, &mut now)?;
		self.make_path_moves(items, &mut now)?;
		// The pages that are made, then the pages that are given a file (one that is made can be
		// given one, whatever the order of the request), then the keys.
		for phase_now in [Phase::Creates, Phase::Materializes] {
			for item in items
				.iter()
				.filter(|i| phase(&i.edit.change) == Some(phase_now))
			{
				let url = current(&now, &item.edit.url);
				self.make_one(&url, &item.edit.change, &item.edit.expect)
					.map_err(|f| (item.index, f))?;
			}
		}
		let keys: Vec<(&Item, String)> = items
			.iter()
			.filter(|i| phase(&i.edit.change) == Some(Phase::Keys))
			.map(|item| (item, current(&now, &item.edit.url)))
			.collect();
		self.make_keys(&keys, &no_file_at_start)
	}

	/// Sets and deletes the keys of the batch. Unlike the edits that move or make pages, these
	/// are made on the text of each file in memory and written once per file, with the site
	/// planned again not at all: a batch of ten thousand keys of a site of a hundred thousand
	/// pages reads, checks and writes `pages.overrides` once, where ten thousand edits made one
	/// by one would read, hash, write and replace it ten thousand times. What is written is
	/// checked as one edit's is: the page files and the sidecars are made by the code of a
	/// single edit, and the entries of `pages.overrides` are read back one by one (see
	/// `edit_overrides_entries`).
	///
	/// `keys` are the edits with the URL their page has now. The hashes of `expect` were
	/// checked before the batch began; here only that the edit has the hash it needs is, as it
	/// is for a single edit.
	fn make_keys(
		&mut self,
		keys: &[(&Item, String)],
		no_file_at_start: &std::collections::HashSet<String>,
	) -> Result<(), (usize, Fail)> {
		use std::collections::HashMap;
		if keys.is_empty() {
			return Ok(());
		}
		// The page files and the sidecars: what each holds before the keys and as the keys have
		// changed it so far, by path, in the order they were first touched.
		let mut texts: Vec<(String, String, bool)> = Vec::new();
		let mut at: HashMap<String, usize> = HashMap::new();
		let mut meta_of: HashMap<usize, Meta> = HashMap::new();
		let mut touched: Vec<usize> = Vec::new();
		let mut is_touched: std::collections::HashSet<usize> = std::collections::HashSet::new();
		// `pages.overrides` as the keys change it: what it reads as, and the changes to make to
		// its entries, with the edit each comes from.
		// In a batch the handle's copy is what the earlier edits left (the file is not written
		// yet), and its model is what that text reads as.
		let overrides_before = self
			.overrides
			.as_ref()
			.map(|o| (o.path.clone(), o.text.clone(), o.parsed.clone()));
		let mut overrides_now: Option<Overrides> =
			overrides_before.as_ref().map(|(_, _, p)| p.clone());
		let entry_of: HashMap<String, usize> = overrides_before
			.as_ref()
			.map(|(_, _, p)| {
				p.order
					.iter()
					.enumerate()
					.map(|(i, url)| (url.clone(), i))
					.collect()
			})
			.unwrap_or_default();
		let mut entry_changes: Vec<(usize, usize, &str, &KeyChange)> = Vec::new();
		for (item, url) in keys {
			let Change::Key(change) = &item.edit.change else {
				continue;
			};
			let fail_at = |f: Fail| (item.index, f);
			let Some(&i) = self.by_url.get(url) else {
				return Err(fail_at(Fail {
					code: "notFound",
					message: format!("there is no page with the URL {url}"),
				}));
			};
			let key = change.key();
			let page = &self.plan.pages[i];
			let meta = meta_of.entry(i).or_insert_with(|| page.meta.clone());
			let exists = meta.iter().any(|(k, _)| k == key);
			let in_overrides = overrides_now
				.as_ref()
				.and_then(|p| p.by_url.get(&page.file.url))
				.is_some_and(|o| o.meta.iter().any(|(k, _)| k == key));
			let origin = self
				.key_origin(i, change, exists, in_overrides)
				.map_err(fail_at)?;
			let made_here = no_file_at_start.contains(item.edit.url.as_str());
			let (field, path) = match origin {
				super::Origin::InFile => ("input", page.file.input_path.clone()),
				super::Origin::Sidecar => ("sidecar", crate::sidecar_path(&page.file.input_path)),
				super::Origin::Overrides => match &overrides_before {
					Some((path, _, _)) => ("overrides", path.clone()),
					None => {
						return Err(fail_at(Fail {
							code: "invalid",
							message: "the site has no pages.overrides file".to_string(),
						}));
					}
				},
			};
			let has_hash =
				matches!(&item.edit.expect, Value::Object(m) if m.iter().any(|(f, _)| f == field));
			if !has_hash && !(made_here && field != "overrides") {
				return Err(fail_at(Fail {
					code: "invalid",
					message: format!(
						"`expect.{field}` (the hash of {path}) is required for this change"
					),
				}));
			}
			if origin == super::Origin::Overrides {
				let Some(&entry) = entry_of.get(&page.file.url) else {
					return Err(fail_at(Fail {
						code: "invalid",
						message: format!("{path} has no entry for {}", page.file.url),
					}));
				};
				entry_changes.push((item.index, entry, page.file.url.as_str(), change));
				if let Some(parsed) = &mut overrides_now
					&& let Some(e) = parsed.by_url.get_mut(&page.file.url)
				{
					e.meta = change.apply(&e.meta);
				}
			} else {
				let slot = match at.get(&path) {
					Some(&slot) => slot,
					None => {
						let bytes =
							std::fs::read(&path).map_err(|e| fail_at(super::io_fail(&path, &e)))?;
						let text = String::from_utf8(bytes).map_err(|_| {
							fail_at(Fail {
								code: "invalid",
								message: format!("{path}: file is not valid UTF-8"),
							})
						})?;
						texts.push((path.clone(), text, false));
						at.insert(path.clone(), texts.len() - 1);
						texts.len() - 1
					}
				};
				let edited = if origin == super::Origin::InFile {
					super::edit_page_text(&path, page.kind, &texts[slot].1, change)
				} else {
					super::edit_sidecar_text(&path, &texts[slot].1, change)
				};
				let edited = edited.map_err(fail_at)?;
				if edited != texts[slot].1 {
					texts[slot] = (path.clone(), edited, true);
				}
			}
			*meta = change.apply(meta);
			if is_touched.insert(i) {
				touched.push(i);
			}
		}
		let mut writes: Vec<(String, String)> = texts
			.into_iter()
			.filter(|(_, _, changed)| *changed)
			.map(|(path, text, _)| (path, text))
			.collect();
		let mut overrides_after = None;
		if let (Some((path, text, _)), false) = (&overrides_before, entry_changes.is_empty()) {
			let edited = edit_overrides_entries(path, text, &entry_changes)?;
			if &edited != text {
				writes.push((path.clone(), edited.clone()));
				overrides_after = Some(edited);
			}
		}
		let txn = super::Txn {
			writes,
			..super::Txn::default()
		};
		txn.commit_with(self.batch.as_mut())
			.map_err(|f| (NO_EDIT, f))?;
		// What the handle knows follows the files.
		if let (Some(text), Some(parsed), Some(o)) =
			(overrides_after, overrides_now, &mut self.overrides)
		{
			o.hash = super::hash_hex(text.as_bytes());
			o.text = text;
			o.parsed = parsed;
		}
		for i in touched {
			self.reread_page(i).map_err(|f| (NO_EDIT, f))?;
		}
		self.reindex_columns();
		Ok(())
	}
}

/// The text of `pages.overrides` once the key changes are made to its entries: `changes` are
/// `(the edit of the batch, the position of the entry, the change)`. Every entry is found in
/// one pass over the text and changed on its own text, so that a change costs the entry and
/// not the file; then the pieces are put together. What is written is checked as `edit_overrides_text`
/// checks one change: an entry has to read back as what the changes make of it, and what is
/// outside the entries is the text it was (it is not touched).
fn edit_overrides_entries(
	path: &str,
	text: &str,
	changes: &[(usize, usize, &str, &KeyChange)],
) -> Result<String, (usize, Fail)> {
	use kd_jsonc::edit::trusted;
	let ranges = trusted(text)
		.entry_ranges(&[super::Seg::Key("pages")])
		.map_err(|e| (NO_EDIT, super::overrides_edit_fail(path, &e)))?;
	let mut by_entry: std::collections::BTreeMap<usize, Vec<(usize, &str, &KeyChange)>> =
		std::collections::BTreeMap::new();
	for (index, entry, url, change) in changes {
		by_entry
			.entry(*entry)
			.or_default()
			.push((*index, url, change));
	}
	let mut out = String::with_capacity(text.len() + 64);
	let mut copied = 0;
	for (entry, list) in by_entry {
		let Some(&(start, end)) = ranges.get(entry) else {
			return Err((
				list[0].0,
				Fail {
					code: "invalid",
					message: format!("{path} has no entry at position {entry}"),
				},
			));
		};
		let original = &text[start..end];
		let mut edited = original.to_string();
		let mut expected = kd_jsonc::parse(original).map_err(|e| {
			(
				list[0].0,
				Fail {
					code: "invalid",
					message: format!("{path}: {e}"),
				},
			)
		})?;
		for (index, url, change) in &list {
			edited = super::change_entry(path, url, &edited, change, &mut expected)
				.map_err(|f| (*index, f))?;
		}
		let read_back = kd_jsonc::parse(&edited).map_err(|e| {
			(
				list[0].0,
				Fail {
					code: "invalid",
					message: format!("the edit would leave {path} unreadable: {e}"),
				},
			)
		})?;
		if read_back != expected {
			return Err((
				list[0].0,
				Fail {
					code: "invalid",
					message: format!(
						"the edit would not read back as written in {path}; nothing was written"
					),
				},
			));
		}
		out.push_str(&text[copied..start]);
		out.push_str(&edited);
		copied = end;
	}
	out.push_str(&text[copied..]);
	Ok(out)
}

impl Ui {
	/// Moves the URLs in an order that finds each place free. A page that is parked is at a
	/// temporary URL until the ring it is in has opened.
	fn make_url_moves(
		&mut self,
		items: &[Item],
		now: &mut std::collections::HashMap<String, String>,
	) -> Result<(), (usize, Fail)> {
		let moving: Vec<(&Item, String)> = items
			.iter()
			.filter_map(|item| match &item.edit.change {
				Change::MoveUrl(to) => Some((item, to.clone())),
				_ => None,
			})
			.collect();
		let pairs: Vec<(String, String)> = moving
			.iter()
			.map(|(item, to)| (item.edit.url.clone(), to.clone()))
			.collect();
		let named: std::collections::HashSet<&str> = pairs
			.iter()
			.flat_map(|(from, to)| [from.as_str(), to.as_str()])
			.collect();
		// A URL is taken by a page, by a place the moves name, or, for it is a place on the disk
		// too, by a file that is not a page.
		let is_taken = |name: &str| {
			named.contains(name)
				|| self.by_url.contains_key(name)
				|| self
					.url_as_page(name)
					.is_ok_and(|file| super::taken(&file.input_path))
		};
		let steps = moves::order(&pairs, |from| free_name(from, is_taken));
		for step in steps {
			// The page is at its URL before the batch until its own move is made.
			let (i, at, to) = match step {
				Step::Move(i) => (i, pairs[i].0.clone(), pairs[i].1.clone()),
				Step::Park(i, temp) => (i, pairs[i].0.clone(), temp),
				Step::Retrieve(i, temp) => (i, temp, pairs[i].1.clone()),
			};
			let item = moving[i].0;
			self.make_one(&at, &Change::MoveUrl(to.clone()), &item.edit.expect)
				.map_err(|f| (item.index, f))?;
			now.insert(pairs[i].0.clone(), to);
		}
		Ok(())
	}

	/// Moves the files in an order that finds each place free, the way the URLs are.
	fn make_path_moves(
		&mut self,
		items: &[Item],
		now: &mut std::collections::HashMap<String, String>,
	) -> Result<(), (usize, Fail)> {
		let input_prefix = format!("{}/", self.input_dir());
		let relative = |path: &str| path.strip_prefix(&input_prefix).unwrap_or(path).to_string();
		let moving: Vec<(&Item, String)> = items
			.iter()
			.filter_map(|item| match &item.edit.change {
				Change::MovePath(to) => Some((item, plain_path(to))),
				_ => None,
			})
			.collect();
		// Where each page's file is now (the moves of URLs may have moved it).
		let mut pairs: Vec<(String, String)> = Vec::with_capacity(moving.len());
		// The URL each page has as the steps go.
		let mut urls: Vec<String> = Vec::with_capacity(moving.len());
		for (item, to) in &moving {
			let url = now
				.get(&item.edit.url)
				.map_or(item.edit.url.as_str(), String::as_str);
			let Some(&at) = self.by_url.get(url) else {
				return Err((
					item.index,
					Fail {
						code: "notFound",
						message: format!("there is no page with the URL {url}"),
					},
				));
			};
			let from = relative(&self.plan.pages[at].file.input_path);
			if from == *to {
				return Err((
					item.index,
					Fail {
						code: "invalid",
						message: "the path is the same as it was".to_string(),
					},
				));
			}
			urls.push(url.to_string());
			pairs.push((from, to.clone()));
		}
		let named: std::collections::HashSet<&str> = pairs
			.iter()
			.flat_map(|(from, to)| [from.as_str(), to.as_str()])
			.collect();
		let is_taken = |name: &str| {
			let full = format!("{input_prefix}{name}");
			named.contains(name)
				|| self
					.index
					.as_ref()
					.is_some_and(|index| index.by_input.contains_key(&full))
				|| super::taken(&full)
		};
		let steps = moves::order(&pairs, |from| free_name(from, is_taken));
		for step in steps {
			let (i, to) = match step {
				Step::Move(i) => (i, pairs[i].1.clone()),
				Step::Park(i, temp) => (i, temp),
				Step::Retrieve(i, _) => (i, pairs[i].1.clone()),
			};
			let item = moving[i].0;
			let url = urls[i].clone();
			self.make_one(&url, &Change::MovePath(to.clone()), &item.edit.expect)
				.map_err(|f| (item.index, f))?;
			// A page whose URL a key makes keeps it; the URL of any other is the one its new place
			// gives. Why not look the page up by its file: that is a search of every page.
			if !self.by_url.contains_key(&url) {
				let place = kd_site::page_file(&format!("{input_prefix}{to}"), &self.dirs());
				urls[i] = place.url;
			}
			now.insert(item.edit.url.clone(), urls[i].clone());
		}
		Ok(())
	}
}

/// The edits of a request, each in the form of one edit.
fn parse_batch(batch_json: &str) -> Result<Vec<Item>, String> {
	let v = kd_jsonc::parse(batch_json).map_err(|e| format!("edit batch: invalid JSON: {e}"))?;
	let Some(Value::Array(edits)) = v.get("edits") else {
		return Err("edit batch: `edits` (an array) is required".to_string());
	};
	edits
		.iter()
		.enumerate()
		.map(|(index, edit)| {
			if !matches!(edit, Value::Object(_)) {
				return Err(format!("edit batch: `edits[{index}]` must be an object"));
			}
			super::parse_edit(&edit.to_json())
				.map(|edit| Item { index, edit })
				.map_err(|e| format!("edit batch: `edits[{index}]`: {e}"))
		})
		.collect()
}

/// The edits that cannot be made together, whatever order: one page changed in ways that
/// exclude each other, and two pages that take the same place. Every one is told.
fn overlaps(items: &[Item], errors: &mut Errors) {
	use std::collections::HashMap;
	let mut told = |index: usize, code: &'static str, message: String| {
		errors.push((index, Fail { code, message }));
	};
	let mut structural: HashMap<&str, Vec<&Item>> = HashMap::new();
	for item in items {
		if matches!(
			item.edit.change,
			Change::DeletePage
				| Change::Virtualize
				| Change::Materialize(_)
				| Change::MoveUrl(_)
				| Change::MovePath(_)
		) {
			structural
				.entry(item.edit.url.as_str())
				.or_default()
				.push(item);
		}
	}
	// A page that goes cannot also be moved, made virtual, given a file or have a key set.
	let gone: std::collections::HashSet<&str> = items
		.iter()
		.filter(|i| matches!(i.edit.change, Change::DeletePage))
		.map(|i| i.edit.url.as_str())
		.collect();
	let created: std::collections::HashSet<&str> = items
		.iter()
		.filter_map(|i| match &i.edit.change {
			Change::Create { url: Some(url), .. } => Some(url.as_str()),
			_ => None,
		})
		.collect();
	for url in &gone {
		let all: Vec<&Item> = items
			.iter()
			.filter(|i| {
				i.edit.url == *url
					&& !matches!(i.edit.change, Change::Create { .. })
					// what comes after a page is made at the URL names the page that is made
					&& !(created.contains(url)
						&& matches!(i.edit.change, Change::Materialize(_) | Change::Key(_)))
			})
			.collect();
		if all.len() > 1 {
			let names: Vec<&str> = all.iter().map(|i| op_name(&i.edit.change)).collect();
			for item in &all {
				told(
					item.index,
					"collision",
					format!(
						"the page {url} is changed in ways that exclude each other in one batch: {}",
						names.join(", ")
					),
				);
			}
		}
	}
	for (url, list) in &structural {
		if gone.contains(url) {
			continue;
		}
		let count = |f: fn(&Change) -> bool| list.iter().filter(|i| f(&i.edit.change)).count();
		let mut names: Vec<&str> = list.iter().map(|i| op_name(&i.edit.change)).collect();
		names.sort_unstable();
		let repeated = count(|c| matches!(c, Change::MoveUrl(_))) > 1
			|| count(|c| matches!(c, Change::MovePath(_))) > 1
			|| count(|c| matches!(c, Change::Virtualize | Change::Materialize(_))) > 1
			// a page that is virtual when the files are moved has no file to move
			|| (count(|c| matches!(c, Change::MovePath(_))) > 0
				&& count(|c| matches!(c, Change::Virtualize | Change::Materialize(_))) > 0);
		if repeated {
			for item in list {
				told(
					item.index,
					"collision",
					format!(
						"the page {url} is changed in ways that exclude each other in one batch: {}",
						names.join(", ")
					),
				);
			}
		}
	}
	let mut who: HashMap<(&'static str, String), Vec<usize>> = HashMap::new();
	for item in items {
		// A page that is made with a URL and a path takes both places.
		let places: Vec<(&'static str, String)> = match &item.edit.change {
			Change::MoveUrl(to) => vec![("URL", to.clone())],
			Change::MovePath(to) => vec![("path", plain_path(to))],
			Change::Create { url, path } => url
				.iter()
				.map(|url| ("URL", url.clone()))
				.chain(path.iter().map(|path| ("path", plain_path(path))))
				.collect(),
			_ => Vec::new(),
		};
		for place in places {
			who.entry(place).or_default().push(item.index);
		}
	}
	let mut same: Vec<_> = who.into_iter().filter(|(_, v)| v.len() > 1).collect();
	same.sort_by_key(|(_, v)| v[0]);
	for ((what, place), indexes) in same {
		for index in indexes {
			told(
				index,
				"collision",
				format!("more than one edit of the batch takes the {what} {place}"),
			);
		}
	}
	// A page that is a page of the start and also made by the batch is a collision of URLs; one
	// edit makes it, and it is reported when the page is made.
	// An edit is told once, whichever of the rules found it first.
	errors.sort_by_key(|(index, _)| *index);
	errors.dedup_by_key(|(index, _)| *index);
}

fn batch_fail_json(errors: &[(usize, Fail)], code: Option<&'static str>) -> String {
	let first = &errors[0].1;
	let list: Vec<Value> = errors
		.iter()
		.map(|(index, f)| {
			Value::Object(vec![
				(
					"index".to_owned(),
					if *index == NO_EDIT {
						Value::Null
					} else {
						Value::Number(*index as f64)
					},
				),
				("code".to_owned(), Value::String(f.code.to_owned())),
				("message".to_owned(), Value::String(f.message.clone())),
			])
		})
		.collect();
	let message = if errors.len() == 1 {
		first.message.clone()
	} else {
		format!(
			"{} edits of the batch cannot be made; nothing was written",
			errors.len()
		)
	};
	Value::Object(vec![
		("ok".to_owned(), Value::Bool(false)),
		(
			"code".to_owned(),
			Value::String(code.unwrap_or(first.code).to_owned()),
		),
		("message".to_owned(), Value::String(message)),
		("errors".to_owned(), Value::Array(list)),
	])
	.to_json()
}
