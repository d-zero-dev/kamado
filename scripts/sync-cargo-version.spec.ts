import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import {
	setLockVersions,
	setWorkspaceVersion,
	syncCargoVersion,
} from './sync-cargo-version.mjs';

const TOML = '[workspace.package]\nversion = "0.0.0"\n';
const LOCK = '[[package]]\nname = "kd_hash"\nversion = "0.0.0"\n';

/**
 * A repository root with a lerna.json and the given Cargo files.
 * @param lerna
 * @param toml
 * @param lock
 */
function repo(lerna: string, toml: string, lock: string) {
	const root = mkdtempSync(path.join(tmpdir(), 'sync-cargo-'));
	writeFileSync(path.join(root, 'lerna.json'), `{ "version": "${lerna}" }`);
	writeFileSync(path.join(root, 'Cargo.toml'), toml);
	writeFileSync(path.join(root, 'Cargo.lock'), lock);
	return root;
}

describe('syncCargoVersion', () => {
	test('writes the lerna version into Cargo.toml and Cargo.lock', () => {
		const root = repo('3.0.0-alpha.1', TOML, LOCK);
		expect(syncCargoVersion(root, { check: false })).toEqual({
			version: '3.0.0-alpha.1',
			stale: ['Cargo.toml', 'Cargo.lock'],
		});
		expect(readFileSync(path.join(root, 'Cargo.toml'), 'utf8')).toBe(
			'[workspace.package]\nversion = "3.0.0-alpha.1"\n',
		);
		expect(readFileSync(path.join(root, 'Cargo.lock'), 'utf8')).toBe(
			'[[package]]\nname = "kd_hash"\nversion = "3.0.0-alpha.1"\n',
		);
	});

	test('check reports the files that differ and writes nothing', () => {
		const root = repo('3.0.0-alpha.1', TOML, LOCK);
		expect(syncCargoVersion(root, { check: true }).stale).toEqual([
			'Cargo.toml',
			'Cargo.lock',
		]);
		expect(readFileSync(path.join(root, 'Cargo.toml'), 'utf8')).toBe(TOML);
		expect(readFileSync(path.join(root, 'Cargo.lock'), 'utf8')).toBe(LOCK);
	});

	test('nothing is stale when the files already have the lerna version', () => {
		const root = repo('0.0.0', TOML, LOCK);
		expect(syncCargoVersion(root, { check: true })).toEqual({
			version: '0.0.0',
			stale: [],
		});
	});

	test('only the file that differs is reported', () => {
		const root = repo(
			'1.0.0',
			'[workspace.package]\nversion = "1.0.0"\n',
			'[[package]]\nname = "kd_hash"\nversion = "0.0.0"\n',
		);
		expect(syncCargoVersion(root, { check: true }).stale).toEqual(['Cargo.lock']);
	});
});

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

	test('a bracket in a comment or an array before the version does not hide it', () => {
		const toml = [
			'[workspace.package]',
			'# see [the docs]',
			'authors = ["a"]',
			'version = "0.0.0"',
			'',
		].join('\n');
		expect(setWorkspaceVersion(toml, '2.0.0')).toBe(
			[
				'[workspace.package]',
				'# see [the docs]',
				'authors = ["a"]',
				'version = "2.0.0"',
				'',
			].join('\n'),
		);
	});

	test('throws when the table has no version', () => {
		expect(() =>
			setWorkspaceVersion('[workspace.package]\nedition = "2024"\n', '1.0.0'),
		).toThrow(/no `version`/);
	});
});

describe('setLockVersions', () => {
	test('a package from a registry keeps its own version', () => {
		const lock = [
			'[[package]]',
			'name = "kd_hash"',
			'version = "0.0.0"',
			'',
			'[[package]]',
			'name = "libc"',
			'version = "0.2.0"',
			'source = "registry+https://github.com/rust-lang/crates.io-index"',
			'',
		].join('\n');
		expect(setLockVersions(lock, '1.2.3')).toBe(
			[
				'[[package]]',
				'name = "kd_hash"',
				'version = "1.2.3"',
				'',
				'[[package]]',
				'name = "libc"',
				'version = "0.2.0"',
				'source = "registry+https://github.com/rust-lang/crates.io-index"',
				'',
			].join('\n'),
		);
	});

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
