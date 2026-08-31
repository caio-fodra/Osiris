import { parse, centavos, norm, LABEL, isMetodo, rotulo } from './parser.js';
import { brl, dia, bloco } from './fmt.js';
import { relatorio, resolveMes } from './report.js';
import { estadoDaCategoria, tabelaOrcamentos, linhaEstado, avisoEstouro, linhasDoOrcamento } from './orcamento.js';

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

const hojeSP = () => FORMATO_DIA_SP.format(new Date());

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

// Uma linha so, igual na confirmacao e depois de cada botao, pra o usuario ver sempre o estado
// atual da transacao.
/* A confirmacao inteira: o resumo de sempre, mais a linha de orcamento quando ha o que dizer. */
const corpo = (cents, estado, method, iso) => [resumo(cents, estado?.nome, method, iso), linhaEstado(estado)].filter(Boolean).join('\n');

function resumo(cents, catNome, method, iso) {
	return `R$ ${brl(cents)} · ${catNome ?? 'sem categoria'}` + ` · ${rotulo(method) ?? 'sem método'} · ${dia(iso)}`;
}

/* O vocabulario de acao de botao, em UM lugar. teclado() produz, onCallback valida e o teste
   confere. */
export const ACAO = { CAT: 'cat', PAY: 'pay', DEL: 'del' };

// Set e nao objeto literal: a acao vem de fora e num objeto literal 'constructor' acharia valor
// herdado do prototipo.
export const ACOES = new Set(Object.values(ACAO));

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

	await tg(env, 'sendMessage', {
		chat_id: msg.chat.id,
		text: corpo(p.amount_cents, estado, p.method, p.occurred_on),
		reply_markup: { inline_keyboard: teclado(row.id, p.category_id, p.method, cats) },
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
	const txId = Number(partes[1]);
	if (partes.length !== 3 || !ACOES.has(partes[0]) || !Number.isInteger(txId)) return ack('acao invalida');
	const [acao, , valor] = partes;

	const tx = await env.DB.prepare('select * from transactions where id = ?').bind(txId).first();
	// Some quando o usuario clica num botao de mensagem antiga cuja transacao ja foi apagada.
	if (!tx) return ack('sumiu');

	if (acao === ACAO.DEL) {
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
	if (acao === ACAO.PAY) {
		// callback_data volta do Telegram como texto solto: nada garante que e uma das strings que
		// teclado() montou.
		if (!rotulo(valor)) return ack('metodo invalido');
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
        where id = ? and (category_id is null or category_id <> ?)`,
		)
			.bind(cat.id, 'manual', txId, cat.id)
			.run();

		// cat.id e nao 'valor': valor e a string crua do callback_data, e daqui ela ia direto pro objeto
		// tx e dali pro teclado.
		tx.category_id = cat.id;

		// Aprende com a correcao: precisar clicar no botao significa que o parser errou.
		mudouCategoria = upd.meta.changes === 1;

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
