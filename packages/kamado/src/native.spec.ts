import { describe, expect, test } from 'vitest';

import { bundledAddon } from './native.js';

describe('bundledAddon', () => {
	test.each([
		['darwin', 'arm64', '/app/node_modules/kamado/native/darwin-arm64/kd_napi.node'],
		['darwin', 'x64', '/app/node_modules/kamado/native/darwin-x64/kd_napi.node'],
		['linux', 'x64', '/app/node_modules/kamado/native/linux-x64/kd_napi.node'],
		['linux', 'arm64', '/app/node_modules/kamado/native/linux-arm64/kd_napi.node'],
	])('%s %s is %s', (platform, arch, expected) => {
		expect(bundledAddon('/app/node_modules/kamado', platform, arch)).toBe(expected);
	});
});
