// Contas fixas. Valor conhecido o bot lanca sozinho e avisa; valor variavel ele pergunta,
// pq chutar o valor de uma conta que muda todo mes e o que o parser se recusa a fazer.
// O lancamento gerado e uma transaction comum com parser = 'fixo'.

import { brl, brlInt } from './fmt.js';
import { centavos, norm, ultimoDia, metodoDe, isMetodo } from './parser.js';
import { nomeDoMes } from './orcamento.js';

// due_day guarda o dia do papel e pode ser 31. Aqui ele e preso ao ultimo dia do mes em
// vez de rolar pro seguinte, a mesma escolha da 0002 com '2026-02-31'.
export const diaEfetivo = (dueDay, ym) => Math.min(dueDay, ultimoDia(ym.slice(0, 4), +ym.slice(5, 7)));

export const dataDaConta = (dueDay, ym) => `${ym}-${String(diaEfetivo(dueDay, ym)).padStart(2, '0')}`;

// --- Cadastro (/fixo) ----------------------------------------------------------

// '/fixo <nome...> <dia> [valor] [metodo]'. Aqui a posicao importa, e e o unico lugar do
// bot onde importa: dia e valor tem a mesma forma, entao dia = o primeiro token de 1 ou 2
// digitos e valor = o ultimo depois dele. O resto, na ordem, e o nome.
export function lerFixo(arg) {
	const tokens = arg.split(/\s+/).filter(Boolean);
	let dia = null,
		valor = null,
		metodo = null;
	const nome = [];

	for (const tk of tokens) {
		const n = norm(tk);
		if (isMetodo(n) && metodo === null) {
			metodo = metodoDe(n);
			continue;
		}
		if (dia === null && /^\d{1,2}$/.test(tk)) {
			dia = +tk;
			continue;
		}
		if (dia !== null && centavos(tk) !== null) {
			valor = centavos(tk);
			continue;
		}
		nome.push(tk);
	}

	return { nome: nome.join(' ').trim(), dia, valor, metodo };
}

// Unico gargalo de escrita do name_norm de fixed_bills, mesma disciplina do criarCategoria.
export async function salvarFixa(env, { nome, dia, valor, metodo, categoryId = null }) {
	const limpo = nome.replace(/\s+/g, ' ').trim().slice(0, 40);
	const kind = valor === null ? 'variavel' : 'fixo';
	// 'do update' e nao 'do nothing' como no /categoria: repetir '/fixo aluguel 5 1980 pix' e
	// o jeito natural de dizer que o aluguel subiu, ou seja carrega dado novo.
	const r = await env.DB.prepare(
		`insert into fixed_bills (name, name_norm, kind, amount_cents, due_day, method, category_id)
     values (?, ?, ?, ?, ?, ?, ?)
     on conflict(name_norm) do update
       set name = excluded.name, kind = excluded.kind, amount_cents = excluded.amount_cents,
           due_day = excluded.due_day, method = excluded.method
     returning id, name, kind, amount_cents, due_day, method, paused`,
	)
		.bind(limpo, norm(limpo), kind, valor, dia, metodo, categoryId)
		.first();
	return r;
}

export const acharFixa = (env, nome) => env.DB.prepare('select * from fixed_bills where name_norm = ?').bind(norm(nome)).first();

export async function listarFixas(env) {
	const { results } = await env.DB.prepare('select * from fixed_bills order by due_day, name').all();
	return results;
}

// Ordenada por dia e nao por nome: le-se como calendario.
export function linhasDasFixas(fixas, ym) {
	if (!fixas.length) return ['Nenhuma conta fixa. Cadastre com: /fixo aluguel 5 1850 pix'];

	const fixos = fixas.filter((f) => f.kind === 'fixo' && !f.paused);
	const soma = fixos.reduce((s, f) => s + f.amount_cents, 0);
	const variaveis = fixas.filter((f) => f.kind === 'variavel' && !f.paused).length;

	const larg = Math.min(14, Math.max(10, ...fixas.map((f) => f.name.length)));
	const out = [
		`Contas fixas · R$ ${brlInt(soma)}/mês${variaveis ? ` + ${variaveis} ${variaveis === 1 ? 'variável' : 'variáveis'}` : ''}`,
		'',
	];
	for (const f of fixas) {
		const nome = f.name.length > larg ? f.name.slice(0, larg - 1) + '…' : f.name.padEnd(larg);
		const v = f.kind === 'variavel' ? 'variável' : brlInt(f.amount_cents);
		out.push(`dia ${String(f.due_day).padStart(2)}  ${nome} ${v.padStart(9)}${f.paused ? '  (pausada)' : ''}`);
	}
	out.push('', nomeDoMes(ym));
	return out;
}

// --- O cron diario -------------------------------------------------------------

// min(due_day, ?) e o min escalar do SQLite, com o ultimo dia do mes vindo do JS pra a SQL
// ficar legivel. Nao usa date(): rolar pra frente e o bug que a 0002 reparou.
export async function fixasDeHoje(env, hoje) {
	const ym = hoje.slice(0, 7);
	const diaHoje = +hoje.slice(8, 10);
	const { results } = await env.DB.prepare(
		`select b.* from fixed_bills b
      where b.paused = 0
        and min(b.due_day, ?) = ?
        and not exists (select 1 from fixed_bill_posts p where p.bill_id = b.id and p.due_month = ?)
      order by b.due_day, b.id`,
	)
		.bind(ultimoDia(ym.slice(0, 4), +ym.slice(5, 7)), diaHoje, ym)
		.all();
	return results;
}

