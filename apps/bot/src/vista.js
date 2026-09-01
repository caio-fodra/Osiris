// Como uma transacao aparece no chat. Nao toca banco.
// Importa fmt/parser/orcamento; nunca handle.js, que importa daqui.

import { brl, dia } from './fmt.js';
import { LABEL, rotulo } from './parser.js';
import { linhaEstado } from './orcamento.js';

function emLinhas(botoes, porLinha = 2) {
	const linhas = [];
	for (let i = 0; i < botoes.length; i += porLinha) linhas.push(botoes.slice(i, i + porLinha));
	return linhas;
}

export const corpo = (cents, estado, method, iso) =>
	[resumo(cents, estado?.nome, method, iso), linhaEstado(estado)].filter(Boolean).join('\n');

export function resumo(cents, catNome, method, iso) {
	return `R$ ${brl(cents)} · ${catNome ?? 'sem categoria'}` + ` · ${rotulo(method) ?? 'sem método'} · ${dia(iso)}`;
}

// Unico lugar que define os verbos de callback_data.
export const ACAO = { CAT: 'cat', PAY: 'pay', DEL: 'del', EXT: 'ext' };

// So as acoes que falam de uma transacao so: nelas o segundo campo do callback_data e
// um id. O 'ext' carrega o mes e e tratado antes. Set pelo motivo do hasOwn em parser.js.
export const ACOES = new Set([ACAO.CAT, ACAO.PAY, ACAO.DEL]);

// Recebe o estado ja lido, entao onMessage e onCallback chegam ao mesmo teclado.
// 'apagar' entra sempre, e a unica forma de desfazer. O filter no fim e rede: o Telegram
// recusa inline_keyboard com linha vazia e a mensagem inteira falha com 400.
export function teclado(txId, temCategoria, temMetodo, cats = []) {
	const linhas = [];
	if (!temCategoria) {
		linhas.push(...emLinhas(cats.map((c) => ({ text: c.name, callback_data: `${ACAO.CAT}:${txId}:${c.id}` }))));
	}
	if (!temMetodo) {
		linhas.push(
			...emLinhas(
				Object.keys(LABEL).map((m) => ({ text: LABEL[m], callback_data: `${ACAO.PAY}:${txId}:${m}` })),
				4,
			),
		);
	}
	linhas.push([{ text: 'apagar', callback_data: `${ACAO.DEL}:${txId}:` }]);
	return linhas.filter((l) => l.length);
}
