import { parse, centavos, norm, LABEL, isMetodo, rotulo } from './parser.js';
import { brl, dia, bloco } from './fmt.js';
import { relatorio, resolveMes } from './report.js';
import { estadoDaCategoria, tabelaOrcamentos, avisoEstouro, linhasDoOrcamento, nomeDoMes } from './orcamento.js';
import { corpo, resumo, teclado, emLinhas, ACAO, ACOES } from './vista.js';
import { parcelasDe, linhaParcelas, somaMes, mesFatura, janelaFatura } from './fatura.js';
import {
	lerFixo,
	salvarFixa,
	acharFixa,
	listarFixas,
	linhasDasFixas,
	pularMes,
	pendentePorMensagem,
	reservarMes,
	categoriaPorRegra,
	dataDaConta,
} from './fixos.js';
import {
	extrato,
	tecladoExtrato,
	paraRevisar,
	buscar,
	linhasDaBusca,
	detalhe,
	campoValido,
	validarCampo,
	aplicarEdicao,
	CAMPOS_LISTA,
} from './consulta.js';

const API = (t) => `https://api.telegram.org/bot${t}`;

// Todo contato com o Telegram passa por aqui. Falha de API nao lanca, so loga:
export async function tg(env, method, body) {
	const r = await fetch(`${API(env.TELEGRAM_TOKEN)}/${method}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
	if (!r.ok) console.error(method, r.status, await r.text());
	return r;
}

// O Worker roda em UTC, o usuario vive em Sao Paulo. Sem esta conversao todo gasto lancado depois
// das 21h locais cairia no dia seguinte.
const FORMATO_DIA_SP = new Intl.DateTimeFormat('en-CA', {
	timeZone: 'America/Sao_Paulo',
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
});

// Exportada porque o cron das contas fixas precisa do mesmo 'hoje' que uma mensagem usaria.
/* Grava o valor de uma conta variavel, seja pela resposta a pergunta ou pelo '/fixo pagar'. Reserva
   o mes se ainda nao estiver reservado. */
async function pagarFixa(env, chatId, bill, ym, valor, hoje) {
	await reservarMes(env, bill.id, ym, 'lancado');
	const catId = bill.category_id ?? (await categoriaPorRegra(env, bill.name));
	const iso = dataDaConta(bill.due_day, ym);
	const row = await env.DB.prepare(
		`insert into transactions (amount_cents, occurred_on, category_id, method, description, raw_message, parser, confidence)
     values (?, ?, ?, ?, ?, ?, 'fixo', 1) returning id`,
	)
		.bind(valor, iso, catId, bill.method, bill.name, `fixo: ${bill.name}`)
		.first();
	await env.DB.prepare("update fixed_bill_posts set transaction_id = ?, state = 'lancado' where bill_id = ? and due_month = ?")
		.bind(row.id, bill.id, ym)
		.run();

	const estado = await estadoDaCategoria(env, catId, ym);
	await tg(env, 'sendMessage', {
		chat_id: chatId,
		text: corpo(valor, estado, bill.method, iso),
		reply_markup: { inline_keyboard: teclado(row.id, catId, bill.method, []) },
	});
	const aviso = avisoEstouro(estado, valor, ym, hoje);
	if (aviso) await tg(env, 'sendMessage', { chat_id: chatId, text: aviso });
}

export const hojeSP = () => FORMATO_DIA_SP.format(new Date());

// Cada recusa do parser vira uma frase que repete o formato certo: a mensagem de erro e a unica
// documentacao que o usuario le.
const AJUDA_EDITAR = '\nExemplo: /editar 137 valor 89,90';

const ERRO = {
	sem_valor: 'Não achei o valor. Formato: 120 mercado 12/08 credito',
	valor_ambiguo: 'Achei mais de um número. Manda só o valor: 120 mercado 12/08 credito',
	data_invalida: 'Data inválida. Use dd/mm, ou dd/mm/aaaa no ano corrente: 12/08.',
	data_ambigua: 'Achei mais de uma data. Manda só uma: 120 mercado 12/08',
	metodo_ambiguo: 'Achei mais de uma forma de pagamento. Manda só uma: 120 mercado credito',
	parcelas_invalidas: 'Parcelas de 1 a 24. Formato: 300 sofá 3x credito',
	parcelas_ambiguas: 'Achei mais de um parcelamento. Manda só um: 300 sofá 3x credito',
	parcelas_sem_credito: 'Parcelado só no crédito. Tira o método, ou usa credito: 300 sofá 3x',
};

// Carrega a tabela de regras inteira a cada mensagem. Sao poucas dezenas de linhas, e o parser
// precisa consultar token a token:
async function loadRules(env) {
	const { results } = await env.DB.prepare('select keyword, category_id, hits from category_rules').all();
	return new Map(results.map((r) => [r.keyword, r]));
}

// Todas as categorias viram botao, ordenadas por uso. O left join e o que faz categoria
// recem-criada (uso = 0) tambem aparecer.
async function categoriasPorUso(env) {
	const { results } = await env.DB.prepare(
		`
    select c.id, c.name, count(t.id) as uso
    from categories c
    left join transactions t on t.category_id = c.id
    group by c.id
    order by uso desc, c.name
  `,
	).all();
	return results;
}

/* As duas unicas funcoes que tocam a chave de categoria, e a razao de existirem: a migration 0004
   fez de name_norm a chave real, mas nenhum CHECK pode garantir que ela esteja normalizada. */
async function criarCategoria(env, nome) {
	const limpo = nome.replace(/\s+/g, ' ').trim().slice(0, 40);
	// 'or ignore' e nao 'on conflict(...) do nothing': existem dois indices unicos aqui (name, da
	// 0001, e name_norm, da 0004).
	await env.DB.prepare('insert or ignore into categories (name, name_norm) values (?, ?)').bind(limpo, norm(limpo)).run();
}

const acharCategoria = (env, nome) => env.DB.prepare('select id, name from categories where name_norm = ?').bind(norm(nome)).first();

// Palavra = so letras e digitos, com pelo menos uma letra. Barra exatamente o que o parser ja
// consumiu ou o que nunca casaria de volta como keyword:
const ePalavra = (w) => /^[a-z0-9]+$/.test(w) && /[a-z]/.test(w);

/* Escolhe, dentro da descricao, a palavra que vira regra de categoria. A mais longa e heuristica
   barata pra nao aprender ruido curto ('do', 'no'). */
function keywordDe(desc) {
	return (desc ?? '')
		.split(/\s+/)
		.filter((w) => w.length > 2 && ePalavra(w) && !isMetodo(w))
		.sort((a, b) => b.length - a.length)[0];
}

/* O dia de fechamento do cartao. Uma linha na tabela config, com default 28. */
async function fechamentoDaFatura(env) {
	const r = await env.DB.prepare('select invoice_closing_day as dia from config where id = 1').first();
	return r?.dia ?? 28;
}

/* Grava as N linhas de uma compra parcelada, e devolve a primeira. DB.batch e nao um insert de N
   linhas: */
async function inserirParceladas(env, p, texto, updateId) {
	const fechamento = await fechamentoDaFatura(env);
	const linhas = parcelasDe({ amount_cents: p.amount_cents, occurred_on: p.occurred_on, parcelas: p.parcelas, fechamento });

	const sql = `insert into transactions
      (amount_cents, occurred_on, category_id, method, description, raw_message, parser,
       confidence, tg_update_id, installment_group, installment_no, installment_of, purchased_on)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict do nothing
    returning id`;

	const res = await env.DB.batch(
		linhas.map((l, i) =>
			env.DB.prepare(sql).bind(
				l.amount_cents,
				l.occurred_on,
				p.category_id,
				p.method,
				p.description,
				texto,
				p.parser,
				p.confidence,
				i === 0 ? updateId : null,
				updateId,
				l.installment_no,
				l.installment_of,
				l.purchased_on,
			),
		),
	);

	return res[0]?.results?.[0] ?? null;
}

async function onMessage(msg, env, updateId) {
	// caption entra junto com text.
	const texto = (msg.text ?? msg.caption ?? '').trim();

	// O 'return' mudo que morava aqui era, do lado do usuario, indistinguivel de bot fora do ar:
	// mandava foto do comprovante, audio, documento, e nada acontecia.
	if (!texto) {
		await tg(env, 'sendMessage', {
			chat_id: msg.chat.id,
			text: 'Sem texto pra ler. Se for comprovante, manda o valor na legenda: 120 mercado 12/08 credito',
		});
		return;
	}

	// Uma so leitura do relogio por mensagem: se o parser pedisse a data de novo pra cada token, uma
	// mensagem na virada da meia-noite poderia usar dois dias diferentes.
	const hoje = hojeSP();

	// A barra e opcional em todos os comandos: no celular e mais rapido digitar 'relatorio' do que
	// achar a barra no teclado.
	if (/^\/?relat[oó]rio/i.test(texto)) {
		await tg(env, 'sendMessage', {
			chat_id: msg.chat.id,
			text: await relatorio(env, resolveMes(texto, hoje)),
			parse_mode: 'MarkdownV2',
		});
		return;
	}

	// /categoria existe porque o banco nasce vazio.
	const mCat = texto.match(/^\/?categorias?(?:\s+(.+))?$/i);
	if (mCat) {
		const nome = mCat[1]?.trim();
		if (nome) {
			// 'do nothing' e nao 'do update': repetir /categoria mercado e o jeito natural de perguntar se
			// ela ja existe, e nao pode dar erro.
			await criarCategoria(env, nome);
		}
		const { results } = await env.DB.prepare('select name from categories order by name').all();
		await tg(env, 'sendMessage', {
			chat_id: msg.chat.id,
			text: results.length
				? `Categorias: ${results.map((c) => c.name).join(', ')}`
				: 'Nenhuma categoria ainda. Crie com: /categoria mercado',
		});
		return;
	}

	// /orcamento define o teto mensal de uma categoria (categories.budget_cents). /orcamento lista os
	// tetos /orcamento mercado 800 define /orcamento mercado 0 remove
	const mOrc = texto.match(/^\/?or[cç]amentos?(?:\s+(.+))?$/i);
	if (mOrc) {
		const arg = mOrc[1]?.trim();

		// Sem argumento, ou com um argumento que e mes ('anterior', 'passado', '7'): tabela de gasto
		// contra teto.
		const soMes = !arg || /^(anterior|passado|0?[1-9]|1[0-2])$/i.test(arg);
		if (soMes) {
			const ym = resolveMes(arg ?? '', hoje);
			const cats = await tabelaOrcamentos(env, ym);
			await tg(env, 'sendMessage', {
				chat_id: msg.chat.id,
				text: cats.length ? bloco(linhasDoOrcamento(cats, ym, hoje)) : 'Nenhuma categoria ainda. Crie com: /categoria mercado',
				parse_mode: cats.length ? 'MarkdownV2' : undefined,
			});
			return;
		}

		// O valor e sempre o ultimo token, e o nome e todo o resto: assim '/orcamento mercado do bairro
		// 800' funciona sem exigir aspas.
		const partes = arg.split(/\s+/);
		const valor = partes.length > 1 ? centavos(partes.at(-1)) : null;
		if (valor === null) {
			await tg(env, 'sendMessage', {
				chat_id: msg.chat.id,
				text: 'Formato: /orcamento mercado 800 (use 0 pra remover)',
			});
			return;
		}

		// Busca por name_norm e nao 'collate nocase': o nocase do SQLite dobra so ASCII, entao com ele
		// '/orcamento saude' nao acharia 'Saúde'.
		const nome = partes.slice(0, -1).join(' ');
		const cat = await acharCategoria(env, nome);

		if (!cat) {
			await tg(env, 'sendMessage', {
				chat_id: msg.chat.id,
				text: `Nao achei a categoria "${nome}". Crie com: /categoria ${nome}`,
			});
			return;
		}

		// 0 grava NULL, nao zero: 'sem teto definido' e 'teto de R$ 0,00' sao coisas diferentes, e e o
		// NULL que a listagem le como 'sem orçamento'.
		await env.DB.prepare('update categories set budget_cents = ? where id = ?')
			.bind(valor || null, cat.id)
			.run();

		await tg(env, 'sendMessage', {
			chat_id: msg.chat.id,
			text: valor ? `Orçamento de ${cat.name}: R$ ${brl(valor)}` : `Orçamento de ${cat.name} removido.`,
		});
		return;
	}

	// /extrato [mes].
	const mExt = texto.match(/^[/]?extrato(?:[ ]+(.+))?$/i);
	if (mExt) {
		const ym = resolveMes(mExt[1] ?? '', hoje);
		const { texto: t, paginas } = await extrato(env, ym, 0);
		await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: t, parse_mode: 'MarkdownV2', reply_markup: tecladoExtrato(ym, 0, paginas) });
		return;
	}

	// /revisar.
	if (/^[/]?revisar$/i.test(texto)) {
		const { fila, total } = await paraRevisar(env);
		if (!total) {
			await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: 'Nada para revisar.' });
			return;
		}
		await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: `Revisar · ${total} ${total === 1 ? 'pendência' : 'pendências'}` });
		const cats = await categoriasPorUso(env);
		for (const tx of fila) {
			const d = await detalhe(env, tx, cats);
			await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: d.texto, reply_markup: d.reply_markup });
		}
		return;
	}

	// /buscar <termo>.
	const mBusca = texto.match(/^[/]?busca[r]?[ ]+(.+)$/i);
	if (mBusca) {
		const termo = mBusca[1].trim();
		const achados = await buscar(env, termo);
		await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: bloco(linhasDaBusca(termo, achados)), parse_mode: 'MarkdownV2' });
		return;
	}

	// /editar <id> [campo] [valor].
	const mEd = texto.match(/^[/]?editar[ ]+(\d+)(?:[ ]+([^ ]+)(?:[ ]+(.+))?)?$/i);
	if (mEd) {
		const id = Number(mEd[1]);
		const tx = await env.DB.prepare('select * from transactions where id = ?').bind(id).first();
		if (!tx) {
			await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: `Não achei o lançamento #${id}. Veja os ids no /extrato.` });
			return;
		}

		// Sem campo: mostra o lancamento com os botoes.
		if (!mEd[2]) {
			const cats = tx.category_id ? [] : await categoriasPorUso(env);
			const d = await detalhe(env, tx, cats);
			await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: d.texto, reply_markup: d.reply_markup });
			return;
		}

		const campo = campoValido(mEd[2]);
		if (!campo || !mEd[3]) {
			await tg(env, 'sendMessage', {
				chat_id: msg.chat.id,
				text: `Campo inválido. Use: ${CAMPOS_LISTA}.` + AJUDA_EDITAR,
			});
			return;
		}

		const novo = await validarCampo(env, campo, mEd[3].trim(), hoje);
		if (novo.erro) {
			await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: novo.erro });
			return;
		}

		const r = await aplicarEdicao(env, tx, campo, novo, hoje);
		await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: r.texto });
		if (r.aviso) await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: r.aviso });
		return;
	}

	// /fatura.
	const mFat = texto.match(/^[/]?fatura(?:[ ]+(.+))?$/i);
	if (mFat) {
		const arg = mFat[1]?.trim();
		const mFech = arg?.match(/^fechamento[ ]+(""" + BS + """d{1,2})$/i);
		if (mFech) {
			const d = +mFech[1];
			if (d < 1 || d > 28) {
				await tg(env, 'sendMessage', {
					chat_id: msg.chat.id,
					text: `Fechamento de 1 a 28 (dia 29, 30 e 31 não existem em todo mês). Hoje: ${await fechamentoDaFatura(env)}.`,
				});
				return;
			}
			await env.DB.prepare('update config set invoice_closing_day = ? where id = 1').bind(d).run();
			await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: `Fatura passa a fechar no dia ${d}.` });
			return;
		}

		const fechamento = await fechamentoDaFatura(env);
		const ym = arg ? resolveMes(arg, hoje) : mesFatura(hoje, fechamento);
		const { ini, fim } = janelaFatura(ym, fechamento);

		// Janela por between de texto, nao por prefixo de mes: e a diferenca entre a fatura e o mes do
		// calendario, e de quebra usa o idx_tx_data melhor que o LIKE.
		const [cats, abertas] = await env.DB.batch([
			env.DB.prepare(
				`select coalesce(c.name, 'Sem categoria') as nome, sum(t.amount_cents) as v
           from transactions t left join categories c on c.id = t.category_id
          where t.method = 'credito' and t.occurred_on > ? and t.occurred_on <= ?
          group by t.category_id order by v desc`,
			).bind(ini, fim),
			env.DB.prepare(
				`select description, installment_no, installment_of, amount_cents
           from transactions
          where installment_group is not null and occurred_on > ? and occurred_on <= ?
          order by installment_of - installment_no desc`,
			).bind(ini, fim),
		]);

		const linhas = cats.results;
		const total = linhas.reduce((sm, c) => sm + c.v, 0);
		const larg = Math.max(12, ...linhas.map((c) => c.nome.length));
		const out = [`Fatura de ${nomeDoMes(ym)} · fecha ${dia(fim)}`, `compras de ${dia(ini)} a ${dia(fim)}`, ''];

		if (!linhas.length) out.push('Nada no crédito nesta fatura.');
		else {
			for (const c of linhas) {
				out.push(`${c.nome.padEnd(larg)}  ${brl(c.v).padStart(10)}  ${String(Math.round((c.v / total) * 100)).padStart(3)}%`);
			}
			out.push('', `${'Total'.padEnd(larg)}  ${brl(total).padStart(10)}`);
		}

		// As parcelas em aberto por nome, porque "por que outubro ja esta em R$ 420" e a pergunta que
		// este bloco existe pra responder.
		if (abertas.results.length) {
			out.push('', 'Parcelas nesta fatura');
			for (const a of abertas.results) {
				out.push(
					`${(a.description ?? '—').slice(0, larg).padEnd(larg)}  ${`${a.installment_no}/${a.installment_of}`.padStart(5)}  ${brl(a.amount_cents).padStart(9)}`,
				);
			}
		}

		// O que ja esta comprometido nos dois meses seguintes.
		const proximos = await env.DB.batch(
			[1, 2].map((k) => {
				const j = janelaFatura(somaMes(ym, k), fechamento);
				return env.DB.prepare(
					`select coalesce(sum(amount_cents), 0) as v from transactions
             where method = 'credito' and occurred_on > ? and occurred_on <= ?`,
				).bind(j.ini, j.fim);
			}),
		);
		const comprometido = proximos.map((r, i) => ({ ym: somaMes(ym, i + 1), v: r.results[0].v })).filter((x) => x.v > 0);
		if (comprometido.length) {
			out.push('', 'Já comprometido');
			for (const c of comprometido) out.push(`${nomeDoMes(c.ym).padEnd(larg)}  ${brl(c.v).padStart(10)}`);
		}

		await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: bloco(out), parse_mode: 'MarkdownV2' });
		return;
	}

	// /fixo.
	const mFixo = texto.match(/^[/]?fixo(?:[ ]+(.+))?$/i);
	if (mFixo) {
		const arg = mFixo[1]?.trim();
		const ym = hoje.slice(0, 7);

		if (!arg) {
			await tg(env, 'sendMessage', {
				chat_id: msg.chat.id,
				text: bloco(linhasDasFixas(await listarFixas(env), ym)),
				parse_mode: 'MarkdownV2',
			});
			return;
		}

		// Os verbos vem primeiro, senao '/fixo pausar netflix' cadastraria uma conta chamada 'pausar
		// netflix'. Limite aceito:
		const mVerbo = arg.match(/^(pagar|pular|pausar|voltar|remover)[ ]+(.+)$/i);
		if (mVerbo) {
			const verbo = norm(mVerbo[1]);
			const resto = mVerbo[2].trim();

			// '/fixo pagar luz 183,40' precisa de verbo proprio porque '/fixo luz 10' e ao mesmo tempo "dia
			// 10" e "R$ 10,00".
			if (verbo === 'pagar') {
				const partes = resto.split(/[ ]+/);
				const valor = centavos(partes.at(-1));
				const nome = partes.slice(0, -1).join(' ');
				const bill = nome && (await acharFixa(env, nome));
				if (!bill) {
					await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: `Não achei a conta fixa "${nome || resto}".` });
					return;
				}
				if (valor === null || valor <= 0) {
					await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: 'Formato: /fixo pagar luz 183,40' });
					return;
				}
				await pagarFixa(env, msg.chat.id, bill, ym, valor, hoje);
				return;
			}

			const bill = await acharFixa(env, resto);
			if (!bill) {
				const todas = await listarFixas(env);
				await tg(env, 'sendMessage', {
					chat_id: msg.chat.id,
					text: `Não achei a conta fixa "${resto}".` + (todas.length ? ` Existem: ${todas.map((f) => f.name).join(', ')}` : ''),
				});
				return;
			}

			if (verbo === 'pular') {
				await pularMes(env, bill.id, ym);
				await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: `${bill.name} não conta neste mês.` });
				return;
			}
			if (verbo === 'remover') {
				await env.DB.prepare('delete from fixed_bills where id = ?').bind(bill.id).run();
				await tg(env, 'sendMessage', {
					chat_id: msg.chat.id,
					text: `${bill.name} removida. Os lançamentos dos meses passados ficam.`,
				});
				return;
			}
			const pausar = verbo === 'pausar' ? 1 : 0;
			await env.DB.prepare('update fixed_bills set paused = ? where id = ?').bind(pausar, bill.id).run();
			await tg(env, 'sendMessage', {
				chat_id: msg.chat.id,
				text: pausar ? `${bill.name} pausada. /fixo voltar ${bill.name} quando quiser de volta.` : `${bill.name} de volta.`,
			});
			return;
		}

		// Cadastro.
		const { nome, dia, valor, metodo } = lerFixo(arg);
		if (!nome) {
			await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: 'Falta o nome. Formato: /fixo aluguel 5 1850 pix' });
			return;
		}
		if (dia === null) {
			await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: 'Falta o dia. Formato: /fixo aluguel 5 1850 pix' });
			return;
		}
		if (dia < 1 || dia > 31) {
			await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: 'Dia inválido. Use um dia de 1 a 31: /fixo aluguel 5 1850 pix' });
			return;
		}

		const antes = await acharFixa(env, nome);
		const catId = antes?.category_id ?? (await categoriaPorRegra(env, nome));
		const bill = await salvarFixa(env, { nome, dia, valor, metodo, categoryId: catId });

		const linhas = [
			`Fixa ${antes ? 'atualizada' : 'criada'}: ${bill.name} · dia ${bill.due_day} · ${
				bill.kind === 'variavel' ? 'valor variável' : `R$ ${brl(bill.amount_cents)}`
			}${bill.method ? ` · ${rotulo(bill.method)}` : ''}`,
		];
		if (bill.kind === 'variavel') linhas.push(`Todo dia ${bill.due_day} eu pergunto quanto foi.`);
		else linhas.push(`Lanço sozinho todo dia ${bill.due_day}. Não quer? /fixo pausar ${bill.name}`);

		// Dia que ja passou neste mes: marca o mes como pulado pra o cron diario nao revisitar, e diz
		// isso.
		if (dia <= +hoje.slice(8, 10)) {
			await pularMes(env, bill.id, ym);
			linhas.push(`O dia ${bill.due_day} já passou neste mês, então começo no mês que vem.`);
		}

		await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: linhas.join('\n') });
		return;
	}

	// Qualquer outra coisa comecando com barra cai na ajuda, inclusive o /start que o Telegram manda
	// sozinho no primeiro contato.
	if (texto.startsWith('/')) {
		await tg(env, 'sendMessage', {
			chat_id: msg.chat.id,
			text:
				'Olá! Eu sou seu Robô Assistente de Controle de Gastos\n\n' +
				'Algumas instruções:\n' +
				'As entradas devem ser no modelo: <valor> <categoria> [metodo] [data]\n' +
				'Entradas sem data serão atribuídas à data atual.\n' +
				'Metodos de pagamento: credito, debito, pix, dinheiro\n' +
				'Para criar uma categoria use /categoria <nome>\n' +
				'Para listar categorias use /categorias\n' +
				'Para definir um teto mensal use /orcamento <categoria> <valor>\n' +
				'Use /orcamento sozinho para ver gasto x teto de cada categoria.\n' +
				'Use /relatorio para ver o resumo do mês.\n' +
				'Parcelado no cartão: 300 sofá 3x credito (o 300 é o total).\n' +
				'Use /fatura para ver o que fecha na próxima fatura.\n' +
				'Use /fatura fechamento 28 para dizer o dia em que seu cartão fecha.\n' +
				'Use /extrato para listar os lançamentos do mês, com o id de cada um.\n' +
				'Use /revisar para acertar o que ficou sem categoria.\n' +
				'Use /buscar <palavra> para somar o que gastou com algo.\n' +
				'Contas que caem todo mês, use /fixo:\n' +
				'  /fixo aluguel 5 1850 pix     (valor fixo, eu lanço sozinho)\n' +
				'  /fixo conta de luz 10 debito (valor variável, eu pergunto)\n' +
				'  /fixo pagar luz 183,40\n' +
				'  /fixo pular luz              (não cobra este mês)\n' +
				'  /fixo pausar netflix         e /fixo voltar netflix\n' +
				'Use /editar <id> para corrigir um lançamento:\n' +
				'  /editar 137 valor 89,90\n' +
				'  /editar 137 data 12/08\n' +
				'  /editar 137 descricao padaria da esquina\n' +
				'  /editar 137 categoria mercado\n' +
				'  /editar 137 metodo pix\n' +
				'A barra é opcional em todos os comandos.',
		});
		return;
	}

	// Resposta a um pedido de valor de conta variavel. Precisa vir antes do parse:
	const respondido = msg.reply_to_message?.message_id;
	if (respondido && centavos(texto) !== null) {
		const pend = await pendentePorMensagem(env, respondido);
		if (pend) {
			const bill = await acharFixa(env, pend.name);
			// O mes e o da pergunta e nao o de hoje: resposta que chega em outubro pra a pergunta de
			// setembro lanca em setembro, onde a conta de fato venceu.
			if (bill) return pagarFixa(env, msg.chat.id, bill, pend.due_month, centavos(texto), hoje);
		}
	}

	const p = parse(texto, { rules: await loadRules(env), hoje });

	if (!p.ok) {
		await tg(env, 'sendMessage', {
			chat_id: msg.chat.id,
			text: ERRO[p.reason] ?? ERRO.sem_valor,
		});
		return;
	}

	// Parcelado ou nao, o insert e idempotente. Sem parcela, pelo UNIQUE de tg_update_id; com parcela,
	// pelo indice unico (installment_group, installment_no).
	const row = p.parcelas
		? await inserirParceladas(env, p, texto, updateId)
		: await env.DB.prepare(
				`
    insert into transactions
      (amount_cents, occurred_on, category_id, method, description,
       raw_message, parser, confidence, tg_update_id)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(tg_update_id) do nothing
    returning id
  `,
			)
				.bind(p.amount_cents, p.occurred_on, p.category_id, p.method, p.description, texto, p.parser, p.confidence, updateId)
				.first();

	// Sem linha = o update ja tinha sido processado. Sair calado e o certo:
	if (!row) return;

	// Uma consulta no lugar da busca de nome que morava aqui: ela ja devolve o teto e o gasto do mes
	// junto, entao a linha de orcamento na confirmacao e o aviso de estouro saem sem nenhum round trip
	// a mais no caminho quente.
	const estado = await estadoDaCategoria(env, p.category_id, p.occurred_on.slice(0, 7));

	// So busca as categorias se ainda faltar uma.
	const cats = p.category_id ? [] : await categoriasPorUso(env);

	// O valor da primeira linha continua sendo o TOTAL digitado, que e o que o usuario acabou de
	// mandar.
	const linhaParc = p.parcelas ? linhaParcelas(p.amount_cents, p.parcelas, mesFatura(p.occurred_on, await fechamentoDaFatura(env))) : null;

	await tg(env, 'sendMessage', {
		chat_id: msg.chat.id,
		text: [corpo(p.amount_cents, estado, p.method, p.occurred_on), linhaParc].filter(Boolean).join('\n'),
		// Parcelado ja e credito por definicao, entao o teclado nao oferece metodo.
		reply_markup: { inline_keyboard: teclado(row.id, p.category_id, p.parcelas ? 'credito' : p.method, cats) },
	});

	// O aviso de estouro vai em mensagem separada.
	const aviso = avisoEstouro(estado, p.amount_cents, p.occurred_on.slice(0, 7), hoje);
	if (aviso) await tg(env, 'sendMessage', { chat_id: msg.chat.id, text: aviso });
}

