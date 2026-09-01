/* Fatura de cartao e parcelamento. O report.js ja raciocinava sobre isso. */

import { brl } from './fmt.js';
import { nomeDoMes } from './orcamento.js';

/* Aritmetica de mes sobre 'yyyy-MM', sem Date. */
export function somaMes(ym, n) {
	const a = +ym.slice(0, 4);
	const m = +ym.slice(5, 7) - 1 + n;
	const ano = a + Math.floor(m / 12);
	const mes = ((m % 12) + 12) % 12;
	return `${ano}-${String(mes + 1).padStart(2, '0')}`;
}

/* A janela de compras de uma fatura: {ini, fim}, os dois 'yyyy-MM-DD' e inclusivos. */
export function janelaFatura(ym, fechamento) {
	const d = String(fechamento).padStart(2, '0');
	return { ini: `${somaMes(ym, -1)}-${d}`, fim: `${ym}-${d}`, iniExclusivo: true };
}

/* Em qual fatura cai uma compra feita nesta data. Compra no dia do fechamento ou antes: */
export const mesFatura = (iso, fechamento) => (+iso.slice(8, 10) <= fechamento ? iso.slice(0, 7) : somaMes(iso.slice(0, 7), 1));

/* Divide o total em parcelas de centavos inteiros. A ultima absorve o resto: */
export function dividir(total, n) {
	const base = Math.floor(total / n);
	return Array.from({ length: n }, (_, i) => (i === n - 1 ? total - base * (n - 1) : base));
}

/* Uma compra parcelada -> as N linhas que vao pra transactions. A parcela 1 fica na data REAL da
   compra: */
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

/* A segunda linha do resumo quando ha parcelamento. O valor da primeira linha continua sendo o
   total digitado, que e o que o usuario acabou de mandar. */
export function linhaParcelas(total, parcelas, primeiroMes) {
	const valores = dividir(total, parcelas);
	const iguais = valores[0] === valores.at(-1);
	const faixa = `${nomeDoMes(primeiroMes)} a ${nomeDoMes(somaMes(primeiroMes, parcelas - 1))}`;
	return iguais
		? `${parcelas}x de R$ ${brl(valores[0])} · ${faixa}`
		: `${parcelas}x de R$ ${brl(valores[0])} (última R$ ${brl(valores.at(-1))}) · ${faixa}`;
}
