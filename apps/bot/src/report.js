import { rotulo } from './parser.js';
import { brl, bloco } from './fmt.js';

const MES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

const nomeMes = (ym) => `${MES[+ym.slice(5, 7) - 1]}/${ym.slice(0, 4)}`;

// Aritmetica de mes na mao, sem Date: o mes aqui e sempre 'yyyy-MM', e passar isso por Date so
// abriria espaco pra fuso horario mudar a resposta.
function mesAnterior(ym) {
	let [a, m] = [+ym.slice(0, 4), +ym.slice(5, 7)];
	if (--m === 0) {
		m = 12;
		a--;
	}
	return `${a}-${String(m).padStart(2, '0')}`;
}

// Filtro de mes por prefixo de texto: occurred_on e sempre 'yyyy-MM-DD', o que o CHECK da migration
// 0002 agora garante.
async function totalDo(env, ym) {
	const r = await env.DB.prepare('select coalesce(sum(amount_cents),0) as t from transactions where occurred_on like ?')
		.bind(`${ym}%`)
		.first();
	return r.t;
}

/* De que mes o usuario quer o relatorio. "relatorio" -> mes corrente "relatorio anterior" -> mes
   passado (tambem aceita "passado") "relatorio 07" -> julho do ano corrente O ano nunca vem da
   mensagem. */
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
	// Sai por aqui antes das outras duas queries, e ja dentro de bloco(): o mes vazio tambem vai com
	// parse_mode MarkdownV2 e o ponto final derrubaria o envio se fosse texto cru.
	if (total === 0) return bloco([nomeMes(ym), '', 'Nenhum gasto registrado.']);

	// group by t.category_id e nao por c.name: sem categoria o join da NULL, e agrupar pelo id mantem
	// todos os sem-categoria numa linha so.
	const { results: cats } = await env.DB.prepare(
		`
    select coalesce(c.name, 'Sem categoria') as nome,
           sum(t.amount_cents) as v
    from transactions t
    left join categories c on c.id = t.category_id
    where t.occurred_on like ?
    group by t.category_id
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

	// Largura unica pras duas tabelas: a maior categoria, com piso de 12 pra caber 'Sem método' sem
	// torcer a coluna.
	const larg = Math.max(...cats.map((c) => c.nome.length), 12);
	const linha = (nome, v) => `${nome.padEnd(larg)}  ${brl(v).padStart(10)}  ${String(Math.round((v / total) * 100)).padStart(3)}%`;

	const out = [
		`${nomeMes(ym)} — R$ ${brl(total)}`,
		'',
		...cats.map((c) => linha(c.nome, c.v)),
		'',
		...pags.map((p) => `${(rotulo(p.m) ?? 'Sem método').padEnd(larg)}  ${brl(p.v).padStart(10)}`),
	];

	// O credito nao sai da conta no mes em que foi gasto, vai pra fatura. Separar os dois e a leitura
	// que interessa pra saber quanto ainda da pra gastar.
	const credito = pags.find((p) => p.m === 'credito')?.v ?? 0;
	if (credito) {
		out.push('', `Sai da conta agora: R$ ${brl(total - credito)}`);
		out.push(`Vai pra fatura:     R$ ${brl(credito)}`);
	}

	// Comparar so faz sentido com base pra comparar: 'ant > 0' cobre tanto o primeiro mes de uso
	// quanto a divisao por zero logo abaixo.
	const ant = await totalDo(env, mesAnterior(ym));
	if (ant > 0) {
		const d = Math.round(((total - ant) / ant) * 100);
		out.push('', `vs ${nomeMes(mesAnterior(ym))}: ${d >= 0 ? '+' : ''}${d}% (R$ ${brl(ant)})`);
	}

	return bloco(out);
}
