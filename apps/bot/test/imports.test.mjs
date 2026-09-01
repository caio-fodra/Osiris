import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// O eslint que este projeto nao tem, e mira uma classe so: import que falta. Deploy passa,
// `node --check` passa, os testes passam, e em producao o ReferenceError cai dentro do
// ctx.waitUntil, vira aviso generico e o gasto se perde.
//
// E analise de texto e nao de sintaxe: nome que apareca so em string conta como uso. Por
// isso a comparacao ignora comentarios.

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const arquivos = readdirSync(SRC).filter((f) => f.endsWith('.js'));

/** Tira comentarios de linha e de bloco, pra mencao em comentario nao contar como uso. */
const semComentarios = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const fonte = Object.fromEntries(arquivos.map((f) => [f, readFileSync(join(SRC, f), 'utf8')]));

const exportadosDe = (t) => new Set([...t.matchAll(/export (?:async function|function|const|class) (\w+)/g)].map((m) => m[1]));

describe('imports entre os modulos de apps/bot/src', () => {
	it.each(arquivos)('%s importa tudo que usa', (arquivo) => {
		const t = fonte[arquivo];
		// O corpo comeca depois do ultimo import: nome que aparece so na propria linha de
		// import nao conta como uso.
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
