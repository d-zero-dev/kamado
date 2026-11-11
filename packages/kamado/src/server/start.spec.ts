import { beforeEach, describe, expect, test, vi } from 'vitest';

const serveOpen =
	vi.fn<(configPath: string, optionsJson: string, runtime: string) => string>();

vi.mock('../native.js', () => ({
	native: () => ({ serveOpen }),
}));

const { start } = await import('./start.js');

describe('start', () => {
	beforeEach(() => {
		serveOpen.mockReset();
	});

	test('refuses an unknown option before the core is called', async () => {
		await expect(
			start('/site/kamado.config.jsonc', { typo: true } as never),
		).rejects.toThrow('unknown option: typo');
		expect(serveOpen).not.toHaveBeenCalled();
	});
});
