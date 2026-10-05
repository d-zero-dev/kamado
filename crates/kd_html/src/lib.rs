//! HTML parsing, tree, selectors and printing for kamado.
//!
//! The modules are added one by one; see `docs/v3/RFC.md` §9 for what the
//! whole pipeline does.

pub mod dom;
pub mod entities;
mod entities_table;
pub mod parser;
pub mod serialize;
