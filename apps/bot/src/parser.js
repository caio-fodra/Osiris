// Tudo que chega do usuario passa por aqui antes de qualquer comparacao: minusculas, sem
// acento, espacos colapsados. Quem escreve em categories.name_norm, fixed_bills.name_norm
// ou category_rules.keyword usa esta funcao, nunca uma copia.
export const norm = (s) =>
	s
		.toLowerCase()
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/\s+/g, ' ')
		.trim();

// Apelidos aceitos na mensagem -> os quatro valores do CHECK da 0002.
const METODOS = {
	credito: 'credito',
	cred: 'credito',
	cartao: 'credito',
	c: 'credito',
	debito: 'debito',
	deb: 'debito',
	d: 'debito',
	pix: 'pix',
	dinheiro: 'dinheiro',
	din: 'dinheiro',
	especie: 'dinheiro',
};

export const LABEL = {
	credito: 'Crédito',
	debito: 'Débito',
	pix: 'Pix',
	dinheiro: 'Dinheiro',
};

const RE_VALOR = /^(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+,\d{2}|\d+(?:[.,]\d{1,2})?)$/;
// Captura mais do que aceita: token com cara de data tem que casar aqui pra sair como
// data_invalida, senao vaza pra descricao e o gasto cai em hoje sem aviso.
const RE_DATA = /^(\d{1,2})\/(\d{1,2})(?:\/(\d*))?$/;

// Sem teto de digitos, mesmo so aceitando 1..24: '1000x' precisa casar aqui pra virar
// erro explicito. Quem valida a faixa e o 'n < 1 || n > MAX_PARCELAS' la embaixo.
const RE_PARCELAS = /^(\d+)x$/;

export const MAX_PARCELAS = 24; // mesmo teto do CHECK da 0008

