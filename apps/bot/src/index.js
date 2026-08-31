import { handle, chatDe } from './handle.js';

export default {
	async fetch(req, env, ctx) {
		const url = new URL(req.url);

		if (url.pathname === '/tg' && req.method === 'POST') {
			// Duas travas antes de tocar no banco. O secret e o que o Telegram devolve em todo webhook e
			// prova que a chamada veio dele; sem ele qualquer um que descubra a URL escreveria gasto na sua
			// conta.
			if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TG_SECRET) return new Response('forbidden', { status: 403 });

			// Corpo quebrado responde 'ok' e nao 4xx: erro faria o Telegram reenviar o mesmo lixo em loop.
			let upd;
			try {
				upd = await req.json();
			} catch {
				return new Response('ok');
			}

			// A segunda trava: o bot e de uso pessoal.
			const chatId = chatDe(upd);
			if (chatId === undefined) {
				console.log('update sem chat:', Object.keys(upd).join(','));
				return new Response('ok');
			}
			if (String(chatId) !== env.MY_CHAT_ID) return new Response('ok');

			// Responde 200 na hora e processa em segundo plano, pra nao arriscar o timeout do webhook. O
			// preco:
			ctx.waitUntil(handle(upd, env).catch((e) => console.error(e)));
			return new Response('ok');
		}

		if (url.pathname === '/health') return new Response('ok');

		return new Response('not found', { status: 404 });
	},

	// Backup semanal (o cron esta em wrangler.jsonc). Vai como arquivo anexado e nao como texto porque
	// mensagem do Telegram para em 4096 caracteres, e o dump passa disso rapido.
	async scheduled(event, env, ctx) {
		ctx.waitUntil(
			(async () => {
				// As tres tabelas, nao so transactions.
				const [tx, cats, rules] = await env.DB.batch([
					env.DB.prepare(
						`select t.*, c.name as categoria
             from transactions t
             left join categories c on c.id = t.category_id
            order by t.id`,
					),
					env.DB.prepare('select * from categories order by id'),
					env.DB.prepare('select * from category_rules order by keyword'),
				]);

				const dump = {
					// versao muda a forma do arquivo: todo backup anterior a este commit e um array de lancamentos
					// na raiz, sem categoria nem regra.
					versao: 2,
					gerado_em: new Date().toISOString(),
					transactions: tx.results,
					categories: cats.results,
					category_rules: rules.results,
				};

				const fd = new FormData();
				fd.append('chat_id', env.MY_CHAT_ID);
				fd.append(
					'caption',
					`backup · ${dump.transactions.length} lançamentos · ${dump.categories.length} categorias · ${dump.category_rules.length} regras`,
				);
				fd.append(
					'document',
					new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' }),
					`osiris-${new Date().toISOString().slice(0, 10)}.json`,
				);

				const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendDocument`, { method: 'POST', body: fd });
				if (!r.ok) {
					// Um cron que falha calado sao meses sem backup sem ninguem notar. O log fica pro diagnostico
					// e a mensagem avisa quem precisa saber.
					console.error('backup falhou', r.status, await r.text());
					await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendMessage`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							chat_id: env.MY_CHAT_ID,
							text: `O backup semanal falhou (HTTP ${r.status}). O banco está intacto; é o envio que não foi.`,
						}),
					}).catch((e) => console.error('aviso de falha de backup tambem falhou', e));
				}
			})(),
		);
	},
};
