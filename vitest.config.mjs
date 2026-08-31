import { defineConfig } from 'vitest/config';

// Vitest puro, sem o plugin da Cloudflare.
export default defineConfig({
	test: {
		include: ['apps/*/test/**/*.test.mjs'],
	},
});
