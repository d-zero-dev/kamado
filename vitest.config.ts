import os from 'node:os';
import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		env: {
			// A test that starts `kamado ui` without naming a settings file must not read, and
			// must not put aside, the real `~/.config/kamado/ui-settings.json` of whoever runs it.
			// Naming the file in each test is not enough: one that forgets would damage a real file.
			//
			// One fixed place: the file is made only by a test that saves, and a directory that
			// changed per run would pile up in the temporary directory. Every worker shares it, so
			// a test that needs its own state names its own file (the lock keeps the shared one whole).
			KAMADO_UI_SETTINGS: path.join(
				os.tmpdir(),
				'kamado-vitest-ui-settings',
				'ui-settings.json',
			),
		},
	},
});
