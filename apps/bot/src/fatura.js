import { brl } from './fmt.js';
import { nomeDoMes } from './orcamento.js';

export function somaMes(ym, n) {
	const a = +ym.slice(0, 4);
	const m = +ym.slice(5, 7) - 1 + n;
	const ano = a + Math.floor(m / 12);
	const mes = ((m % 12) + 12) % 12;
	return `${ano}-${String(mes + 1).padStart(2, '0')}`;
}

/**
 * @param {string} ym          'YYYY-MM' da fatura
 * @param {number} fechamento  dia do fechamento, 1..28 pelo CHECK da 0008
 * @returns {{ini:string,fim:string}} janela de compras com 'ini' EXCLUSIVO e 'fim'
 *   inclusivo, do jeito que os chamadores usam: occurred_on > ini and occurred_on <= fim
 */
export function janelaFatura(ym, fechamento) {
	const d = String(fechamento).padStart(2, '0');
	// Comparacao de texto, nao date(): occurred_on e sempre 'YYYY-MM-DD' pelo CHECK da 0002.
	return { ini: `${somaMes(ym, -1)}-${d}`, fim: `${ym}-${d}` };
}

// A regra do cartao, escrita num lugar so.
export const mesFatura = (iso, fechamento) => (+iso.slice(8, 10) <= fechamento ? iso.slice(0, 7) : somaMes(iso.slice(0, 7), 1));

// R$ 100,00 em 3x = 33,33 / 33,33 / 33,34. A ultima sai por subtracao, entao a soma
// fecha com o total por construcao e nao por sorte de arredondamento.
export function dividir(total, n) {
	const base = Math.floor(total / n);
	return Array.from({ length: n }, (_, i) => (i === n - 1 ? total - base * (n - 1) : base));
}

/**
 * @param {{amount_cents:number,occurred_on:string,parcelas:number,fechamento:number}} compra
 * @returns {object[]} as N linhas de transactions. A parcela 1 fica na data real da
 *   compra; as 2..N caem no dia do fechamento, contadas a partir do mes de fatura e nao
 *   do mes do calendario, senao as parcelas 1 e 2 caem na mesma fatura.
 */
export function parcelasDe({ amount_cents, occurred_on, parcelas, fechamento }) {
	const valores = dividir(amount_cents, parcelas);
	const faturaDaCompra = mesFatura(occurred_on, fechamento);
	const d = String(fechamento).padStart(2, '0');

	return valores.map((v, i) => ({
		amount_cents: v,
		occurred_on: i === 0 ? occurred_on : `${somaMes(faturaDaCompra, i)}-${d}`,
		installment_no: i + 1,
		installment_of: parcelas,
		purchased_on: occurred_on,
	}));
}

export function linhaParcelas(total, parcelas, primeiroMes) {
	const valores = dividir(total, parcelas);
	const iguais = valores[0] === valores.at(-1);
	const faixa = `${nomeDoMes(primeiroMes)} a ${nomeDoMes(somaMes(primeiroMes, parcelas - 1))}`;
	return iguais
		? `${parcelas}x de R$ ${brl(valores[0])} · ${faixa}`
		: `${parcelas}x de R$ ${brl(valores[0])} (última R$ ${brl(valores.at(-1))}) · ${faixa}`;
}
