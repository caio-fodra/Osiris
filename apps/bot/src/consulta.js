/* Consultar e corrigir pelo chat. */

import { brl, dia, bloco } from './fmt.js';
import { centavos, lerData, metodoDe, norm } from './parser.js';
import { corpo, teclado } from './vista.js';
import { estadoDaCategoria, avisoEstouro, nomeDoMes } from './orcamento.js';

/* Quantos lancamentos por pagina do /extrato. 25 linhas de ~38 caracteres da ~950, folgado dentro
   dos 4096 do Telegram. */
const POR_PAGINA = 25;

/* Uma linha do extrato. Compartilhada com o /buscar pra as duas listas terem a mesma forma. */
export function linhaExtrato(t) {
	const duvida = t.category_id === null || t.confidence === null || t.confidence < 0.6 ? '?' : ' ';
	const desc = (t.description ?? '—').slice(0, 18);
	return `${String(t.id).padStart(4)} ${dia(t.occurred_on)} ${brl(t.amount_cents).padStart(9)} ${duvida} ${desc}`;
}

const CABECALHO = `  id dia      valor   descrição`;

// --- /extrato ------------------------------------------------------------------

export async function extrato(env, ym, pagina = 0) {
	const [{ results: linhas }, tot] = await env.DB.batch([
		env.DB.prepare(
			`select t.id, t.occurred_on, t.amount_cents, t.description, t.category_id, t.confidence
         from transactions t
        where t.occurred_on like ?
        order by t.occurred_on desc, t.id desc
        limit ? offset ?`,
		).bind(`${ym}%`, POR_PAGINA, pagina * POR_PAGINA),
		env.DB.prepare(`select count(*) as n, coalesce(sum(amount_cents), 0) as total from transactions where occurred_on like ?`).bind(
			`${ym}%`,
		),
	]);

	const { n, total } = tot.results[0];
	if (!n) return { texto: bloco([nomeDoMes(ym), '', 'Nenhum lançamento neste mês.']), paginas: 0 };

	const paginas = Math.ceil(n / POR_PAGINA);
	const out = [`${nomeDoMes(ym)} · ${n} ${n === 1 ? 'lançamento' : 'lançamentos'} · R$ ${brl(total)}`, '', CABECALHO];
	for (const t of linhas) out.push(linhaExtrato(t));
	out.push('');
	// O rodape e a documentacao do /editar, e fica dentro da cerca de propriosito: fora dela o
	// MarkdownV2 exigiria escapar uma duzia de caracteres, que e exatamente o que o bloco() existe pra
	// evitar.
	out.push(paginas > 1 ? `página ${pagina + 1} de ${paginas} · /editar <id> pra corrigir` : '/editar <id> pra corrigir');
	return { texto: bloco(out), paginas };
}

/* Navegacao do extrato: setas so quando existe pagina do outro lado. */
export const tecladoExtrato = (ym, pagina, paginas) => {
	if (paginas <= 1) return undefined;
	const btn = [];
	if (pagina > 0) btn.push({ text: '←', callback_data: `ext:${ym}:${pagina - 1}` });
	if (pagina + 1 < paginas) btn.push({ text: '→', callback_data: `ext:${ym}:${pagina + 1}` });
	return { inline_keyboard: [btn] };
};

// --- /revisar ------------------------------------------------------------------

/* A fila do que precisa de atencao. 'confidence is null' entra alem do obvio: */
export async function paraRevisar(env, limite = 5) {
	const { results } = await env.DB.prepare(
		`select t.id, t.occurred_on, t.amount_cents, t.description, t.method, t.category_id, t.confidence
       from transactions t
      where t.category_id is null or t.confidence is null or t.confidence < 0.6
      order by t.occurred_on desc, t.id desc
      limit ?`,
	)
		.bind(limite)
		.all();
	const { results: tot } = await env.DB.prepare(
		`select count(*) as n from transactions where category_id is null or confidence is null or confidence < 0.6`,
	).all();
	return { fila: results, total: tot[0].n };
}

// --- /buscar -------------------------------------------------------------------

/* Busca em descricao E em nome de categoria. Nos dois porque keywordDe escolhe a palavra mais longa
   da descricao, entao 'Supermercado Pao de Acucar' ensina 'supermercado' e o nome da loja nao vira
   categoria nenhuma: */
export async function buscar(env, termo) {
	const alvo = norm(termo);
	const { results: cats } = await env.DB.prepare('select id, name, name_norm from categories').all();
	const ids = cats.filter((c) => c.name_norm?.includes(alvo)).map((c) => c.id);

	const escapado = alvo.replace(/[\\%_]/g, '\\$&');
	const marcadores = ids.length ? ids.map(() => '?').join(', ') : 'null';

	const { results } = await env.DB.prepare(
		`select t.id, t.occurred_on, t.amount_cents, t.description, t.category_id, t.confidence
       from transactions t
      where t.description like ? escape '\\' or t.category_id in (${marcadores})
      order by t.occurred_on desc, t.id desc`,
	)
		.bind(`%${escapado}%`, ...ids)
		.all();

	return results;
}

