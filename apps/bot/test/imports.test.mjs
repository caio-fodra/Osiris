import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Este teste existe por causa de um erro que aconteceu tres vezes numa tarde: uma funcao nova era
// usada num arquivo e o import dela nao entrava.

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const arquivos = readdirSync(SRC).filter((f) => f.endsWith('.js'));

/* Tira comentarios de linha e de bloco, pra mencao em comentario nao contar como uso. */
const semComentarios = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const fonte = Object.fromEntries(arquivos.map((f) => [f, readFileSync(join(SRC, f), 'utf8')]));

const exportadosDe = (t) => new Set([...t.matchAll(/export (?:async function|function|const|class) (\w+)/g)].map((m) => m[1]));

describe('imports entre os modulos de apps/bot/src', () => {
	it.each(arquivos)('%s importa tudo que usa', (arquivo) => {
		const t = fonte[arquivo];
		// O corpo comeca depois do ultimo import: nome que aparece so na propria linha de import nao
		// conta como uso.
		const ultimoImport = t.lastIndexOf('\nimport ');
		const corpo = semComentarios(ultimoImport === -1 ? t : t.slice(t.indexOf('\n', ultimoImport + 1)));

		const faltando = [];
		for (const outro of arquivos) {
			if (outro === arquivo) continue;
			const mod = outro.replace(/\.js$/, '');
			const m = t.match(new RegExp(String.raw`import \{([^}]*)\} from '\./${mod}\.js'`, 's'));
			const importados = new Set(
				(m?.[1] ?? '')
					.split(',')
					.map((x) => x.trim())
					.filter(Boolean),
			);
			for (const nome of exportadosDe(fonte[outro])) {
				if (importados.has(nome)) continue;
				if (new RegExp(String.raw`\b${nome}\s*\(`).test(corpo) || new RegExp(String.raw`\b${nome}\.`).test(corpo)) {
					faltando.push(`${nome} (de ${outro})`);
				}
			}
		}

		expect(faltando).toEqual([]);
	});
});
