// Consultar e corrigir pelo chat: /extrato lista, /revisar mostra o que ficou sem
// categoria, /buscar soma por termo, /editar conserta.
// Importa vista/fmt/parser/orcamento; nunca handle.js.

import { brl, dia, bloco } from './fmt.js';
import { centavos, lerData, metodoDe, norm } from './parser.js';
import { corpo, teclado, ACAO } from './vista.js';
import { estadoDaCategoria, avisoEstouro, nomeDoMes } from './orcamento.js';

const POR_PAGINA = 25; // ~950 chars por pagina; o teto do Telegram e 4096

// Uma linha do extrato, compartilhada com o /buscar. O '?' marca o que precisa de
// atencao, entao quem le o extrato ja ve a fila do /revisar de passagem.
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
	// O rodape fica dentro da cerca: fora dela o MarkdownV2 exigiria escapar uma duzia de
	// caracteres.
	out.push(paginas > 1 ? `página ${pagina + 1} de ${paginas} · /editar <id> pra corrigir` : '/editar <id> pra corrigir');
	return { texto: bloco(out), paginas };
}

// O mes viaja no callback_data, senao a pagina 2 de julho mostra agosto.
export const tecladoExtrato = (ym, pagina, paginas) => {
	if (paginas <= 1) return undefined;
	const btn = [];
	if (pagina > 0) btn.push({ text: '←', callback_data: `${ACAO.EXT}:${ym}:${pagina - 1}` });
	if (pagina + 1 < paginas) btn.push({ text: '→', callback_data: `${ACAO.EXT}:${ym}:${pagina + 1}` });
	return { inline_keyboard: [btn] };
};

// --- /revisar ------------------------------------------------------------------

// 'confidence is null' entra alem do obvio: em SQL 'null < 0.6' da NULL e nao casa, e
// procedencia desconhecida e justamente coisa a revisar.
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

// Busca em descricao e em nome de categoria: keywordDe aprende a palavra mais longa da
// descricao, entao so um dos dois perderia metade das perguntas. raw_message fica fora,
// senao '/buscar 120' casa com quase tudo.
export async function buscar(env, termo) {
	const alvo = norm(termo);
	const { results: cats } = await env.DB.prepare('select id, name, name_norm from categories').all();
	const ids = cats.filter((c) => c.name_norm?.includes(alvo)).map((c) => c.id);

	// '%' e '_' do usuario sao curinga de LIKE: sem escape, '/buscar 100%' casa com o banco.
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
	// Quebra por mes: "quanto gastei no Outback" quase nunca e pergunta sobre o mes corrente.
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

// A tabela e a unica fonte do nome da coluna. raw_message, parser e confidence ficam de
// fora: sao a trilha de procedencia, e editar destroi a distincao entre palpite do regex,
// regra aprendida e escolha no botao.
const CAMPOS = {
	valor: { col: 'amount_cents', rotulo: 'Valor' },
	data: { col: 'occurred_on', rotulo: 'Data' },
	descricao: { col: 'description', rotulo: 'Descrição' },
	categoria: { col: 'category_id', rotulo: 'Categoria' },
	metodo: { col: 'method', rotulo: 'Método' },
};

// Aceita 'descricao' e 'descrição': o norm() e o mesmo que normaliza tudo que o usuario
// digita, entao acento nunca decide se o comando funciona. hasOwn pelo motivo do parser.js.
export const campoValido = (campo) => {
	const n = norm(campo);
	return Object.hasOwn(CAMPOS, n) ? n : null;
};

export const CAMPOS_LISTA = Object.keys(CAMPOS).join(', ');

// Parcela nao se edita sozinha: valor quebra a soma do grupo, metodo grava estado que o
// parser recusa e some do /fatura, e data move a parcela pra fora da fatura dela.
// Categoria passa, e vai pro grupo inteiro.
export const recusaParcelada = (tx, campo) =>
	tx.installment_group !== null && campo !== 'categoria'
		? `#${tx.id} é a parcela ${tx.installment_no}/${tx.installment_of} de uma compra parcelada. ` +
			`Só dá pra mudar a categoria — pro resto, apaga o grupo pelo botão e lança de novo.`
		: null;

/**
 * Cada validador reusa o que o lancamento ja usa (centavos, lerData, metodoDe, name_norm),
 * entao o /editar aceita exatamente o que uma mensagem de gasto aceita.
 * @returns {{valor:any,nome?:string}|{erro:string}}
 */
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
		// Corta em 80, a largura que o extrato mostra. Nao reaprende keyword nem recategoriza:
		// corrigir um typo nao pode mover dinheiro entre categorias.
		const d = norm(cru).slice(0, 80);
		if (!d) return { erro: 'Descrição vazia.' };
		return { valor: d };
	}
	// categoria
	const cat = await env.DB.prepare('select id, name from categories where name_norm = ?').bind(norm(cru)).first();
	if (!cat) return { erro: `Não achei a categoria "${cru}". Crie com: /categoria ${cru}` };
	return { valor: cat.id, nome: cat.name };
}

// Reata os botoes a um lancamento antigo, cuja confirmacao ja se perdeu no chat. E o unico
// lugar em que a descricao volta pro usuario: o resumo nunca a mostrou.
export async function detalhe(env, tx, cats) {
	const estado = await estadoDaCategoria(env, tx.category_id, tx.occurred_on.slice(0, 7));
	const linhas = [corpo(tx.amount_cents, estado, tx.method, tx.occurred_on)];
	if (tx.description) linhas.push(`"${tx.description}"`);
	return {
		texto: `#${tx.id}\n${linhas.join('\n')}`,
		reply_markup: { inline_keyboard: teclado(tx.id, tx.category_id, tx.method, cats) },
	};
}

// O antes->depois e o que prova ao usuario que a linha certa mudou.
export async function aplicarEdicao(env, tx, campo, novo, hoje) {
	const { col, rotulo: rot } = CAMPOS[campo];
	const antes = tx[col];

	// Mesmo alvo do onCallback: categoria fala do grupo, o resto fala da linha. Uma categoria
	// por parcela faria a mesma compra aparecer em tres categorias, cada uma com um terco.
	const grupo = tx.installment_group;
	const porGrupo = campo === 'categoria' && grupo !== null;
	const alvoSql = porGrupo ? 'installment_group = ?' : 'id = ?';
	const alvoVal = porGrupo ? grupo : tx.id;

	// col vem da tabela CAMPOS, literal neste arquivo e nunca do usuario, entao pode ser
	// interpolado. Quem escolhe a entrada e o campoValido().
	await env.DB.prepare(`update transactions set ${col} = ? where ${alvoSql}`).bind(novo.valor, alvoVal).run();

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
