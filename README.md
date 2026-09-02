# osiris

Um controle de gastos pessoais que mora dentro do Telegram.

A ideia é simples: anotar gasto só funciona se for mais rápido do que esquecer. Nada de
abrir aplicativo, escolher categoria numa lista, preencher formulário. Você já está com o
Telegram aberto — então é lá que o gasto é anotado, como quem manda uma mensagem para
alguém.

## Como funciona

Você manda a despesa em uma linha:

```
32,90 mercado pix
```

E o Osiris responde confirmando o que entendeu, junto com o quanto você já gastou nessa
categoria no mês:

```
R$ 32,90 · Mercado · Pix · 15/09
52% do orçamento · resta R$ 387,50
```

Se faltou alguma coisa na mensagem, ele não reclama nem pede para escrever de novo:
manda botões embaixo da resposta para você tocar na categoria certa ou na forma de
pagamento. Um dos botões apaga o lançamento, para quando você erra de vez.

A ordem das palavras não importa, e quase tudo é opcional:

```
120 farmácia                 sem forma de pagamento, ele pergunta
45,80 uber credito 12/09     um gasto de outro dia
300 sofá 3x credito          parcelado: ele divide em 3 de R$ 100
1500                         só o valor, você completa nos botões
```

## O que ele faz

**Orçamento.** Você define um teto por categoria e ele passa a mostrar o quanto falta a
cada gasto. Quando o teto estoura, ele avisa na hora.

**Cartão de crédito.** Compra parcelada vira uma parcela por mês, sozinha, sem você
precisar lançar de novo. E ele sabe o dia em que sua fatura fecha, então consegue dizer
o que ainda cai na fatura deste mês e o que já ficou para a próxima.

**Contas fixas.** Aluguel, luz, internet, assinaturas. As de valor sempre igual ele lança
sozinho no dia certo. As que mudam todo mês — luz, água — ele pergunta o valor no dia,
e você responde com o número. Também dá para pular um mês ou pausar uma conta que você
cancelou.

**Consultas.** O resumo do mês, a lista de todos os lançamentos, e uma busca que varre todo o
histórico e soma quanto você já gastou com alguma coisa ("quanto já foi de padaria?").

**Correções.** Errou o valor, a data, a categoria? Dá para corrigir qualquer lançamento
depois, pelo número dele. E existe uma lista separada só dos gastos que ficaram sem
categoria, para você acertar tudo de uma vez quando sobrar um minuto.

Você não precisa decorar nada disso: mande qualquer coisa começando com barra e ele
responde com a lista inteira de comandos e exemplos.

## A página do mês

O Telegram é ótimo para anotar, mas ruim para olhar. Então existe também uma página na
web, só para leitura, com o mês inteiro de uma vez: o total gasto, a divisão por
categoria, o que subiu e o que caiu em relação ao mês passado, a evolução ao longo do
tempo e a lista completa de lançamentos.

A página é protegida por login e só abre para você.

## Sobre o projeto

O Osiris é feito para uma pessoa só — o dono. O bot ignora mensagem de qualquer outro
usuário do Telegram, então não adianta procurar por ele.

O código é aberto por gosto, não porque seja um produto: não tem cadastro, não tem plano
pago, não tem página de vendas. Se você quiser um igual, o caminho é rodar a sua própria
cópia, com o seu bot e o seu banco de dados.