export function linhasDaBusca(termo, achados) {
	if (!achados.length) return [`Nada encontrado para "${termo}".`];

	const total = achados.reduce((s, t) => s + t.amount_cents, 0);
	const porMes = new Map();
	for (const t of achados) {
		const ym = t.occurred_on.slice(0, 7);
		const m = porMes.get(ym) ?? { v: 0, n: 0 };
		porMes.set(ym, { v: m.v + t.amount_cents, n: m.n + 1 });
	}

	const out = [`"${termo}" · ${achados.length} ${achados.length === 1 ? 'lançamento' : 'lançamentos'} · R$ ${brl(total)}`, ''];
	// Quebra por mes e a resposta interessante: "quanto gastei no Outback" quase nunca e pergunta
	// sobre o mes corrente.
	for (const [ym, m] of [...porMes.entries()].sort().reverse()) {
		out.push(`${ym}  ${brl(m.v).padStart(10)}  ${String(m.n).padStart(3)}x`);
	}

	const recentes = achados.slice(0, 10);
	out.push('', CABECALHO);
	for (const t of recentes) out.push(linhaExtrato(t));
	if (achados.length > recentes.length) out.push('', `só os ${recentes.length} mais recentes · /editar <id> pra corrigir`);
	else out.push('', '/editar <id> pra corrigir');
	return out;
}

// --- /editar -------------------------------------------------------------------

/* Os campos editaveis, e a tabela e a unica fonte do nome da coluna. Object.hasOwn e nao
   CAMPOS[campo]: */
const CAMPOS = {
	valor: { col: 'amount_cents', rotulo: 'Valor' },
	data: { col: 'occurred_on', rotulo: 'Data' },
	descricao: { col: 'description', rotulo: 'Descrição' },
	categoria: { col: 'category_id', rotulo: 'Categoria' },
	metodo: { col: 'method', rotulo: 'Método' },
};

/* Aceita 'descricao' e 'descrição', 'metodo' e 'método'. */
export const campoValido = (campo) => {
	const n = norm(campo);
	return Object.hasOwn(CAMPOS, n) ? n : null;
};

export const CAMPOS_LISTA = Object.keys(CAMPOS).join(', ');

/* Valida o valor novo de um campo. Devolve {valor} pra gravar, ou {erro} pro chat. */
export async function validarCampo(env, campo, cru, hoje) {
	if (campo === 'valor') {
		const c = centavos(cru);
		if (c === null || c <= 0) return { erro: 'Valor inválido. Exemplo: /editar 137 valor 89,90' };
		return { valor: c };
	}
	if (campo === 'data') {
		const d = lerData(norm(cru), hoje);
		if (!d || d.ruim) return { erro: 'Data inválida. Use dd/mm, dd/mm/aaaa no ano corrente, ontem ou anteontem.' };
		return { valor: d.iso };
	}
	if (campo === 'metodo') {
		const m = metodoDe(norm(cru));
		if (!m) return { erro: 'Método inválido. Use credito, debito, pix ou dinheiro.' };
		return { valor: m };
	}
	if (campo === 'descricao') {
		// Corta em 80: e a largura que o extrato mostra e o limite que mantem a mensagem dentro dos 4096.
		const d = norm(cru).slice(0, 80);
		if (!d) return { erro: 'Descrição vazia.' };
		return { valor: d };
	}
	// categoria
	const cat = await env.DB.prepare('select id, name from categories where name_norm = ?').bind(norm(cru)).first();
	if (!cat) return { erro: `Não achei a categoria "${cru}". Crie com: /categoria ${cru}` };
	return { valor: cat.id, nome: cat.name };
}

/* Le a transacao e monta o detalhe com teclado. */
export async function detalhe(env, tx, cats) {
	const estado = await estadoDaCategoria(env, tx.category_id, tx.occurred_on.slice(0, 7));
	const linhas = [corpo(tx.amount_cents, estado, tx.method, tx.occurred_on)];
	if (tx.description) linhas.push(`"${tx.description}"`);
	return {
		texto: `#${tx.id}\n${linhas.join('\n')}`,
		reply_markup: { inline_keyboard: teclado(tx.id, tx.category_id, tx.method, cats) },
	};
}

/* Aplica a edicao e devolve o texto do antes->depois. Antes->depois e o que prova ao usuario que a
   linha certa mudou. */
export async function aplicarEdicao(env, tx, campo, novo, hoje) {
	const { col, rotulo: rot } = CAMPOS[campo];
	const antes = tx[col];

	// col vem da tabela CAMPOS, literal neste arquivo, nunca do usuario.
	await env.DB.prepare(`update transactions set ${col} = ? where id = ?`).bind(novo.valor, tx.id).run();

	const mostrar = async (v) => {
		if (campo === 'valor') return `R$ ${brl(v)}`;
		if (campo === 'data') return dia(v);
		if (campo === 'categoria') {
			if (v === null) return 'sem categoria';
			const c = await env.DB.prepare('select name from categories where id = ?').bind(v).first();
			return c?.name ?? 'sem categoria';
		}
		return v ?? '—';
	};

	const txNovo = { ...tx, [col]: novo.valor };
	const ym = txNovo.occurred_on.slice(0, 7);
	const estado = await estadoDaCategoria(env, txNovo.category_id, ym);

	const delta = campo === 'valor' ? novo.valor - antes : campo === 'categoria' && antes !== novo.valor ? txNovo.amount_cents : 0;

	return {
		texto: [
			`${rot} de #${tx.id}: ${await mostrar(antes)} → ${await mostrar(novo.valor)}`,
			corpo(txNovo.amount_cents, estado, txNovo.method, txNovo.occurred_on),
		]
			.filter(Boolean)
			.join('\n'),
		aviso: avisoEstouro(estado, delta, ym, hoje),
	};
}