// Clique de botao volta como callback_query trazendo de volta o callback_data que teclado() montou:
// '<acao>:<txId>:<valor>'.
async function onCallback(cb, env) {
	// O Telegram deixa o botao com a ampulheta girando ate receber este ack.
	const ack = (t) => tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: t });

	// callback_data volta do Telegram como texto solto, e nada garante que saiu do teclado() deste
	// arquivo. Um 'foo:42:x' passava pela busca da transacao, nao casava com ramo nenhum, e ainda
	// assim caia no ack('ok') + editMessageText do fim:
	const partes = (cb.data ?? '').split(':');
	if (partes.length !== 3) return ack('acao invalida');

	// Paginacao do extrato, tratada antes de tudo: ela nao fala de transacao nenhuma, entao o segundo
	// campo e o mes e nao um id.
	if (partes[0] === ACAO.EXT) {
		const [, ym, pag] = partes;
		if (!/^\d{4}-\d{2}$/.test(ym)) return ack('acao invalida');
		const pagina = Math.max(0, Number(pag) || 0);
		const { texto, paginas } = await extrato(env, ym, pagina);
		await ack('ok');
		return tg(env, 'editMessageText', {
			chat_id: cb.message.chat.id,
			message_id: cb.message.message_id,
			text: texto,
			parse_mode: 'MarkdownV2',
			reply_markup: tecladoExtrato(ym, pagina, paginas),
		});
	}

	const txId = Number(partes[1]);
	if (!ACOES.has(partes[0]) || !Number.isInteger(txId)) return ack('acao invalida');
	const [acao, , valor] = partes;

	const tx = await env.DB.prepare('select * from transactions where id = ?').bind(txId).first();
	// Some quando o usuario clica num botao de mensagem antiga cuja transacao ja foi apagada.
	if (!tx) return ack('sumiu');

	// O alvo de toda operacao: a linha, ou o grupo inteiro se a compra for parcelada.
	const grupo = tx.installment_group;
	const alvoSql = grupo === null ? 'id = ?' : 'installment_group = ?';
	const alvoVal = grupo === null ? txId : grupo;

	if (acao === ACAO.DEL) {
		const r = await env.DB.prepare(`delete from transactions where ${alvoSql}`).bind(alvoVal).run();
		await ack(grupo === null ? 'apagado' : `apagado (${r.meta.changes} parcelas)`);
		// Troca o texto pra mensagem antiga nao continuar parecendo um gasto vivo.
		return tg(env, 'editMessageText', {
			chat_id: cb.message.chat.id,
			message_id: cb.message.message_id,
			text: 'apagado',
		});
	}

	// Os dois ramos abaixo atualizam o banco e tambem o objeto tx em memoria, porque o resumo e o
	// teclado logo adiante sao montados a partir dele.
	if (acao === ACAO.PAY) {
		// callback_data volta do Telegram como texto solto: nada garante que e uma das strings que
		// teclado() montou.
		if (!rotulo(valor)) return ack('metodo invalido');
		// Parcelado e credito por definicao.
		if (grupo !== null) return ack('parcelado e sempre no credito');
		await env.DB.prepare('update transactions set method = ? where id = ?').bind(valor, txId).run();
		tx.method = valor;
	}

	// Resolvida uma vez so: no ramo abaixo ela serve de validacao do callback_data.
	let cat = null;
	// Se este clique realmente moveu a transacao de categoria. Sai do meta.changes do UPDATE
	// condicional, entao re-clique na mesma categoria nao conta.
	let mudouCategoria = false;

	if (acao === ACAO.CAT) {
		// Mesma desconfianca do 'pay': o id da categoria vem do callback_data e pode ser forjado.
		cat = await env.DB.prepare('select id, name from categories where id = ?').bind(valor).first();
		if (!cat) return ack('categoria invalida');

		// parser vira 'manual' e confidence 1: foi o usuario quem disse, nao o regex.
		const upd = await env.DB.prepare(
			`update transactions set category_id = ?, parser = ?, confidence = 1
        where ${alvoSql} and (category_id is null or category_id <> ?)`,
		)
			.bind(cat.id, 'manual', alvoVal, cat.id)
			.run();

		// cat.id e nao 'valor': valor e a string crua do callback_data, e daqui ela ia direto pro objeto
		// tx e dali pro teclado.
		tx.category_id = cat.id;

		// Aprende com a correcao: precisar clicar no botao significa que o parser errou.
		mudouCategoria = upd.meta.changes > 0;

		if (mudouCategoria) {
			const kw = keywordDe(tx.description);
			if (kw) {
				await env.DB.prepare(
					`
        insert into category_rules (keyword, category_id, hits) values (?, ?, 1)
        on conflict(keyword) do update
          set category_id = excluded.category_id, hits = hits + 1
      `,
				)
					.bind(kw, cat.id)
					.run();
			}
		}
	}

	// A mesma consulta do lancamento, e ela substitui a busca de nome que morava aqui: traz nome, teto
	// e gasto do mes de uma vez.
	const ym = tx.occurred_on.slice(0, 7);
	const estado = await estadoDaCategoria(env, tx.category_id, ym);

	const cats = tx.category_id ? [] : await categoriasPorUso(env);

	await ack('ok');
	await tg(env, 'editMessageText', {
		chat_id: cb.message.chat.id,
		message_id: cb.message.message_id,
		text: corpo(tx.amount_cents, estado, tx.method, tx.occurred_on),
		reply_markup: { inline_keyboard: teclado(txId, tx.category_id, tx.method, cats) },
	});

	// Mover um gasto para uma categoria conta como o valor dele entrando naquele mes: se esse for o
	// lancamento que cruza o teto de la, o aviso sai igual ao do lancamento direto.
	const aviso = mudouCategoria ? avisoEstouro(estado, tx.amount_cents, ym, hojeSP()) : null;
	if (aviso) await tg(env, 'sendMessage', { chat_id: cb.message.chat.id, text: aviso });
}

