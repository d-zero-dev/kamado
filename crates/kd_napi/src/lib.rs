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

mod alloc;
mod serve;
mod session;

/// Every allocation of the addon (the core included) goes through the pools.
#[global_allocator]
static GLOBAL: alloc::PoolAlloc = alloc::PoolAlloc;

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
	get_value_string_utf8:
		unsafe extern "C" fn(napi_env, napi_value, *mut c_char, usize, *mut usize) -> napi_status,
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
			get_value_string_utf8: resolve(c"napi_get_value_string_utf8")?,
		})
	})
	.as_ref()
}

/// Copies a JS string argument into a Rust `String`. `None` when the value
/// is not a string.
unsafe fn string_arg(api: &Api, env: napi_env, value: napi_value) -> Option<String> {
	let mut len: usize = 0;
	// SAFETY: a NULL buffer asks only for the length (in bytes, without NUL).
	let status =
		unsafe { (api.get_value_string_utf8)(env, value, std::ptr::null_mut(), 0, &mut len) };
	if status != NAPI_OK {
		return None;
	}
	let mut buf = vec![0u8; len + 1];
	let mut written: usize = 0;
	// SAFETY: `buf` has room for `len` bytes plus the NUL terminator.
	let status = unsafe {
		(api.get_value_string_utf8)(env, value, buf.as_mut_ptr().cast(), buf.len(), &mut written)
	};
	if status != NAPI_OK {
		return None;
	}
	buf.truncate(written);
	String::from_utf8(buf).ok()
}

/// Reads up to `N` arguments of the current call.
unsafe fn args<const N: usize>(
	api: &Api,
	env: napi_env,
	info: napi_callback_info,
) -> ([napi_value; N], usize) {
	let mut argc: usize = N;
	let mut argv: [napi_value; N] = [std::ptr::null_mut(); N];
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
	if status != NAPI_OK {
		return (argv, 0);
	}
	(argv, argc.min(N))
}

fn build_options_from_json(json: &str) -> Result<kd_core::BuildOptions, String> {
	let value = kd_jsonc::parse(json).map_err(|e| format!("build options: {e}"))?;
	let b = |key: &str| -> Result<bool, String> {
		match value.get(key) {
			None | Some(kd_jsonc::Value::Null) => Ok(false),
			Some(kd_jsonc::Value::Bool(v)) => Ok(*v),
			Some(_) => Err(format!("build options: {key} must be a boolean")),
		}
	};
	let targets = match value.get("targets") {
		None | Some(kd_jsonc::Value::Null) => Vec::new(),
		Some(kd_jsonc::Value::Array(items)) => items
			.iter()
			.map(|i| {
				i.as_str()
					.map(str::to_string)
					.ok_or_else(|| "build options: targets must be strings".to_string())
			})
			.collect::<Result<_, _>>()?,
		Some(_) => return Err("build options: targets must be an array".to_string()),
	};
	let jobs = match value.get("jobs") {
		None | Some(kd_jsonc::Value::Null) => None,
		Some(kd_jsonc::Value::Number(n)) if n.fract() == 0.0 && *n >= 1.0 => Some(*n as usize),
		Some(_) => return Err("build options: jobs must be a positive integer".to_string()),
	};
	let cache_dir = match value.get("cacheDir") {
		None | Some(kd_jsonc::Value::Null) => None,
		Some(kd_jsonc::Value::String(s)) => Some(s.clone()),
		Some(_) => return Err("build options: cacheDir must be a string".to_string()),
	};
	let tz_offset_minutes = match value.get("tzOffsetMinutes") {
		None | Some(kd_jsonc::Value::Null) => 0,
		Some(kd_jsonc::Value::Number(n)) if n.fract() == 0.0 && n.abs() <= 1440.0 => *n as i32,
		Some(_) => {
			return Err("build options: tzOffsetMinutes must be an integer of minutes".to_string());
		}
	};
	let esbuild_version = match value.get("esbuildVersion") {
		None | Some(kd_jsonc::Value::Null) => None,
		Some(kd_jsonc::Value::String(s)) => Some(s.clone()),
		Some(_) => return Err("build options: esbuildVersion must be a string".to_string()),
	};
	let esbuild_binary = match value.get("esbuildBinary") {
		None | Some(kd_jsonc::Value::Null) => None,
		Some(kd_jsonc::Value::String(s)) => Some(s.clone()),
		Some(_) => return Err("build options: esbuildBinary must be a string".to_string()),
	};
	Ok(kd_core::BuildOptions {
		incremental: b("incremental")?,
		force: b("force")?,
		skip_unchanged: b("skipUnchanged")?,
		targets,
		jobs,
		cache_dir,
		tz_offset_minutes,
		esbuild_version,
		esbuild_binary,
		serving: b("serving")?,
	})
}

