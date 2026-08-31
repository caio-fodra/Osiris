import { parse, centavos, LABEL, isMetodo, rotulo } from './parser.js';
import { brl, dia } from './fmt.js';
import { relatorio, resolveMes } from './report.js';

const API = (t) => `https://api.telegram.org/bot${t}`;

// Todo contato com o Telegram passa por aqui. Falha de API nao lanca, so loga:
async function tg(env, method, body) {
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
function hojeSP() {
	return new Intl.DateTimeFormat('en-CA', {
		timeZone: 'America/Sao_Paulo',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(new Date());
}

// Cada recusa do parser vira uma frase que repete o formato certo: a mensagem de erro e a unica
// documentacao que o usuario le.
const ERRO = {
	sem_valor: 'Não achei o valor. Formato: 120 mercado 12/08 credito',
	valor_ambiguo: 'Achei mais de um número. Manda só o valor: 120 mercado 12/08 credito',
	data_invalida: 'Data inválida. Use dd/mm, ou dd/mm/aaaa no ano corrente: 12/08.',
	data_ambigua: 'Achei mais de uma data. Manda só uma: 120 mercado 12/08',
	metodo_ambiguo: 'Achei mais de uma forma de pagamento. Manda só uma: 120 mercado credito',
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

// Quebra a lista em linhas de no maximo dois botoes.
export function emLinhas(botoes, porLinha = 2) {
	const linhas = [];
	for (let i = 0; i < botoes.length; i += porLinha) linhas.push(botoes.slice(i, i + porLinha));
	return linhas;
}

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

// Uma linha so, igual na confirmacao e depois de cada botao, pra o usuario ver sempre o estado
// atual da transacao.
function resumo(cents, catNome, method, iso) {
	return `R$ ${brl(cents)} · ${catNome ?? 'sem categoria'}` + ` · ${rotulo(method) ?? 'sem método'} · ${dia(iso)}`;
}

/* Monta o teclado com o que ainda falta preencher na transacao. Recebe o estado ja lido em vez de
   ler do banco de novo: */
export function teclado(txId, temCategoria, temMetodo, cats = []) {
	const linhas = [];
	if (!temCategoria) {
		linhas.push(...emLinhas(cats.map((c) => ({ text: c.name, callback_data: `cat:${txId}:${c.id}` }))));
	}
	if (!temMetodo) {
		linhas.push(
			Object.keys(LABEL).map((m) => ({
				text: LABEL[m],
				callback_data: `pay:${txId}:${m}`,
			})),
		);
	}
	linhas.push([{ text: 'apagar', callback_data: `del:${txId}:` }]);
	return linhas.filter((l) => l.length);
}

async function onMessage(msg, env) {
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
			await env.DB.prepare('insert into categories (name) values (?) on conflict(name) do nothing').bind(nome.slice(0, 40)).run();
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

		if (!arg) {
			const { results } = await env.DB.prepare('select name, budget_cents from categories order by name').all();
			await tg(env, 'sendMessage', {
				chat_id: msg.chat.id,
				text: results.length
					? results.map((c) => `${c.name}: ${c.budget_cents ? `R$ ${brl(c.budget_cents)}` : 'sem orçamento'}`).join('\n')
					: 'Nenhuma categoria ainda. Crie com: /categoria mercado',
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

		// collate nocase pro usuario nao precisar lembrar como digitou no /categoria. O nome ecoado na
		// resposta e o do cadastro, nao o que ele acabou de mandar, pra ficar claro qual categoria foi
		// atingida.
		const nome = partes.slice(0, -1).join(' ');
		const cat = await env.DB.prepare('select id, name from categories where name = ? collate nocase').bind(nome).first();

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
				'Use /relatorio para ver o resumo do mês.',
		});
		return;
	}

	const p = parse(texto, { rules: await loadRules(env), hoje });

	if (!p.ok) {
		await tg(env, 'sendMessage', {
			chat_id: msg.chat.id,
			text: ERRO[p.reason] ?? ERRO.sem_valor,
		});
		return;
	}

	// tg_update_id e unique, e o 'do nothing' torna o insert idempotente: se o mesmo update chegar
	// duas vezes, a segunda nao grava e nao devolve linha.
	const row = await env.DB.prepare(
		`
    insert into transactions
      (amount_cents, occurred_on, category_id, method, description,
       raw_message, parser, confidence, tg_update_id)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(tg_update_id) do nothing
    returning id
  `,
	)
		.bind(p.amount_cents, p.occurred_on, p.category_id, p.method, p.description, texto, p.parser, p.confidence, msg._update_id)
		.first();

	// Sem linha = o update ja tinha sido processado. Sair calado e o certo:
	if (!row) return;

	const cat = p.category_id ? await env.DB.prepare('select name from categories where id = ?').bind(p.category_id).first() : null;

	// So busca os atalhos se ainda faltar categoria.
	const cats = p.category_id ? [] : await categoriasPorUso(env);

	await tg(env, 'sendMessage', {
		chat_id: msg.chat.id,
		text: resumo(p.amount_cents, cat?.name, p.method, p.occurred_on),
		reply_markup: { inline_keyboard: teclado(row.id, p.category_id, p.method, cats) },
	});
}

// Clique de botao volta como callback_query trazendo de volta o callback_data que teclado() montou:
// '<acao>:<txId>:<valor>'.
const ACOES = new Set(['cat', 'pay', 'del']);

async function onCallback(cb, env) {
	// O Telegram deixa o botao com a ampulheta girando ate receber este ack.
	const ack = (t) => tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text: t });

	// callback_data volta do Telegram como texto solto, e nada garante que saiu do teclado() deste
	// arquivo. Um 'foo:42:x' passava pela busca da transacao, nao casava com ramo nenhum, e ainda
	// assim caia no ack('ok') + editMessageText do fim:
	const partes = (cb.data ?? '').split(':');
	if (partes.length !== 3 || !ACOES.has(partes[0])) return ack('acao invalida');
	const [acao, , valor] = partes;

	// Number e nao a string crua: este id vai pra comparacao com coluna integer, e mais abaixo pro
	// objeto tx, de onde alimenta o teclado.
	const txId = Number(partes[1]);
	if (!Number.isInteger(txId) || txId <= 0) return ack('acao invalida');

	const tx = await env.DB.prepare('select * from transactions where id = ?').bind(txId).first();
	// Some quando o usuario clica num botao de mensagem antiga cuja transacao ja foi apagada.
	if (!tx) return ack('sumiu');

	if (acao === 'del') {
		await env.DB.prepare('delete from transactions where id = ?').bind(txId).run();
		await ack('apagado');
		// Troca o texto pra mensagem antiga nao continuar parecendo um gasto vivo.
		return tg(env, 'editMessageText', {
			chat_id: cb.message.chat.id,
			message_id: cb.message.message_id,
			text: 'apagado',
		});
	}

	// Os dois ramos abaixo atualizam o banco e tambem o objeto tx em memoria, porque o resumo e o
	// teclado logo adiante sao montados a partir dele.
	if (acao === 'pay') {
		// callback_data volta do Telegram como texto solto: nada garante que e uma das strings que
		// teclado() montou.
		if (!rotulo(valor)) return ack('metodo invalido');
		await env.DB.prepare('update transactions set method = ? where id = ?').bind(valor, txId).run();
		tx.method = valor;
	}

	// Resolvida uma vez so: no ramo abaixo ela serve de validacao do callback_data, e no fim alimenta
	// o resumo.
	let cat = null;

	if (acao === 'cat') {
		// Mesma desconfianca do 'pay': o id da categoria vem do callback_data e pode ser forjado.
		cat = await env.DB.prepare('select id, name from categories where id = ?').bind(valor).first();
		if (!cat) return ack('categoria invalida');

		// parser vira 'manual' e confidence 1: foi o usuario quem disse, nao o regex.
		const upd = await env.DB.prepare(
			`update transactions set category_id = ?, parser = ?, confidence = 1
        where id = ? and (category_id is null or category_id <> ?)`,
		)
			.bind(cat.id, 'manual', txId, cat.id)
			.run();

		// cat.id e nao 'valor': valor e a string crua do callback_data, e daqui ela ia direto pro objeto
		// tx e dali pro teclado.
		tx.category_id = cat.id;

		// Aprende com a correcao: precisar clicar no botao significa que o parser errou.
		if (upd.meta.changes === 1) {
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

	// Ja resolvido la em cima quando o clique foi no botao de categoria. Este ??= cobre o 'pay', que
	// mexe so no metodo mas precisa reexibir a categoria que a transacao ja tinha.
	cat ??= tx.category_id ? await env.DB.prepare('select name from categories where id = ?').bind(tx.category_id).first() : null;

	const cats = tx.category_id ? [] : await categoriasPorUso(env);

	await ack('ok');
	await tg(env, 'editMessageText', {
		chat_id: cb.message.chat.id,
		message_id: cb.message.message_id,
		text: resumo(tx.amount_cents, cat?.name, tx.method, tx.occurred_on),
		reply_markup: { inline_keyboard: teclado(txId, tx.category_id, tx.method, cats) },
	});
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
		if (upd.message) {
			// O update_id viaja grudado na mensagem so pra chegar ao insert como tg_update_id: e ele que
			// torna o processamento idempotente.
			upd.message._update_id = upd.update_id;
			return await onMessage(upd.message, env);
		}
		// Qualquer outro tipo de update (entrada em grupo, enquete) e ignorado.
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
