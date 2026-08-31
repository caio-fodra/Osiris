import { handle, chatDe, tg } from './handle.js';

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

	async scheduled(controller, env, ctx) {
		ctx.waitUntil(backup(env).catch((e) => console.error('backup falhou', e)));
	},
};

/* As tabelas da aplicacao, descobertas em vez de listadas. Exportada so pra ser testavel: */
export const SQL_TABELAS = `select name from sqlite_master
  where type = 'table'
    and name not like 'sqlite_%'
    and name not glob '_cf_*'
    and name <> 'd1_migrations'
  order by name`;

/* Backup semanal (o cron esta em wrangler.jsonc). Vai como arquivo anexado e nao como texto porque
   mensagem do Telegram para em 4096 caracteres, e o dump passa disso rapido. */
async function backup(env) {
	// todas as tabelas da aplicacao, descobertas e nao listadas.
	const { results: tabelas } = await env.DB.prepare(SQL_TABELAS).all();

	// O nome vai interpolado porque bind nao vale pra identificador.
	const dados = await env.DB.batch(tabelas.map((t) => env.DB.prepare(`select * from "${t.name}" order by rowid`)));

	// Uma leitura do relogio, usada no campo e no nome do arquivo. Com duas, um cron disparando
	// 23:59:59.9xx UTC podia estampar uma data no gerado_em e outra no nome.
	const agora = new Date().toISOString();

	// versao muda a forma do arquivo: todo backup anterior a este commit e um array de lancamentos na
	// raiz, sem categoria nem regra.
	const dump = { versao: 2, gerado_em: agora };
	tabelas.forEach((t, i) => {
		dump[t.name] = dados[i].results;
	});

	const fd = new FormData();
	fd.append('chat_id', env.MY_CHAT_ID);
	// Caption pelas mesmas tabelas descobertas: nada a atualizar quando entrar uma nova.
	fd.append('caption', `backup · ${tabelas.map((t, i) => `${dados[i].results.length} ${t.name}`).join(' · ')}`);
	// JSON.stringify sem o argumento de indentacao: ela custa ~29% mais bytes e tira o V8 do
	// serializador rapido, e este cron tem 10 ms de CPU no plano free.
	fd.append('document', new Blob([JSON.stringify(dump)], { type: 'application/json' }), `osiris-${agora.slice(0, 10)}.json`);

	const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/sendDocument`, { method: 'POST', body: fd });
	if (!r.ok) {
		// Um cron que falha calado sao meses sem backup sem ninguem notar. O log fica pro diagnostico e a
		// mensagem avisa quem precisa saber.
		console.error('sendDocument falhou', r.status, await r.text());
		await tg(env, 'sendMessage', {
			chat_id: env.MY_CHAT_ID,
			text: `O backup semanal falhou (HTTP ${r.status}). O banco está intacto; é o envio que não foi.`,
		}).catch((e) => console.error('aviso de falha de backup tambem falhou', e));
	}
}