// O 'returning' e o que faz isto valer como trava: sem linha de volta o mes ja foi tratado
// e o chamador sai calado.
export async function reservarMes(env, billId, ym, state) {
	const r = await env.DB.prepare(
		`insert into fixed_bill_posts (bill_id, due_month, state) values (?, ?, ?)
     on conflict(bill_id, due_month) do nothing
     returning bill_id`,
	)
		.bind(billId, ym, state)
		.first();
	return !!r;
}

// Heuristica, e a unica do arquivo: valor exato + metodo + categoria + mes. Erra pro lado
// de mostrar. categoryId vem do chamador e nao de bill.category_id, que e NULL no caso
// normal, senao a busca nunca casa com o gasto digitado a mao e o cron duplica.
export async function jaLancadaAMao(env, bill, ym, categoryId) {
	if (bill.kind !== 'fixo') return null;
	return env.DB.prepare(
		`select id from transactions
      where occurred_on like ? and amount_cents = ? and method is ? and category_id is ?
        and parser <> 'fixo'
      limit 1`,
	)
		.bind(`${ym}%`, bill.amount_cents, bill.method, categoryId)
		.first();
}

// A ordem dos tres passos escolhe qual falha e aceitavel: reserva o mes, grava o gasto,
// amarra os dois. Morrer entre 1 e 2 deixa um mes sem lancamento, que e visivel; a ordem
// inversa reposta todo dia, e duplicata que ninguem ve nao tem conserto.
export async function lancarFixa(env, bill, ym, categoryId) {
	const iso = dataDaConta(bill.due_day, ym);
	const row = await env.DB.prepare(
		`insert into transactions
       (amount_cents, occurred_on, category_id, method, description, raw_message, parser, confidence)
     values (?, ?, ?, ?, ?, ?, 'fixo', 1)
     returning id`,
	)
		.bind(bill.amount_cents, iso, categoryId, bill.method, bill.name, `fixo: ${bill.name}`)
		.first();

	await env.DB.prepare('update fixed_bill_posts set transaction_id = ?, state = ? where bill_id = ? and due_month = ?')
		.bind(row.id, 'lancado', bill.id, ym)
		.run();

	return { id: row.id, iso };
}

export const pularMes = (env, billId, ym, txId = null) =>
	env.DB.prepare(
		`insert into fixed_bill_posts (bill_id, due_month, state, transaction_id) values (?, ?, 'pulado', ?)
     on conflict(bill_id, due_month) do update set state = 'pulado', transaction_id = excluded.transaction_id`,
	)
		.bind(billId, ym, txId)
		.run();

export const marcarPergunta = (env, billId, ym, messageId) =>
	env.DB.prepare('update fixed_bill_posts set prompt_message_id = ? where bill_id = ? and due_month = ?').bind(messageId, billId, ym).run();

export const pendentePorMensagem = (env, messageId) =>
	env.DB.prepare(
		`select p.bill_id, p.due_month, b.name, b.due_day, b.category_id, b.method
       from fixed_bill_posts p join fixed_bills b on b.id = p.bill_id
      where p.prompt_message_id = ? and p.state = 'perguntado'`,
	)
		.bind(messageId)
		.first();

export async function ultimoValor(env, billId) {
	const r = await env.DB.prepare(
		`select t.amount_cents, p.due_month
       from fixed_bill_posts p join transactions t on t.id = p.transaction_id
      where p.bill_id = ? and p.state = 'lancado'
      order by p.due_month desc limit 1`,
	)
		.bind(billId)
		.first();
	return r;
}

// force_reply abre o teclado do celular ja apontado pra esta mensagem. Teclado inline nao
// serve: valor livre exigiria doze botoes e tres toques pra digitar 183,40.
export function textoDaPergunta(bill, ultimo) {
	const ref = ultimo ? `\nEm ${nomeDoMes(ultimo.due_month)} foi R$ ${brl(ultimo.amount_cents)}.` : '';
	return `${bill.name} vence hoje (dia ${bill.due_day}). Quanto foi?\nResponde só o valor.${ref}`;
}

// Resolve pelas category_rules a partir do nome, como uma mensagem digitada resolveria. E
// o que faz um clique no botao de categoria consertar todos os meses seguintes.
export async function categoriaPorRegra(env, nome) {
	const tokens = norm(nome)
		.split(' ')
		.filter((w) => w.length > 2);
	if (!tokens.length) return null;
	const marcadores = tokens.map(() => '?').join(', ');
	const r = await env.DB.prepare(`select category_id from category_rules where keyword in (${marcadores}) order by hits desc limit 1`)
		.bind(...tokens)
		.first();
	return r?.category_id ?? null;
}

export const textoDoLancamento = (bill) => `fixa: ${bill.name} — lancei sozinho`;