/// `build(configPath, optionsJson)` -> report JSON string. Throws on any
/// configuration or build error.
unsafe extern "C" fn build(env: napi_env, info: napi_callback_info) -> napi_value {
	let Some(api) = api() else {
		return std::ptr::null_mut();
	};
	// SAFETY: env/info belong to this call.
	let (argv, argc) = unsafe { args::<2>(api, env, info) };
	let config_path = if argc >= 1 {
		unsafe { string_arg(api, env, argv[0]) }
	} else {
		None
	};
	let Some(config_path) = config_path else {
		return unsafe { throw(api, env, c"build: expected a config path string") };
	};
	let options_json = if argc >= 2 {
		unsafe { string_arg(api, env, argv[1]) }.unwrap_or_else(|| "{}".to_string())
	} else {
		"{}".to_string()
	};
	let outcome = build_options_from_json(&options_json).and_then(|options| {
		kd_core::load(&config_path).and_then(|loaded| kd_core::build(&loaded, &options))
	});
	match outcome {
		Ok(report) => unsafe { string(api, env, &report.to_json()) },
		Err(message) => {
			let message = std::ffi::CString::new(message.replace('\0', " ")).unwrap_or_default();
			unsafe { throw(api, env, &message) }
		}
	}
}

/// Reads the `N` string arguments of the call; `None` if one is missing or
/// not a string.
unsafe fn string_args<const N: usize>(
	api: &Api,
	env: napi_env,
	info: napi_callback_info,
) -> Option<[String; N]> {
	// SAFETY: env/info belong to this call.
	let (argv, argc) = unsafe { args::<N>(api, env, info) };
	if argc < N {
		return None;
	}
	let mut out: [String; N] = std::array::from_fn(|_| String::new());
	for (slot, value) in out.iter_mut().zip(argv) {
		// SAFETY: `value` is an argument handle valid for this call.
		*slot = unsafe { string_arg(api, env, value) }?;
	}
	Some(out)
}

/// Turns a build error into a thrown JS `Error`.
unsafe fn throw_message(api: &Api, env: napi_env, message: String) -> napi_value {
	let message = std::ffi::CString::new(message.replace('\0', " ")).unwrap_or_default();
	// SAFETY: env is live.
	unsafe { throw(api, env, &message) }
}

/// `prepare(configPath, optionsJson, runtimeUrl)` -> JSON with the handle, the
/// render jobs and the context. Throws on any configuration or plan error.
unsafe extern "C" fn prepare(env: napi_env, info: napi_callback_info) -> napi_value {
	let Some(api) = api() else {
		return std::ptr::null_mut();
	};
	// SAFETY: env/info belong to this call.
	let Some([config, options, runtime]) = (unsafe { string_args::<3>(api, env, info) }) else {
		return unsafe {
			throw(
				api,
				env,
				c"prepare: expected (configPath, optionsJson, runtimeUrl) strings",
			)
		};
	};
	match session::prepare(&config, &options, &runtime) {
		Ok(json) => unsafe { string(api, env, &json) },
		Err(message) => unsafe { throw_message(api, env, message) },
	}
}

/// `finish(handle, renderedJson)` -> report JSON.
unsafe extern "C" fn finish(env: napi_env, info: napi_callback_info) -> napi_value {
	let Some(api) = api() else {
		return std::ptr::null_mut();
	};
	// SAFETY: env/info belong to this call.
	let Some([handle, rendered]) = (unsafe { string_args::<2>(api, env, info) }) else {
		return unsafe { throw(api, env, c"finish: expected (handle, renderedJson) strings") };
	};
	match session::finish(&handle, &rendered) {
		Ok(json) => unsafe { string(api, env, &json) },
		Err(message) => unsafe { throw_message(api, env, message) },
	}
}

/// `abort(handle)`: forgets a prepared build.
unsafe extern "C" fn abort(env: napi_env, info: napi_callback_info) -> napi_value {
	let Some(api) = api() else {
		return std::ptr::null_mut();
	};
	// SAFETY: env/info belong to this call.
	if let Some([handle]) = unsafe { string_args::<1>(api, env, info) } {
		session::abort(&handle);
	}
	std::ptr::null_mut()
}

