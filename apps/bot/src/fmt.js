// Centavos -> '1.234,56'. Nunca use toFixed aqui:
export const brl = (c) =>
	(c / 100).toLocaleString('pt-BR', {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	});

// '2026-08-12' -> '12/08'.
export const dia = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

// Escapa so o que conseguiria furar a cerca de codigo. Dentro de um bloco ``` do MarkdownV2 a crase
// e a barra invertida sao os unicos caracteres ainda especiais.
const escMd = (s) => String(s).replace(/([`\\])/g, '\\$1');

/* Envolve as linhas numa cerca de codigo antes de mandar pro Telegram. O relatorio e enviado com
   parse_mode MarkdownV2, onde '.', '-', '(' e mais uma duzia de caracteres exigem barra invertida. */
export const bloco = (linhas) => '```\n' + linhas.map(escMd).join('\n') + '\n```';
