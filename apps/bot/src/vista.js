/* Apresentacao: como uma transacao aparece no chat. */

import { brl, dia } from './fmt.js';
import { LABEL, rotulo } from './parser.js';
import { linhaEstado } from './orcamento.js';

// Quebra a lista em linhas de no maximo dois botoes.
export function emLinhas(botoes, porLinha = 2) {
	const linhas = [];
	for (let i = 0; i < botoes.length; i += porLinha) linhas.push(botoes.slice(i, i + porLinha));
	return linhas;
}

// Uma linha so, igual na confirmacao e depois de cada botao, pra o usuario ver sempre o estado
// atual da transacao.
/* A confirmacao inteira: o resumo de sempre, mais a linha de orcamento quando ha o que dizer. */
export const corpo = (cents, estado, method, iso) =>
	[resumo(cents, estado?.nome, method, iso), linhaEstado(estado)].filter(Boolean).join('\n');

export function resumo(cents, catNome, method, iso) {
	return `R$ ${brl(cents)} · ${catNome ?? 'sem categoria'}` + ` · ${rotulo(method) ?? 'sem método'} · ${dia(iso)}`;
}

/* O vocabulario de acao de botao, em UM lugar. teclado() produz, onCallback valida e o teste
   confere. */
export const ACAO = { CAT: 'cat', PAY: 'pay', DEL: 'del', EXT: 'ext' };

// Set e nao objeto literal: a acao vem de fora e num objeto literal 'constructor' acharia valor
// herdado do prototipo.
export const ACOES = new Set([ACAO.CAT, ACAO.PAY, ACAO.DEL]);

/* Monta o teclado com o que ainda falta preencher na transacao. Recebe o estado ja lido em vez de
   ler do banco de novo: */
export function teclado(txId, temCategoria, temMetodo, cats = []) {
	const linhas = [];
	if (!temCategoria) {
		linhas.push(...emLinhas(cats.map((c) => ({ text: c.name, callback_data: `${ACAO.CAT}:${txId}:${c.id}` }))));
	}
	if (!temMetodo) {
		// Passa pelo mesmo emLinhas das categorias, com porLinha=4. Saida byte a byte identica hoje (sao
		// exatamente quatro metodos), mas um quinto metodo passa a quebrar linha em vez de esparramar
		// numa fileira de cinco ao lado de fileiras de dois.
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
