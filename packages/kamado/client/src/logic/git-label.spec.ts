import { describe, expect, test } from 'vitest';

import { gitLabel } from './git-label.js';

describe('gitLabel', () => {
	test('is the branch and the commit', () => {
		expect(gitLabel({ branch: 'feature/foo', sha: '51df987' })).toBe(
			'feature/foo @ 51df987',
		);
	});

	test('is the commit alone for a detached HEAD', () => {
		expect(gitLabel({ branch: null, sha: '51df987' })).toBe('51df987');
	});

	test('is nothing when there is no repository to show', () => {
		expect(gitLabel(null)).toBe('');
	});
});
