//! HTML parsing, tree, selectors and printing for kamado.
//!
//! The modules are added one by one; see `docs/v3/RFC.md` §9 for what the
//! whole pipeline does.

pub mod dom;
pub mod entities;
mod entities_table;
pub mod includes;
pub mod inject;
pub mod page;
pub mod parser;
pub mod pattern;
pub mod rules;
pub mod selector;
pub mod serialize;