// A virgula desempata: se ela existe, o ponto so pode ser milhar.
function toCents(s) {
	if (s.includes('.') && s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
	else if (s.includes(',')) s = s.replace(',', '.');
	return Math.round(parseFloat(s) * 100);
}

// Colar 'r$ 120' e '3 x' vem antes do split, entao o usuario espaca como quiser.
const preparado = (s) =>
	norm(String(s))
		.replace(/r\$\s*/g, 'r$')
		// O (?![a-z0-9]) impede '2 xicaras' de virar '2xicaras'.
		.replace(/(\d) x(?![a-z0-9])/g, '$1x');

// Reusa o RE_VALOR do parser: o /orcamento aceita os mesmos formatos de um lancamento.
export function centavos(txt) {
	const m = preparado(txt).match(RE_VALOR);
	return m ? toCents(m[1]) : null;
}

// Monta por componente e deixa o Date.UTC virar mes e ano sozinho. Nao passa string pro
// construtor: string malformada vira Invalid Date e o toISOString seguinte lanca
// RangeError dentro do ctx.waitUntil, onde o erro so vira log.
export function shiftDia(iso, n) {
	const [a, m, d] = iso.split('-').map(Number);
	return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
}

// hasOwn: em objeto literal, 'constructor' e '__proto__' acham valor no prototipo e
// passariam por metodo valido.
export const isMetodo = (tk) => Object.hasOwn(METODOS, tk);

export const rotulo = (m) => (Object.hasOwn(LABEL, m ?? '') ? LABEL[m] : null);

export const ultimoDia = (ano, mes) => new Date(Date.UTC(+ano, mes, 0)).getUTCDate();

// Valida na mao porque new Date('2026-02-31') e Date.parse rolam pra 2026-03-03. O ano
// exige 4 digitos: Date.UTC mapeia 0-99 pra 1900+ano, e com '24' o ultimoDia() responderia
// sobre 1924.
function ddmmParaIso(dia, mes, ano) {
	if (!/^\d{4}$/.test(String(ano))) return null;
	if (!Number.isInteger(dia) || !Number.isInteger(mes)) return null;
	if (mes < 1 || mes > 12 || dia < 1 || dia > ultimoDia(ano, mes)) return null;
	return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

/**
 * O vocabulario de data do projeto: o /editar usa o mesmo, senao as duas listas divergem.
 * So o ano corrente entra, pq resolveMes (report.js) nunca gera prefixo de outro ano e o
 * lancamento ficaria invisivel em todo relatorio.
 * @returns {{iso:string}|{ruim:true}|null} ruim = tem cara de data e nao existe; null =
 *   nao e data, e o token segue pra descricao
 */
export function lerData(tk, hoje) {
	if (tk === 'ontem') return { iso: shiftDia(hoje, -1) };
	if (tk === 'anteontem') return { iso: shiftDia(hoje, -2) };
	const md = tk.match(RE_DATA);
	if (!md) return null;
	const ano = hoje.slice(0, 4);
	const iso = (md[3] ?? ano) === ano ? ddmmParaIso(+md[1], +md[2], ano) : null;
	return iso ? { iso } : { ruim: true };
}

export const metodoDe = (tk) => (isMetodo(tk) ? METODOS[tk] : null);

/**
 * Le uma mensagem solta. Cada token e classificado pelo que parece, nao pela posicao:
 * '120 mercado credito', 'mercado 120 pix ontem', '42,90 ifood deb 12/08'. O que sobra
 * vira descricao, e e dela que sai a keyword aprendida no botao. Ambiguidade vira erro.
 * @returns {{ok:true}|{ok:false,reason:string}} a transacao pronta, ou o motivo da recusa
 */
export function parse(msg, { rules, hoje }) {
	const tokens = preparado(msg).split(' ').filter(Boolean);

	let cents = null,
		method = null,
		data = hoje;
	let numeros = 0,
		datas = 0,
		metodos = 0,
		dataRuim = false,
		parcelas = 1,
		vistasX = 0,
		parcelaRuim = false;
	const sobra = [];

	for (const tk of tokens) {
		const mv = tk.match(RE_VALOR);
		if (mv) {
			// Conta todo numero mesmo com o valor preenchido: e o que faz '50 mercado 30' virar
			// valor_ambiguo. O continue impede numero de vazar pra descricao.
			numeros++;
			if (cents === null) cents = toCents(mv[1]);
			continue;
		}

		const mp = tk.match(RE_PARCELAS);
		if (mp) {
			vistasX++;
			const n = +mp[1];
			// '1x' nao e erro: e uma compra normal dita de outro jeito. '0x' e '100x' sao.
			if (n < 1 || n > MAX_PARCELAS) parcelaRuim = true;
			else if (parcelas === 1) parcelas = n;
			continue;
		}

		// Rule ensinada vence alias de metodo, entao categoria batizada de 'cartao' volta a
		// funcionar assim que tiver regra. Hoje keywordDe ja recusa aprender alias, entao isto
		// e so rede.
		if (!rules.has(tk) && isMetodo(tk)) {
			// Conta token e nao metodo distinto: '50 credito cred' e ambiguo do mesmo jeito que
			// '50 mercado 50'. O continue impede o alias de virar keyword na descricao.
			metodos++;
			if (!method) method = metodoDe(tk);
			continue;
		}

		const ld = lerData(tk, hoje);
		if (ld) {
			datas++;
			if (ld.iso) data = ld.iso;
			else dataRuim = true;
			continue;
		}

		sobra.push(tk);
	}

	// Parcelamento so existe no credito, entao 'x' sem metodo e declaracao e nao chute.
	// metodoDito guarda se o metodo veio do usuario: a confidence la embaixo nao sobe pra 1
	// por um credito deduzido daqui.
	const metodoDito = method !== null;
	if (parcelas > 1 && !metodoDito) method = 'credito';

	// A ordem destes returns e o contrato de erro. 'numeros > 1' vem antes de 'cents <= 0'
	// pq invertido '0 mercado 50' e '50 mercado 0' dariam queixas diferentes pros mesmos
	// tokens, e a promessa e que a ordem dos tokens nao importa.
	if (cents === null) return { ok: false, reason: 'sem_valor' };
	if (numeros > 1) return { ok: false, reason: 'valor_ambiguo' };
	if (cents <= 0) return { ok: false, reason: 'sem_valor' };
	if (dataRuim) return { ok: false, reason: 'data_invalida' };
	if (datas > 1) return { ok: false, reason: 'data_ambigua' };
	if (metodos > 1) return { ok: false, reason: 'metodo_ambiguo' };
	// 'invalidas' antes de 'ambiguas' pelo mesmo motivo que dataRuim vem antes de datas > 1:
	// '3x 100x' tem um token que nunca poderia existir.
	if (parcelaRuim) return { ok: false, reason: 'parcelas_invalidas' };
	if (vistasX > 1) return { ok: false, reason: 'parcelas_ambiguas' };
	if (parcelas > 1 && method !== 'credito') return { ok: false, reason: 'parcelas_sem_credito' };

	let hit = null;
	for (const tk of sobra) {
		const r = rules.get(tk);
		if (r && (!hit || r.hits > hit.hits)) hit = r;
	}

	return {
		ok: true,
		amount_cents: cents,
		occurred_on: data,
		method,
		category_id: hit?.category_id ?? null,
		description: sobra.join(' ') || null,
		parser: 'regex',
		parcelas: parcelas > 1 ? parcelas : null,
		confidence: hit && metodoDito ? 1 : hit ? 0.8 : 0.4,
	};
}
