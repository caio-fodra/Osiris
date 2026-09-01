import { rotulo } from './parser.js';
import { brl, bloco } from './fmt.js';
import { celulaTeto, nomeDoMes } from './orcamento.js';

// Aritmetica de mes na mao: passar 'YYYY-MM' por Date so abre espaco pra fuso mudar a
// resposta.
function mesAnterior(ym) {
	let [a, m] = [+ym.slice(0, 4), +ym.slice(5, 7)];
	if (--m === 0) {
		m = 12;
		a--;
	}
	return `${a}-${String(m).padStart(2, '0')}`;
}

// Filtro por prefixo, que so funciona porque o CHECK da 0002 garante 'YYYY-MM-DD'.
async function totalDo(env, ym) {
	const r = await env.DB.prepare('select coalesce(sum(amount_cents),0) as t from transactions where occurred_on like ?')
		.bind(`${ym}%`)
		.first();
	return r.t;
}

// "relatorio" = mes corrente, "anterior"/"passado" = mes passado, "relatorio 07" = julho
// do ano corrente. Os  sao o que impede "relatorio 2025" de virar o mes 2.
export function resolveMes(texto, hoje) {
	const t = texto.toLowerCase();
	const atual = hoje.slice(0, 7);
	if (/\banterior\b|\bpassado\b/.test(t)) return mesAnterior(atual);
	const m = t.match(/\b(0?[1-9]|1[0-2])\b/);
	if (m) return `${hoje.slice(0, 4)}-${String(+m[1]).padStart(2, '0')}`;
	return atual;
}

export async function relatorio(env, ym) {
	const total = await totalDo(env, ym);
	if (total === 0) return bloco([nomeDoMes(ym), '', 'Nenhum gasto registrado.']);

	// group by pelo id e nao por c.name: sem categoria o join da NULL, e o id mantem todos
	// os sem-categoria numa linha so.
	const { results: cats } = await env.DB.prepare(
		`
    select coalesce(c.name, 'Sem categoria') as nome,
           c.budget_cents as teto,
           sum(t.amount_cents) as v
    from transactions t
    left join categories c on c.id = t.category_id
    where t.occurred_on like ?
    group by t.category_id, c.budget_cents
    order by v desc
  `,
	)
		.bind(`${ym}%`)
		.all();

	const { results: pags } = await env.DB.prepare(
		`
    select coalesce(method, 'sem') as m, sum(amount_cents) as v
    from transactions
    where occurred_on like ?
    group by method
    order by v desc
  `,
	)
		.bind(`${ym}%`)
		.all();

	const larg = Math.max(...cats.map((c) => c.nome.length), 12); // 12 cabe 'Sem método'
	const linha = (nome, v, teto) =>
		`${nome.padEnd(larg)}  ${brl(v).padStart(10)}  ${String(Math.round((v / total) * 100)).padStart(3)}%  ${celulaTeto(v, teto).padStart(4)}`.trimEnd();

	const out = [
		`${nomeDoMes(ym)} — R$ ${brl(total)}`,
		'',
		...cats.map((c) => linha(c.nome, c.v, c.teto)),
		'',
		...pags.map((p) => `${(rotulo(p.m) ?? 'Sem método').padEnd(larg)}  ${brl(p.v).padStart(10)}`),
	];

	// O credito nao sai da conta no mes em que foi gasto, vai pra fatura.
	const credito = pags.find((p) => p.m === 'credito')?.v ?? 0;
	if (credito) {
		out.push('', `Sai da conta agora: R$ ${brl(total - credito)}`);
		out.push(`Vai pra fatura:     R$ ${brl(credito)}`);
	}

	const ant = await totalDo(env, mesAnterior(ym)); // ant > 0 cobre o 1o mes e a divisao
	if (ant > 0) {
		const d = Math.round(((total - ant) / ant) * 100);
		out.push('', `vs ${nomeDoMes(mesAnterior(ym))}: ${d >= 0 ? '+' : ''}${d}% (R$ ${brl(ant)})`);
	}

	return bloco(out);
}
