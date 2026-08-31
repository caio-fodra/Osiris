/* Orcamento: a conta entre o que voce gastou e o teto que voce mesmo definiu. */

import { brl, brlInt } from './fmt.js';
import { ultimoDia } from './parser.js';

/* Quanto do teto ja foi usado, em porcentagem inteira. Devolve null nos dois casos em que a
   pergunta nao faz sentido. */
export const usoPct = (gasto, teto) => (teto === null || teto === undefined || teto === 0 ? null : Math.round((gasto / teto) * 100));

/* A segunda linha da confirmacao de gasto, ou null quando nao ha o que dizer. Null e o caso comum e
   importante: */
export function linhaEstado(estado) {
	if (!estado) return null;
	const uso = usoPct(estado.gasto, estado.teto);
	if (uso === null) return null;
	const resta = estado.teto - estado.gasto;
	// 'gasto - teto' e nao '-resta': em exatamente 100% o resto e zero, e -0 formata como "-0,00" no
	// pt-BR.
	if (uso >= 100) return `${uso}% do orçamento · passou R$ ${brl(estado.gasto - estado.teto)}`;
	if (uso >= 80) return `${uso}% do orçamento · resta só R$ ${brl(resta)}`;
	return `${uso}% do orçamento · resta R$ ${brl(resta)}`;
}

/* Este lancamento foi o que cruzou o teto? E a pergunta inteira, e ela nao precisa de tabela de
   alertas enviados nem de coluna nova. */
export function cruzou(gasto, delta, teto) {
	if (teto === null || teto === undefined || teto <= 0) return false;
	if (!(delta > 0)) return false;
	return gasto - delta < teto && teto <= gasto;
}

/* O aviso de estouro, ou null. */
export function avisoEstouro(estado, delta, ym, hoje) {
	if (!estado || !cruzou(estado.gasto, delta, estado.teto)) return null;
	const linhas = [
		`Estourou o orçamento de ${estado.nome} em ${nomeDoMes(ym)}.`,
		`Gasto R$ ${brl(estado.gasto)} de R$ ${brl(estado.teto)} · passou R$ ${brl(estado.gasto - estado.teto)}`,
	];
	// A terceira linha so vale no mes corrente: em mes fechado "ainda faltam N dias" e mentira.
	if (ym === hoje.slice(0, 7)) {
		const faltam = ultimoDia(ym.slice(0, 4), +ym.slice(5, 7)) - +hoje.slice(8, 10);
		if (faltam > 0) linhas.push(`Ainda ${faltam === 1 ? 'falta 1 dia' : `faltam ${faltam} dias`} no mês.`);
	}
	return linhas.join('\n');
}

/* No ritmo atual, quanto o mes fecha. */
export function projecao(gasto, diaCorrido, diasNoMes) {
	if (diaCorrido < 7) return null;
	return Math.round((gasto / diaCorrido) * diasNoMes);
}

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

export const nomeDoMes = (ym) => `${MESES[+ym.slice(5, 7) - 1]}/${ym.slice(0, 4)}`;

/* Estado de uma categoria num mes: nome, teto e quanto ja foi gasto. */
export async function estadoDaCategoria(env, catId, ym) {
	if (!catId) return null;
	return env.DB.prepare(
		`select c.id,
            c.name as nome,
            c.budget_cents as teto,
            coalesce((select sum(t.amount_cents)
                        from transactions t
                       where t.category_id = c.id
                         and t.occurred_on like ?), 0) as gasto
       from categories c
      where c.id = ?`,
	)
		.bind(`${ym}%`, catId)
		.first();
}

/* Todas as categorias de um mes, com teto e gasto. O filtro de mes vai na condicao do left join e
   nao no where, e essa e a linha que faz esta tabela mostrar o que o dashboard nao consegue: */
export async function tabelaOrcamentos(env, ym) {
	const { results } = await env.DB.prepare(
		`select c.id, c.name as nome, c.budget_cents as teto,
            coalesce(sum(t.amount_cents), 0) as gasto,
            count(t.id) as n
       from categories c
       left join transactions t
         on t.category_id = c.id
        and t.occurred_on like ?
      group by c.id, c.budget_cents
      order by c.budget_cents is null, gasto desc, c.name`,
	)
		.bind(`${ym}%`)
		.all();
	return results;
}

/* A celula da coluna 'teto' do /relatorio: a porcentagem do teto, e so acima de 80%. */
export function celulaTeto(gasto, teto) {
	const uso = usoPct(gasto, teto);
	return uso === null || uso < 80 ? '' : `${uso}%`;
}

/* Monta as linhas da tabela do /orcamento. Devolve array de strings pro bloco(). */
export function linhasDoOrcamento(cats, ym, hoje) {
	const comTeto = cats.filter((c) => c.teto !== null);
	const semTeto = cats.filter((c) => c.teto === null);

	// Largura do nome pelos dados, com piso 11 e teto de 14: nome longo faria a linha quebrar no
	// celular, e tabela quebrada e pior que nome truncado.
	const larg = Math.min(14, Math.max(11, ...cats.map((c) => c.nome.length)));
	const corta = (s) => (s.length > larg ? s.slice(0, larg - 1) + '…' : s.padEnd(larg));

	const linha = (nome, gasto, teto) => {
		const uso = usoPct(gasto, teto);
		const marca = teto !== null && teto > 0 && gasto >= teto ? ' !' : '';
		return `${corta(nome)} ${brlInt(gasto).padStart(7)} ${teto === null ? '      —' : brlInt(teto).padStart(7)} ${
			uso === null ? '   —' : `${uso}%`.padStart(4)
		}${marca}`;
	};

	const out = [`${nomeDoMes(ym)}`, '', `${''.padEnd(larg)} ${'gasto'.padStart(7)} ${'teto'.padStart(7)} ${'uso'.padStart(4)}`];

	for (const c of comTeto) out.push(linha(c.nome, c.gasto, c.teto));

	const totalGasto = comTeto.reduce((s, c) => s + c.gasto, 0);
	const totalTeto = comTeto.reduce((s, c) => s + c.teto, 0);
	if (comTeto.length) {
		out.push('', linha('total', totalGasto, totalTeto));

		if (ym === hoje.slice(0, 7)) {
			const diaCorrido = +hoje.slice(8, 10);
			const proj = projecao(totalGasto, diaCorrido, ultimoDia(ym.slice(0, 4), +ym.slice(5, 7)));
			if (proj !== null) out.push(linha('ritmo', proj, totalTeto));
		}
	}

	if (semTeto.length) out.push('', `sem teto: ${semTeto.map((c) => c.nome).join(', ')}`);
	if (!comTeto.length) out.push('', 'Nenhuma categoria tem teto. Defina com: /orcamento mercado 800');

	return out;
}
