// Tudo que chega do usuario passa por aqui antes de qualquer comparacao: minusculas, sem acento,
// espacos colapsados.
export const norm = (s) =>
	s
		.toLowerCase()
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/\s+/g, ' ')
		.trim();

// Apelidos aceitos na mensagem -> valor canonico gravado em transactions.method (os quatro do CHECK
// da migration 0002).
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

// Como cada metodo aparece pro usuario: texto dos botoes e do resumo.
export const LABEL = {
	credito: 'Crédito',
	debito: 'Débito',
	pix: 'Pix',
	dinheiro: 'Dinheiro',
};

const RE_VALOR = /^(?:r\$\s*)?(\d{1,3}(?:\.\d{3})+,\d{2}|\d+(?:[.,]\d{1,2})?)$/;
// O ano e capturado mesmo sendo aceito so quando e o corrente. Capturar mais do que se aceita e o
// que impede token com cara de data de vazar pra descricao:
const RE_DATA = /^(\d{1,2})\/(\d{1,2})(?:\/(\d*))?$/;

// '1.234,56' (ponto de milhar) e '1.50' (ponto decimal) chegam os dois aqui. A virgula desempata:
function toCents(s) {
	if (s.includes('.') && s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
	else if (s.includes(',')) s = s.replace(',', '.');
	return Math.round(parseFloat(s) * 100);
}

// O preparo que toda entrada de valor atravessa, seja a mensagem inteira ou o token solto do
// /orcamento. Existe como funcao porque centavos() refazia dois dos passos do norm() na mao e
// repetia o colapso do 'r$':
const preparado = (s) => norm(String(s)).replace(/r\$\s*/g, 'r$');

/* Valor isolado ('800', '42,90', 'R$ 1.234,56') -> centavos, ou null se o texto nao for um valor. */
export function centavos(txt) {
	const m = preparado(txt).match(RE_VALOR);
	return m ? toCents(m[1]) : null;
}

// 'ontem' e 'anteontem', aplicados sobre a data ja normalizada. Monta por componente e deixa o
// Date.UTC virar o mes e o ano sozinho (dia 0 de marco = ultimo dia de fevereiro).
function shiftDia(iso, n) {
	const [a, m, d] = iso.split('-').map(Number);
	return new Date(Date.UTC(a, m - 1, d + n)).toISOString().slice(0, 10);
}

// Object.hasOwn e nao 'METODOS[tk]': num objeto literal os tokens 'constructor' e '__proto__' acham
// valor herdado do prototipo e passariam por metodo valido.
export const isMetodo = (tk) => Object.hasOwn(METODOS, tk);

// Mesma armadilha: LABEL['constructor'] devolveria a funcao Object, que acabaria impressa como
// rotulo no resumo e no relatorio.
export const rotulo = (m) => (Object.hasOwn(LABEL, m ?? '') ? LABEL[m] : null);

// Dia 0 do mes seguinte = ultimo dia deste mes. Ano bissexto sai de graca, sem tabela de dias por
// mes.
const ultimoDia = (ano, mes) => new Date(Date.UTC(+ano, mes, 0)).getUTCDate();

/* '12' + '8' + '2026' -> '2026-08-12', ou null se o dia nao existe no calendario. Devolver null e
   proposital: */
function ddmmParaIso(dia, mes, ano) {
	if (!/^\d{4}$/.test(String(ano))) return null;
	if (!Number.isInteger(dia) || !Number.isInteger(mes)) return null;
	if (mes < 1 || mes > 12 || dia < 1 || dia > ultimoDia(ano, mes)) return null;
	return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

/* Le uma mensagem solta e devolve a transacao pronta, ou o motivo da recusa. Formato: */
export function parse(msg, { rules, hoje }) {
	const tokens = preparado(msg).split(' ').filter(Boolean);

	let cents = null,
		method = null,
		data = hoje;
	let numeros = 0,
		datas = 0,
		metodos = 0,
		dataRuim = false;
	// Uma leitura do ano por mensagem, do mesmo jeito que handle.js le o relogio uma vez so: dois
	// tokens de data na mesma mensagem tem que ser julgados pelo mesmo ano.
	const ANO = hoje.slice(0, 4);
	const sobra = [];

	for (const tk of tokens) {
		const mv = tk.match(RE_VALOR);
		if (mv) {
			// Conta todo numero, mesmo com o valor ja preenchido: e essa contagem que faz "50 mercado 30"
			// virar valor_ambiguo la embaixo.
			numeros++;
			if (cents === null) cents = toCents(mv[1]);
			continue;
		}

		// Uma rule que o usuario ensinou tem prioridade sobre o alias de metodo embutido: a rule e
		// escolha dele, o alias e chute nosso.
		if (!rules.has(tk) && isMetodo(tk)) {
			// Conta todo alias, mesmo com o metodo ja preenchido.
			metodos++;
			if (!method) method = METODOS[tk];
			continue;
		}

		if (tk === 'ontem') {
			datas++;
			data = shiftDia(hoje, -1);
			continue;
		}
		if (tk === 'anteontem') {
			datas++;
			data = shiftDia(hoje, -2);
			continue;
		}

		const md = tk.match(RE_DATA);
		if (md) {
			datas++;
			// Ano ausente cai no corrente, como sempre foi. Ano escrito tem que ser exatamente o corrente:
			const iso = (md[3] ?? ANO) === ANO ? ddmmParaIso(+md[1], +md[2], ANO) : null;
			if (iso) data = iso;
			else dataRuim = true;
			continue;
		}

		sobra.push(tk);
	}

	// A ordem destas cinco linhas e o contrato de erro, nao e arbitraria.
	//
	// 'cents === null' vem primeiro porque sem numero nenhum na mensagem a
	// queixa certa e falta de valor, nao ambiguidade.
	//
	// 'numeros > 1' vem ANTES de 'cents <= 0'. Invertido, "0 mercado 50"
	// reclamaria de valor zerado e "50 mercado 0" de ambiguidade: dois erros
	// diferentes pros mesmos tokens, quebrando a promessa de que a ordem dos
	// tokens nao importa.
	if (cents === null) return { ok: false, reason: 'sem_valor' };
	if (numeros > 1) return { ok: false, reason: 'valor_ambiguo' };
	if (cents <= 0) return { ok: false, reason: 'sem_valor' };
	if (dataRuim) return { ok: false, reason: 'data_invalida' };
	if (datas > 1) return { ok: false, reason: 'data_ambigua' };
	// Metodo por ultimo porque e o campo menos danoso de errar: valor errado mente sobre quanto, data
	// errada mente sobre o mes, metodo errado mexe so na divisao entre 'sai da conta agora' e 'vai pra
	// fatura'.
	if (metodos > 1) return { ok: false, reason: 'metodo_ambiguo' };

	// Duas palavras da descricao podem ser regras. Ganha a mais usada:
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
		// parser e confidence sao trilha de auditoria: gravados no insert e nunca lidos de volta pelo
		// bot.
		parser: 'regex',
		confidence: hit && method ? 1 : hit ? 0.8 : 0.4,
	};
}
