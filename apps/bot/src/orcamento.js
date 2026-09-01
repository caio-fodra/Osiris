// Gasto contra teto por categoria. Modulo separado do handle.js por causa de ciclo: o
// report.js precisa de teto e o handle.js ja importa o report.js.
import { brl, brlInt } from './fmt.js';
import { ultimoDia } from './parser.js';

// null tanto sem teto quanto com teto zero, e quem renderiza distingue os dois: o
// /orcamento grava NULL quando o usuario manda 0. Sem a guarda, teto zero imprime Infinity%.
export const usoPct = (gasto, teto) => (teto === null || teto === undefined || teto === 0 ? null : Math.round((gasto / teto) * 100));

// A segunda linha da confirmacao de gasto, ou null quando nao ha o que dizer.
export function linhaEstado(estado) {
	if (!estado) return null;
	const uso = usoPct(estado.gasto, estado.teto);
	if (uso === null) return null;
	const resta = estado.teto - estado.gasto;
	// 'gasto - teto' e nao '-resta': em 100% exatos o resto e zero, e -0 formata como
	// '-0,00' no pt-BR. O ramo sai do valor cru pq usoPct arredonda, e 99,6% do teto virava
	// uso=100 imprimindo "passou R$ -4,00" num mes com folga.
	if (estado.gasto >= estado.teto) return `${uso}% do orçamento · passou R$ ${brl(estado.gasto - estado.teto)}`;
	if (uso >= 80) return `${uso}% do orçamento · resta só R$ ${brl(resta)}`;
	return `${uso}% do orçamento · resta R$ ${brl(resta)}`;
}

/**
 * Este lancamento foi o que cruzou o teto? Como o gasto que chega ja e o total depois, o
 * de antes e 'gasto - delta', e isso avisa uma vez por cruzamento sem tabela de alertas.
 * Serve pra lancamento retroativo tambem, pq o mes comparado e o do occurred_on.
 * @param {number} gasto  total da categoria no mes, em centavos, ja com o delta
 * @param {number} delta  o quanto este lancamento somou; <= 0 nunca cruza pra cima
 * @param {number} teto   budget_cents da categoria
 */
export function cruzou(gasto, delta, teto) {
	if (teto === null || teto === undefined || teto <= 0) return false;
	if (!(delta > 0)) return false;
	return gasto - delta < teto && teto <= gasto;
}

// Mensagem separada da confirmacao: a confirmacao e reescrita por editMessageText a cada
// clique de botao, e um aviso grudado nela seria repetido ou perdido.
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

// null antes do dia 7: as fixas se concentram no comeco do mes, entao no dia 3 a media
// diaria e dominada por elas e a projecao cospe um numero absurdo.
export function projecao(gasto, diaCorrido, diasNoMes) {
	if (diaCorrido < 7) return null;
	return Math.round((gasto / diaCorrido) * diasNoMes);
}

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

export const nomeDoMes = (ym) => `${MESES[+ym.slice(5, 7) - 1]}/${ym.slice(0, 4)}`;

// Uma query e nao duas: a subconsulta correlacionada soma o mes junto com o select do
// nome. Isto roda em todo lancamento categorizado, e o D1 cobra latencia por chamada.
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

// O filtro de mes vai na condicao do left join e nao no where: no where o left join
// degenera em inner join e categoria com teto e zero gasto no mes some da tabela.
// order by 'budget_cents is null' joga as sem teto pro fim.
export async function tabelaOrcamentos(env, ym) {
	const { results } = await env.DB.prepare(
		`select c.id, c.name as nome, c.budget_cents as teto,
            coalesce(sum(t.amount_cents), 0) as gasto
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

// Vazia abaixo de 80%: duas colunas de porcentagem lado a lado confundem mais do que
// informam, e alinhada a direita os tres digitos de um estouro saltam sozinhos.
export function celulaTeto(gasto, teto) {
	const uso = usoPct(gasto, teto);
	return uso === null || uso < 80 ? '' : `${uso}%`;
}

export function linhasDoOrcamento(cats, ym, hoje) {
	const comTeto = cats.filter((c) => c.teto !== null);
	const semTeto = cats.filter((c) => c.teto === null);

	// Teto de 14 no nome: mais que isso quebra a linha no celular.
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
