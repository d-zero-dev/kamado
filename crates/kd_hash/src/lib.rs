//! SHA-256 (FIPS 180-4), portable implementation with no dependencies.
//!
//! Why no hardware intrinsics: the portable path is the reference that
//! any accelerated path must match byte for byte, and it is fast enough for
//! the stat-first incremental check, which only hashes files whose
//! (size, mtime) changed.

const K: [u32; 64] = [
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const H0: [u32; 8] = [
	0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

/// Incremental SHA-256 hasher.
///
/// # Example
///
/// ```
/// let mut h = kd_hash::Sha256::new();
/// h.update(b"ab");
/// h.update(b"c");
/// assert_eq!(
///     kd_hash::to_hex(&h.finalize()),
///     "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
/// );
/// ```
pub struct Sha256 {
	state: [u32; 8],
	buf: [u8; 64],
	buf_len: usize,
	total_len: u64,
}

impl Default for Sha256 {
	fn default() -> Self {
		Self::new()
	}
}

impl Sha256 {
	#[must_use]
	pub const fn new() -> Self {
		Self {
			state: H0,
			buf: [0; 64],
			buf_len: 0,
			total_len: 0,
		}
	}

	pub fn update(&mut self, mut data: &[u8]) {
		self.total_len = self.total_len.wrapping_add(data.len() as u64);
		if self.buf_len > 0 {
			let take = (64 - self.buf_len).min(data.len());
			self.buf[self.buf_len..self.buf_len + take].copy_from_slice(&data[..take]);
			self.buf_len += take;
			data = &data[take..];
			if self.buf_len < 64 {
				return;
			}
			let block = self.buf;
			compress(&mut self.state, &block);
			self.buf_len = 0;
		}
		let (blocks, rest) = data.as_chunks::<64>();
		for block in blocks {
			compress(&mut self.state, block);
		}
		self.buf[..rest.len()].copy_from_slice(rest);
		self.buf_len = rest.len();
	}

	#[must_use]
	pub fn finalize(mut self) -> [u8; 32] {
		let bit_len = self.total_len.wrapping_mul(8);
		let mut pad = [0u8; 72];
		pad[0] = 0x80;
		let pad_len = if self.buf_len < 56 {
			56 - self.buf_len
		} else {
			120 - self.buf_len
		};
		pad[pad_len..pad_len + 8].copy_from_slice(&bit_len.to_be_bytes());
		// `update` would count the padding in `total_len`; the length is already captured.
		let total = self.total_len;
		self.update(&pad[..pad_len + 8]);
		self.total_len = total;
		let mut out = [0u8; 32];
		for (i, word) in self.state.iter().enumerate() {
			out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
		}
		out
	}
}

fn compress(state: &mut [u32; 8], block: &[u8; 64]) {
	let mut w = [0u32; 64];
	for (word, bytes) in w.iter_mut().zip(block.as_chunks::<4>().0) {
		*word = u32::from_be_bytes(*bytes);
	}
	for i in 16..64 {
		let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
		let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
		w[i] = w[i - 16]
			.wrapping_add(s0)
			.wrapping_add(w[i - 7])
			.wrapping_add(s1);
	}
	let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = *state;
	for i in 0..64 {
		let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
		let ch = (e & f) ^ (!e & g);
		let t1 = h
			.wrapping_add(s1)
			.wrapping_add(ch)
			.wrapping_add(K[i])
			.wrapping_add(w[i]);
		let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
		let maj = (a & b) ^ (a & c) ^ (b & c);
		let t2 = s0.wrapping_add(maj);
		h = g;
		g = f;
		f = e;
		e = d.wrapping_add(t1);
		d = c;
		c = b;
		b = a;
		a = t1.wrapping_add(t2);
	}
	for (s, v) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
		*s = s.wrapping_add(v);
	}
}

/// One-shot SHA-256.
///
/// # Example
///
/// ```
/// assert_eq!(
///     kd_hash::to_hex(&kd_hash::sha256(b"")),
///     "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
/// );
/// ```
#[must_use]
pub fn sha256(data: &[u8]) -> [u8; 32] {
	let mut h = Sha256::new();
	h.update(data);
	h.finalize()
}

/// Lowercase hex encoding.
#[must_use]
pub fn to_hex(bytes: &[u8]) -> String {
	const HEX: &[u8; 16] = b"0123456789abcdef";
	let mut s = String::with_capacity(bytes.len() * 2);
	for b in bytes {
		s.push(HEX[(b >> 4) as usize] as char);
		s.push(HEX[(b & 15) as usize] as char);
	}
	s
}

#[cfg(test)]
mod tests {
	use super::*;

	fn hex(data: &[u8]) -> String {
		to_hex(&sha256(data))
	}

	// FIPS 180-4 / NIST example vectors.
	#[test]
	fn nist_empty() {
		assert_eq!(
			hex(b""),
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
		);
	}

	#[test]
	fn nist_abc() {
		assert_eq!(
			hex(b"abc"),
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
		);
	}

	#[test]
	fn nist_448_bit() {
		assert_eq!(
			hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
			"248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
		);
	}

	#[test]
	fn nist_896_bit() {
		assert_eq!(
			hex(b"abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu"),
			"cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1"
		);
	}

	#[test]
	fn nist_million_a() {
		let mut h = Sha256::new();
		let chunk = [b'a'; 1000];
		for _ in 0..1000 {
			h.update(&chunk);
		}
		assert_eq!(
			to_hex(&h.finalize()),
			"cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
		);
	}

	#[test]
	fn split_updates_match_one_shot() {
		let data: Vec<u8> = (0..1000u32).map(|i| (i % 251) as u8).collect();
		for split in [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 999, 1000] {
			let mut h = Sha256::new();
			h.update(&data[..split]);
			h.update(&data[split..]);
			assert_eq!(h.finalize(), sha256(&data), "split at {split}");
		}
	}

	#[test]
	fn padding_boundaries() {
		// Lengths around the 55/56/64 byte padding boundaries must agree with a
		// byte-at-a-time hasher.
		for len in 0..200usize {
			let data = vec![0x5au8; len];
			let mut h = Sha256::new();
			for b in &data {
				h.update(std::slice::from_ref(b));
			}
			assert_eq!(h.finalize(), sha256(&data), "len {len}");
		}
	}
}
