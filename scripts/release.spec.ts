import { describe, expect, test } from 'vitest';

import { isReleaseCommit, releaseSubject } from './release.mjs';

describe('releaseSubject', () => {
	test('is the subject that lerna gives the release commit', () => {
		expect(releaseSubject('3.0.0-alpha.1')).toBe(
			'chore(release): publish v3.0.0-alpha.1',
		);
	});
});

describe('isReleaseCommit', () => {
	const release = {
		subject: 'chore(release): publish v3.0.0-alpha.1',
		head: 'aaaa',
		tagTarget: 'aaaa',
		version: '3.0.0-alpha.1',
	};

	test('the release commit with the tag of its version on it', () => {
		expect(isReleaseCommit(release)).toBe(true);
	});

	test('a commit with another subject is not a release commit', () => {
		expect(isReleaseCommit({ ...release, subject: 'feat(kamado): add a thing' })).toBe(
			false,
		);
	});

	test('a release commit of another version is not the one', () => {
		expect(isReleaseCommit({ ...release, version: '3.0.0-alpha.2' })).toBe(false);
	});

	test('a missing tag means lerna did not release', () => {
		expect(isReleaseCommit({ ...release, tagTarget: undefined })).toBe(false);
	});

	test('a tag on another commit means HEAD is not the released commit', () => {
		expect(isReleaseCommit({ ...release, tagTarget: 'bbbb' })).toBe(false);
	});
});
