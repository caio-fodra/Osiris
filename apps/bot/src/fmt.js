// Formatador no topo do modulo: toLocaleString constroi um Intl.NumberFormat por
// chamada, e resolver locale pelo ICU custa mais que o format() em si.
const FORMATO_BRL = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const brl = (c) => FORMATO_BRL.format(c / 100);

const FORMATO_BRL_INT = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }); // p/ a tabela do /orcamento

export const brlInt = (c) => FORMATO_BRL_INT.format(Math.round(c / 100));

export const dia = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

// Dentro de um bloco ``` do MarkdownV2 so a crase e a barra invertida continuam especiais.
const escMd = (s) => String(s).replace(/([`\\])/g, '\\$1');

// Sem a cerca, linha terminada em '.' faz o sendMessage responder 400. Ela tambem da a
// fonte monoespacada que alinha as colunas do relatorio.
export const bloco = (linhas) => '```\n' + linhas.map(escMd).join('\n') + '\n```';
