// Quantos lançamentos a tabela do mês carrega no máximo.
const LIMITE_LANCAMENTOS = 300;

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (!url.pathname.startsWith('/api/')) {
			return env.ASSETS.fetch(request);
		}

		try {
			if (url.pathname === '/api/months') {
				return json(await listarMeses(env));
			}

			if (url.pathname === '/api/month') {
				const m = url.searchParams.get('m') || '';
				if (!/^\d{4}-\d{2}$/.test(m)) {
					return json({ error: "O parâmetro 'm' precisa estar no formato AAAA-MM." }, 400);
				}
				return json(await dadosDoMes(env, m));
			}

			// Nao existe mais um /api/schema. Ele dumpava o CREATE TABLE de tudo para quem pedisse.

			return json({ error: 'Rota não encontrada.' }, 404);
		} catch (err) {
			// A mensagem real vai para o log, nao para o cliente: err.message do D1 traz nome de tabela e
			// trecho de SQL, que e mapa de graca para quem sondar a API.
			console.error('erro em', url.pathname, err);
			return json({ error: 'Erro interno.' }, 500);
		}
	},
};

// --- Consultas ------------------------------------------------------------

// Todos os meses que têm lançamentos, em ordem crescente. Alimenta o seletor de mês e o gráfico de
// evolução.
async function listarMeses(env) {
	const { results } = await env.DB.prepare(
		`SELECT substr(occurred_on, 1, 7) AS month,
              SUM(amount_cents) AS total_cents,
              COUNT(*) AS n
         FROM transactions
        GROUP BY month
        ORDER BY month`,
	).all();
	return results ?? [];
}

async function dadosDoMes(env, m) {
	const totais = await env.DB.prepare(
		`SELECT COALESCE(SUM(amount_cents), 0) AS total_cents,
              COUNT(*) AS n
         FROM transactions
        WHERE substr(occurred_on, 1, 7) = ?`,
	)
		.bind(m)
		.first();

	const categorias = await env.DB.prepare(
		`SELECT COALESCE(c.name, 'Sem categoria') AS category,
              c.budget_cents                    AS budget_cents,
              SUM(t.amount_cents)               AS total_cents,
              COUNT(*)                          AS n
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE substr(t.occurred_on, 1, 7) = ?
        GROUP BY category, c.budget_cents
        ORDER BY total_cents DESC`,
	)
		.bind(m)
		.all();

	const lancamentos = await env.DB.prepare(
		`SELECT t.id,
              t.occurred_on,
              t.amount_cents AS amount_cents,
              t.description,
              t.method,
              t.confidence,
              COALESCE(c.name, 'Sem categoria') AS category
         FROM transactions t
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE substr(t.occurred_on, 1, 7) = ?
        ORDER BY t.occurred_on DESC, t.id DESC
        LIMIT ${LIMITE_LANCAMENTOS}`,
	)
		.bind(m)
		.all();

	return {
		month: m,
		total_cents: totais?.total_cents ?? 0,
		n: totais?.n ?? 0,
		categories: categorias.results ?? [],
		transactions: lancamentos.results ?? [],
	};
}

// --- Utilitário -----------------------------------------------------------

function json(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
		},
	});
}
