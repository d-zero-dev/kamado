import { describe, expect, test } from 'vitest';

import { findExternalCrates } from './check-rust-no-external-crates.mjs';

describe('findExternalCrates', () => {
	test('workspace members and path dependencies (source: null) are accepted', () => {
		expect(
			findExternalCrates({
				packages: [
					{ name: 'kd_hash', version: '0.0.0', source: null },
					{ name: 'kd_napi', version: '0.0.0', source: null },
				],
			}),
		).toEqual([]);
	});

	test('a crate from the crates.io registry is reported', () => {
		expect(
			findExternalCrates({
				packages: [
					{ name: 'kd_hash', version: '0.0.0', source: null },
					{
						name: 'libc',
						version: '0.2.0',
						source: 'registry+https://github.com/rust-lang/crates.io-index',
					},
				],
			}),
		).toEqual([
			{
				name: 'libc',
				version: '0.2.0',
				source: 'registry+https://github.com/rust-lang/crates.io-index',
			},
		]);
	});

	test('a git dependency is reported', () => {
		expect(
			findExternalCrates({
				packages: [
					{ name: 'x', version: '1.0.0', source: 'git+https://example.com/x.git' },
				],
			}),
		).toHaveLength(1);
	});
});