// Todo update que o bot trata carrega o chat em um destes lugares. Lista explicita e nao busca
// recursiva:
export const chatDe = (upd) => upd.message?.chat?.id ?? upd.edited_message?.chat?.id ?? upd.callback_query?.message?.chat?.id;

export async function handle(upd, env) {
	// O try engloba tudo porque index.js JA respondeu 200 antes de chamar aqui (index.js:27-33): o
	// Telegram da o update por entregue e nunca reenvia.
	try {
		// Os await nao sao decoracao. Com 'return onCallback(...)' a promise sai do frame do try e a
		// rejeicao dela passaria longe deste catch.
		if (upd.callback_query) return await onCallback(upd.callback_query, env);
		// O update_id vai como parametro e nao grudado no objeto.
		if (upd.message) return await onMessage(upd.message, env, upd.update_id);
		// Qualquer outro tipo de update (edicao de mensagem, entrada em grupo, enquete) e ignorado.
		console.log('update ignorado:', Object.keys(upd).join(','));
	} catch (e) {
		console.error('handle falhou', e);
		const chatId = chatDe(upd);
		// tg() nao lanca em resposta 4xx (so loga), mas lanca em falha de rede.
		if (chatId) {
			await tg(env, 'sendMessage', {
				chat_id: chatId,
				text: 'Deu erro aqui. Manda de novo — confira no /relatorio se já tinha entrado.',
			}).catch(() => {});
		}
	}
}
