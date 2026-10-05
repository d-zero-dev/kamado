//! Hand-written Node-API binding (no napi-rs, no build script, no linker flags).
//!
//! The `napi_*` symbols are exported by the Node executable. Instead of
//! declaring them as undefined externs (which needs per-platform linker flags
//! such as `-undefined dynamic_lookup`), they are resolved once at load time
//! with `dlsym(RTLD_DEFAULT, ...)` into a function table.
//!
//! The addon is context-aware: Node calls `napi_register_module_v1` once per
//! environment (main thread and each worker), while process-wide state lives in
//! statics and is shared.
//!
//! This is the only crate that may contain `unsafe`.

#![allow(non_camel_case_types, clippy::missing_safety_doc)]

use std::ffi::{CStr, c_char, c_int, c_void};
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};

type napi_env = *mut c_void;
type napi_value = *mut c_void;
type napi_callback_info = *mut c_void;
type napi_status = c_int;
type napi_callback = unsafe extern "C" fn(napi_env, napi_callback_info) -> napi_value;

const NAPI_OK: napi_status = 0;

unsafe extern "C" {
	fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

#[cfg(target_os = "macos")]
const RTLD_DEFAULT: *mut c_void = -2isize as *mut c_void;
#[cfg(not(target_os = "macos"))]
const RTLD_DEFAULT: *mut c_void = std::ptr::null_mut();

struct Api {
	create_function: unsafe extern "C" fn(
		napi_env,
		*const c_char,
		usize,
		napi_callback,
		*mut c_void,
		*mut napi_value,
	) -> napi_status,
	set_named_property:
		unsafe extern "C" fn(napi_env, napi_value, *const c_char, napi_value) -> napi_status,
	create_string_utf8:
		unsafe extern "C" fn(napi_env, *const c_char, usize, *mut napi_value) -> napi_status,
	create_double: unsafe extern "C" fn(napi_env, f64, *mut napi_value) -> napi_status,
	get_cb_info: unsafe extern "C" fn(
		napi_env,
		napi_callback_info,
		*mut usize,
		*mut napi_value,
		*mut napi_value,
		*mut *mut c_void,
	) -> napi_status,
	get_buffer_info:
		unsafe extern "C" fn(napi_env, napi_value, *mut *mut c_void, *mut usize) -> napi_status,
	throw_error: unsafe extern "C" fn(napi_env, *const c_char, *const c_char) -> napi_status,
}

// Function pointers are plain addresses; the table is immutable after init.
unsafe impl Send for Api {}
unsafe impl Sync for Api {}

static API: OnceLock<Option<Api>> = OnceLock::new();
static CALLS: AtomicU64 = AtomicU64::new(0);

unsafe fn resolve<T: Copy>(name: &CStr) -> Option<T> {
	// SAFETY: `name` is NUL-terminated; RTLD_DEFAULT searches the global scope.
	let p = unsafe { dlsym(RTLD_DEFAULT, name.as_ptr()) };
	if p.is_null() {
		return None;
	}
	// SAFETY: the caller guarantees `T` is the correct fn-pointer type for this symbol.
	Some(unsafe { std::mem::transmute_copy::<*mut c_void, T>(&p) })
}

fn api() -> Option<&'static Api> {
	API.get_or_init(|| unsafe {
		Some(Api {
			create_function: resolve(c"napi_create_function")?,
			set_named_property: resolve(c"napi_set_named_property")?,
			create_string_utf8: resolve(c"napi_create_string_utf8")?,
			create_double: resolve(c"napi_create_double")?,
			get_cb_info: resolve(c"napi_get_cb_info")?,
			get_buffer_info: resolve(c"napi_get_buffer_info")?,
			throw_error: resolve(c"napi_throw_error")?,
		})
	})
	.as_ref()
}

/// Throws a JS `Error` and returns the NULL value a callback must return after throwing.
unsafe fn throw(api: &Api, env: napi_env, message: &CStr) -> napi_value {
	// SAFETY: `message` is NUL-terminated; a NULL code means "no code property".
	unsafe { (api.throw_error)(env, std::ptr::null(), message.as_ptr()) };
	std::ptr::null_mut()
}

