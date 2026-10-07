//! HTML parsing, tree, selectors and printing for kamado.
//!
//! See `docs/v3/RFC.md` §9 for what the whole pipeline does.

mod cp932_table;
pub mod dom;
pub mod encode;
pub mod entities;
mod entities_table;
pub mod image_sizes;
pub mod includes;
pub mod inject;
pub mod minify;
pub mod page;
pub mod parser;
pub mod pattern;
pub mod print;
pub mod rules;
pub mod selector;
pub mod serialize;
