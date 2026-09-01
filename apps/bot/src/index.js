import { handle, chatDe, tg, hojeSP } from './handle.js';
import {
	fixasDeHoje,
	reservarMes,
	jaLancadaAMao,
	lancarFixa,
	pularMes,
	marcarPergunta,
	ultimoValor,
	textoDaPergunta,
	textoDoLancamento,
	categoriaPorRegra,
} from './fixos.js';
import { estadoDaCategoria } from './orcamento.js';
import { corpo, teclado } from './vista.js';

// Tem que casar com o "secrets.required" do wrangler.jsonc, que barra o deploy sem eles.
// Esta lista e a segunda rede: secret apagado depois do deploy, rollback, .dev.vars vazio.
const SEGREDOS = ['TELEGRAM_TOKEN', 'TG_SECRET', 'MY_CHAT_ID'];
const faltando = (env) => SEGREDOS.filter((k) => !env[k]);

const FALTA_CHAT_ID = 'MY_CHAT_ID ausente. Rode: wrangler secret put MY_CHAT_ID -c apps/bot/wrangler.jsonc';

export default {
	async fetch(req, env, ctx) {
		const url = new URL(req.url);

		if (url.pathname === '/tg' && req.method === 'POST') {
			// O secret vem em todo webhook e prova que a chamada e do Telegram.
			if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TG_SECRET) return new Response('forbidden', { status: 403 });

			// Corpo quebrado responde 'ok': 4xx faria o Telegram reenviar o mesmo lixo em loop.
			let upd;
			try {
				upd = await req.json();
			} catch {
				return new Response('ok');
			}

			// Update sem chat (my_chat_member, enquete, channel_post) tem chatId undefined, e
			// vira log em vez de descarte mudo.
			const chatId = chatDe(upd);
			if (chatId === undefined) {
				console.log('update sem chat:', Object.keys(upd).join(','));
				return new Response('ok');
			}
			// Sem esta guarda o !== de baixo seria sempre verdadeiro e toda mensagem sairia com
			// 200, indistinguivel no log do chat de terceiro que a linha seguinte descarta.
			//
			// `!` e nao `=== undefined`: um .dev.vars nao preenchido entrega string vazia, que da
			// no mesmo. Chat id do Telegram nunca e 0.
			if (!env.MY_CHAT_ID) {
				console.error(FALTA_CHAT_ID);
				return new Response('ok');
			}
			if (String(chatId) !== env.MY_CHAT_ID) return new Response('ok');

			// 200 na hora e processa em segundo plano, pra nao arriscar o timeout do webhook. O
			// preco: depois do 200 o Telegram da o update por entregue e nunca reenvia, entao o
			// que falhar aqui dentro nao volta. Por isso handle() avisa no chat.
			ctx.waitUntil(handle(upd, env).catch((e) => console.error(e)));
			return new Response('ok');
		}

		if (url.pathname === '/health') {
			const falta = faltando(env);
			return falta.length ? new Response(`faltando: ${falta.join(', ')}`, { status: 500 }) : new Response('ok');
		}

		return new Response('not found', { status: 404 });
	},

	async scheduled(controller, env, ctx) {
		// Aborta antes de tocar no banco: umaFixa() chama reservarMes() antes do sendMessage,
		// entao a conta variavel ficaria 'perguntado' sem pergunta nenhuma ter saido, e o
		// fixasDeHoje() exclui o mes ja reservado.
		if (!env.MY_CHAT_ID) {
			console.error(FALTA_CHAT_ID, '-- cron', controller.cron, 'nao rodou');
			return;
		}

		if (controller.cron !== CRON_FIXOS) {
			console.error('cron sem tarefa', controller.cron);
			return;
		}

		// O Cloudflare nao repete cron que falha: o que estourar aqui e um dia perdido.
		ctx.waitUntil(contasDoDia(env).catch((e) => console.error('cron', controller.cron, e)));
	},
};

// Copia literal do "crons" em wrangler.jsonc. Se divergirem, o Worker acorda e cai no
// console.error do scheduled em vez de nao fazer nada calado.
const CRON_FIXOS = '0 13 * * *';

// Um try por conta, pra uma que falhe nao derrubar as outras. Sequencial: sao poucas
// contas por dia e o limite e 50 subrequests por invocacao no plano free.
async function contasDoDia(env) {
	const hoje = hojeSP();
	const ym = hoje.slice(0, 7);
	const fixas = await fixasDeHoje(env, hoje);

	for (const b of fixas) {
		try {
			await umaFixa(env, b, ym);
		} catch (e) {
			console.error('fixa', b.id, b.name, e);
		}
	}
}

async function umaFixa(env, bill, ym) {
	// Conta variavel pergunta em vez de chutar. force_reply ja aponta o teclado do celular
	// pra esta mensagem, e a pergunta sai uma vez por mes.
	if (bill.kind === 'variavel') {
		if (!(await reservarMes(env, bill.id, ym, 'perguntado'))) return;
		const ultimo = await ultimoValor(env, bill.id);
		const r = await tg(env, 'sendMessage', {
			chat_id: env.MY_CHAT_ID,
			text: textoDaPergunta(bill, ultimo),
			reply_markup: { force_reply: true },
		});
		// O message_id liga a resposta a esta conta; sem ele a resposta vira gasto solto.
		const j = await r.json().catch(() => null);
		if (j?.result?.message_id) await marcarPergunta(env, bill.id, ym, j.result.message_id);
		return;
	}

	// Resolve a categoria antes do dedup: e contra ela que jaLancadaAMao compara.
	const catId = bill.category_id ?? (await categoriaPorRegra(env, bill.name));

	const jaTem = await jaLancadaAMao(env, bill, ym, catId);
	if (jaTem) {
		await pularMes(env, bill.id, ym, jaTem.id);
		await tg(env, 'sendMessage', {
			chat_id: env.MY_CHAT_ID,
			text: `${bill.name}: achei um lançamento igual neste mês (#${jaTem.id}), então não lancei de novo.`,
		});
		return;
	}

	if (!(await reservarMes(env, bill.id, ym, 'lancado'))) return;

	const { id, iso } = await lancarFixa(env, bill, ym, catId);
	const estado = await estadoDaCategoria(env, catId, ym);

	await tg(env, 'sendMessage', {
		chat_id: env.MY_CHAT_ID,
		text: corpo(bill.amount_cents, estado, bill.method, iso) + '\n' + textoDoLancamento(bill),
		reply_markup: { inline_keyboard: teclado(id, catId, bill.method, []) },
	});
}
