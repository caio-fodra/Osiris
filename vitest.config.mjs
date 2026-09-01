import { defineConfig } from 'vitest/config';

// imports.test.mjs le o texto dos modulos de apps/bot/src e confere que todo simbolo
// usado esta importado. E o eslint que nao tem aqui.
export default defineConfig({
	test: {
		include: ['apps/bot/test/**/*.test.mjs'],
	},
});
