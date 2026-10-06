//! `sitemap.xml` (RFC section 15), written at the end of a build.
//!
//! The list comes from the plan, not from what the build touched: a build of
//! a few pages (`targets`) or a cached one still writes the whole sitemap.
//! Virtual pages are listed too; they are the pages a server provides without
//! a file of ours.

use kd_config::{Config, Lastmod};
use kd_glob::Pattern;

use crate::Page;

/// The sitemap options, validated.
pub(crate) struct Settings {
	/// Absolute path of the file to write.
	pub output_path: String,
	include: Vec<Pattern>,
	exclude: Vec<Pattern>,
	lastmod: Lastmod,
	changefreq: Option<String>,
	priority: Option<String>,
	/// The URL the site is served from, without a trailing slash.
	base: String,
	output_dir: String,
}

fn patterns(globs: &[String]) -> Result<Vec<Pattern>, String> {
	globs
		.iter()
		.map(|g| Pattern::new(g).map_err(|e| format!("sitemap: invalid glob {g:?}: {e}")))
		.collect()
}

/// Reads the options of `config.sitemap`.
///
/// # Errors
///
/// A message when there is no URL to build addresses from (`site.baseURL` or
/// `site.host`), when `output` leaves the output directory, or a glob is
/// invalid.
pub(crate) fn settings(config: &Config) -> Result<Option<Settings>, String> {
	let Some(s) = &config.sitemap else {
		return Ok(None);
	};
	let base = match (&config.site.base_url, &config.site.host) {
		(Some(base), _) if base.contains("://") => base.trim_end_matches('/').to_owned(),
		(_, Some(host)) => format!("https://{}", host.trim_end_matches('/')),
		_ => {
			return Err(
				"sitemap: addresses need an origin: set site.baseURL to a full URL or site.host"
					.to_owned(),
			);
		}
	};
	let output_dir = kd_site::path::normalize(&config.dir.output);
	let output_path = kd_site::path::join(&output_dir, &s.output);
	if !output_path.starts_with(&format!("{}/", output_dir.trim_end_matches('/'))) {
		return Err(format!(
			"sitemap.output {:?} must be a file inside the output directory",
			s.output
		));
	}
	Ok(Some(Settings {
		output_path,
		include: patterns(&s.include)?,
		exclude: patterns(&s.exclude)?,
		lastmod: s.lastmod,
		changefreq: s.changefreq.clone(),
		priority: s.priority.clone(),
		base,
		output_dir,
	}))
}

fn escape(text: &str) -> String {
	text.replace('&', "&amp;")
		.replace('<', "&lt;")
		.replace('>', "&gt;")
		.replace('"', "&quot;")
		.replace('\'', "&apos;")
}

/// The time a file was last modified, as `YYYY-MM-DDTHH:MM:SSZ`.
fn mtime_of(path: &str) -> Option<String> {
	let secs = std::fs::metadata(path)
		.ok()?
		.modified()
		.ok()?
		.duration_since(std::time::UNIX_EPOCH)
		.ok()?
		.as_secs();
	let iso = crate::session::iso_from_secs(secs as i64);
	Some(iso.replace(".000Z", "Z"))
}

/// The XML of the sitemap for `pages`.
pub(crate) fn render(settings: &Settings, pages: &[Page]) -> String {
	let mut entries: Vec<(&str, String)> = Vec::new();
	for page in pages {
		let rel = kd_site::path::relative(&settings.output_dir, &page.file.output_path);
		if !settings.include.iter().any(|p| p.matches(&rel))
			|| settings.exclude.iter().any(|p| p.matches(&rel))
		{
			continue;
		}
		let lastmod = match settings.lastmod {
			Lastmod::None => None,
			Lastmod::Manifest => page.lastmod.clone(),
			Lastmod::Mtime if page.is_virtual => None,
			Lastmod::Mtime => mtime_of(&page.file.input_path),
		};
		let mut entry = format!(
			"<loc>{}</loc>",
			escape(&format!("{}{}", settings.base, page.file.url))
		);
		if let Some(lastmod) = lastmod {
			entry.push_str(&format!("<lastmod>{}</lastmod>", escape(&lastmod)));
		}
		if let Some(changefreq) = &settings.changefreq {
			entry.push_str(&format!("<changefreq>{}</changefreq>", escape(changefreq)));
		}
		if let Some(priority) = &settings.priority {
			entry.push_str(&format!("<priority>{}</priority>", escape(priority)));
		}
		entries.push((page.file.url.as_str(), entry));
	}
	entries.sort_by(|a, b| a.0.cmp(b.0));
	let mut xml = String::from(
		"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n",
	);
	for (_, entry) in entries {
		xml.push_str("<url>");
		xml.push_str(&entry);
		xml.push_str("</url>\n");
	}
	xml.push_str("</urlset>\n");
	xml
}
