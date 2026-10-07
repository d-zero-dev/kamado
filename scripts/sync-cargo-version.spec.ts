import { describe, expect, test } from 'vitest';

import { setLockVersions, setWorkspaceVersion } from './sync-cargo-version.mjs';

describe('setWorkspaceVersion', () => {
	test('replaces only the version of [workspace.package]', () => {
		const toml = [
			'[workspace]',
			'members = ["crates/*"]',
			'',
			'[workspace.package]',
			'# comment',
			'version = "0.0.0"',
			'edition = "2024"',
			'',
		].join('\n');
		expect(setWorkspaceVersion(toml, '3.0.0-alpha.1')).toBe(
			[
				'[workspace]',
				'members = ["crates/*"]',
				'',
				'[workspace.package]',
				'# comment',
				'version = "3.0.0-alpha.1"',
				'edition = "2024"',
				'',
			].join('\n'),
		);
	});

	test('does not touch a version outside the table', () => {
		const toml =
			'[workspace.package]\nversion = "1.0.0"\n\n[profile.release]\nversion = "x"\n';
		expect(setWorkspaceVersion(toml, '2.0.0')).toBe(
			'[workspace.package]\nversion = "2.0.0"\n\n[profile.release]\nversion = "x"\n',
		);
	});

	test('throws when the table has no version', () => {
		expect(() =>
			setWorkspaceVersion('[workspace.package]\nedition = "2024"\n', '1.0.0'),
		).toThrow(/no `version`/);
	});
});

describe('setLockVersions', () => {
	test('replaces the version of every package and keeps the dependencies', () => {
		const lock = [
			'version = 4',
			'',
			'[[package]]',
			'name = "kd_build"',
			'version = "0.0.0"',
			'dependencies = [',
			' "kd_config",',
			']',
			'',
			'[[package]]',
			'name = "kd_config"',
			'version = "0.0.0"',
			'',
		].join('\n');
		expect(setLockVersions(lock, '3.0.0-alpha.1')).toBe(
			[
				'version = 4',
				'',
				'[[package]]',
				'name = "kd_build"',
				'version = "3.0.0-alpha.1"',
				'dependencies = [',
				' "kd_config",',
				']',
				'',
				'[[package]]',
				'name = "kd_config"',
				'version = "3.0.0-alpha.1"',
				'',
			].join('\n'),
		);
	});
});