unsafe fn string(api: &Api, env: napi_env, s: &str) -> napi_value {
	let mut out: napi_value = std::ptr::null_mut();
	// SAFETY: `s` is valid for `len` bytes; Node copies it.
	let status = unsafe { (api.create_string_utf8)(env, s.as_ptr().cast(), s.len(), &mut out) };
	debug_assert_eq!(status, NAPI_OK);
	out
}

/// `version()` -> string
unsafe extern "C" fn version(env: napi_env, _info: napi_callback_info) -> napi_value {
	let Some(api) = api() else {
		return std::ptr::null_mut();
	};
	// SAFETY: env is the live environment of this call.
	unsafe { string(api, env, concat!("kd_napi ", env!("CARGO_PKG_VERSION"))) }
}

/// `counter()` -> number. Process-wide: the same value sequence is observed
/// from the main thread and from every worker.
unsafe extern "C" fn counter(env: napi_env, _info: napi_callback_info) -> napi_value {
	let Some(api) = api() else {
		return std::ptr::null_mut();
	};
	let n = CALLS.fetch_add(1, Ordering::SeqCst) + 1;
	let mut out: napi_value = std::ptr::null_mut();
	// SAFETY: env is live.
	unsafe { (api.create_double)(env, n as f64, &mut out) };
	out
}

/// `sha256Hex(buffer)` -> string. Reads the Buffer's bytes in place (no copy).
unsafe extern "C" fn sha256_hex(env: napi_env, info: napi_callback_info) -> napi_value {
	let Some(api) = api() else {
		return std::ptr::null_mut();
	};
	let mut argc: usize = 1;
	let mut argv: [napi_value; 1] = [std::ptr::null_mut()];
	// SAFETY: argv has room for argc entries.
	let status = unsafe {
		(api.get_cb_info)(
			env,
			info,
			&mut argc,
			argv.as_mut_ptr(),
			std::ptr::null_mut(),
			std::ptr::null_mut(),
		)
	};
	if status != NAPI_OK || argc < 1 {
		// SAFETY: env is live.
		return unsafe { throw(api, env, c"sha256Hex: expected one Buffer argument") };
	}
	let mut data: *mut c_void = std::ptr::null_mut();
	let mut len: usize = 0;
	// SAFETY: argv[0] is a value handle valid for this call.
	let status = unsafe { (api.get_buffer_info)(env, argv[0], &mut data, &mut len) };
	if status != NAPI_OK {
		// SAFETY: env is live.
		return unsafe { throw(api, env, c"sha256Hex: argument must be a Buffer") };
	}
	let bytes: &[u8] = if len == 0 {
		&[]
	} else {
		// SAFETY: Node guarantees `data` points at `len` readable bytes while the
		// Buffer handle is alive, which spans this call.
		unsafe { std::slice::from_raw_parts(data.cast::<u8>(), len) }
	};
	let hex = kd_hash::to_hex(&kd_hash::sha256(bytes));
	// SAFETY: env is live.
	unsafe { string(api, env, &hex) }
}

unsafe fn export(api: &Api, env: napi_env, exports: napi_value, name: &CStr, cb: napi_callback) {
	let mut f: napi_value = std::ptr::null_mut();
	// SAFETY: name is NUL-terminated (length given as usize::MAX = NAPI_AUTO_LENGTH).
	unsafe {
		(api.create_function)(
			env,
			name.as_ptr(),
			usize::MAX,
			cb,
			std::ptr::null_mut(),
			&mut f,
		);
		(api.set_named_property)(env, exports, name.as_ptr(), f);
	}
}

/// Called by Node once per environment (main thread and each worker).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn napi_register_module_v1(env: napi_env, exports: napi_value) -> napi_value {
	let Some(api) = api() else { return exports };
	// SAFETY: env and exports are valid for the duration of this call.
	unsafe {
		export(api, env, exports, c"version", version);
		export(api, env, exports, c"counter", counter);
		export(api, env, exports, c"sha256Hex", sha256_hex);
	}
	exports
}

/// Declares the Node-API version this addon targets (8 = context-aware, stable).
#[unsafe(no_mangle)]
pub extern "C" fn node_api_module_get_api_version_v1() -> i32 {
	8
}