/// Calls `f` with the `N` string arguments of the call and returns its string
/// result; an error becomes a thrown JS `Error`, wrong arguments throw `usage`.
unsafe fn string_call<const N: usize>(
	env: napi_env,
	info: napi_callback_info,
	usage: &CStr,
	f: impl FnOnce([String; N]) -> Result<String, String>,
) -> napi_value {
	let Some(api) = api() else {
		return std::ptr::null_mut();
	};
	// SAFETY: env/info belong to this call.
	let Some(args) = (unsafe { string_args::<N>(api, env, info) }) else {
		return unsafe { throw(api, env, usage) };
	};
	match f(args) {
		Ok(text) => unsafe { string(api, env, &text) },
		Err(message) => unsafe { throw_message(api, env, message) },
	}
}

/// `serveOpen(configPath, optionsJson, runtimeUrl)` -> JSON with the handle and
/// what the HTTP side needs to know.
unsafe extern "C" fn serve_open(env: napi_env, info: napi_callback_info) -> napi_value {
	// SAFETY: env/info belong to this call.
	unsafe {
		string_call::<3>(
			env,
			info,
			c"serveOpen: expected (configPath, optionsJson, runtimeUrl) strings",
			|[config, options, runtime]| serve::open(&config, &options, &runtime),
		)
	}
}

/// `serveRequest(handle, urlPath, rendererStarted)` -> JSON answer
/// (`rendererStarted` is `"1"` or `"0"`).
unsafe extern "C" fn serve_request(env: napi_env, info: napi_callback_info) -> napi_value {
	// SAFETY: env/info belong to this call.
	unsafe {
		string_call::<3>(
			env,
			info,
			c"serveRequest: expected (handle, urlPath, rendererStarted) strings",
			|[handle, path, started]| serve::request(&handle, &path, &started),
		)
	}
}

/// `serveFinishRender(handle, token, html)` -> JSON answer.
unsafe extern "C" fn serve_finish_render(env: napi_env, info: napi_callback_info) -> napi_value {
	// SAFETY: env/info belong to this call.
	unsafe {
		string_call::<3>(
			env,
			info,
			c"serveFinishRender: expected (handle, token, html) strings",
			|[handle, token, html]| serve::finish_render(&handle, &token, &html),
		)
	}
}

/// `serveFinishScript(handle, token, outputJson)` -> JSON answer.
unsafe extern "C" fn serve_finish_script(env: napi_env, info: napi_callback_info) -> napi_value {
	// SAFETY: env/info belong to this call.
	unsafe {
		string_call::<3>(
			env,
			info,
			c"serveFinishScript: expected (handle, token, outputJson) strings",
			|[handle, token, output]| serve::finish_script(&handle, &token, &output),
		)
	}
}

/// `serveCancel(handle, token)`: the JavaScript behind an answer failed.
unsafe extern "C" fn serve_cancel(env: napi_env, info: napi_callback_info) -> napi_value {
	// SAFETY: env/info belong to this call.
	unsafe {
		string_call::<2>(
			env,
			info,
			c"serveCancel: expected (handle, token) strings",
			|[handle, token]| serve::cancel(&handle, &token).map(|()| String::new()),
		)
	}
}

/// `serveClose(handle)`: forgets a dev server.
unsafe extern "C" fn serve_close(env: napi_env, info: napi_callback_info) -> napi_value {
	let Some(api) = api() else {
		return std::ptr::null_mut();
	};
	// SAFETY: env/info belong to this call.
	if let Some([handle]) = unsafe { string_args::<1>(api, env, info) } {
		serve::close(&handle);
	}
	std::ptr::null_mut()
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
		export(api, env, exports, c"build", build);
		export(api, env, exports, c"prepare", prepare);
		export(api, env, exports, c"finish", finish);
		export(api, env, exports, c"abort", abort);
		export(api, env, exports, c"serveOpen", serve_open);
		export(api, env, exports, c"serveRequest", serve_request);
		export(api, env, exports, c"serveFinishRender", serve_finish_render);
		export(api, env, exports, c"serveFinishScript", serve_finish_script);
		export(api, env, exports, c"serveCancel", serve_cancel);
		export(api, env, exports, c"serveClose", serve_close);
	}
	exports
}

/// Declares the Node-API version this addon targets (8 = context-aware, stable).
#[unsafe(no_mangle)]
pub extern "C" fn node_api_module_get_api_version_v1() -> i32 {
	8
}
