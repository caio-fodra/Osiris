-- Contas que caem todo mes no mesmo dia. Duas tabelas novas e nenhuma coluna nova em
-- transactions: o lancamento gerado e uma transaction comum, com parser = 'fixo'.

create table fixed_bills (
  id integer primary key autoincrement,

  -- name e o que o usuario digitou; name_norm e a chave, pelo mesmo motivo da 0004.
  name text not null,
  name_norm text not null unique,

  -- 'fixo' = valor conhecido, o cron lanca sozinho. 'variavel' = valor muda todo mes, o
  -- cron pergunta. O par kind/amount_cents e amarrado pelo CHECK do fim da tabela: sem
  -- ele, um bug que perdesse o valor viraria a conta em variavel calada.
  kind text not null check (kind in ('fixo', 'variavel')),
  amount_cents integer,

  -- 1..31: o vencimento e o do papel, e aluguel que vence dia 31 existe. Fevereiro sai
  -- com min(due_day, ultimo dia do mes) na hora do lancamento.
  due_day integer not null check (due_day between 1 and 31),

  -- NULL = resolve na hora do lancamento pelas category_rules. Assim um clique no botao
  -- de categoria do primeiro lancamento conserta todos os meses seguintes.
  category_id integer references categories(id),

  -- Mesmo dominio do CHECK de transactions.method: e este valor que vai direto pra la, e
  -- um dominio mais largo viraria violacao de constraint dentro do cron.
  method text check (method is null or method in ('credito', 'debito', 'pix', 'dinheiro')),

  -- 0/1 com CHECK pq SQLite nao tem boolean. Pausar e diferente de remover.
  paused integer not null default 0 check (paused in (0, 1)),

  created_at text not null default (datetime('now')),

  check (
    (kind = 'fixo' and amount_cents is not null and amount_cents > 0) or
    (kind = 'variavel' and amount_cents is null)
  )
);

-- Uma linha por (conta, mes). A PRIMARY KEY e a idempotencia do cron: disparo repetido,
-- retry manual e dois Workers acordando no mesmo minuto dao todos no mesmo resultado.
create table fixed_bill_posts (
  bill_id integer not null references fixed_bills(id) on delete cascade,

  -- 'YYYY-MM'. O CHECK monta o dia 1 e pergunta ao strftime se sobreviveu. 'is' e nao
  -- '=' pelo motivo da 0002: CHECK que resulta NULL passa.
  due_month text not null check (due_month is strftime('%Y-%m', due_month || '-01')),

  -- Sem 'references transactions(id)': com foreign keys ligadas, um drop table em
  -- transactions executa um DELETE FROM implicito que dispara as acoes de FK, e a
  -- proxima migration faz exatamente esse rebuild. Le-se "desfeito" com left join.
  transaction_id integer,

  -- 'lancado' + left join sem par le-se "lancei e ele apagou", e o cron nao tenta de
  -- novo. 'perguntado' = conta variavel esperando o valor. 'pulado' = nao cobra este mes
  -- (o dia ja tinha passado no cadastro, ou veio um /fixo pular).
  state text not null check (state in ('lancado', 'perguntado', 'pulado')),

  -- message_id da pergunta, pra reconhecer a resposta por reply_to_message.
  prompt_message_id integer,

  created_at text not null default (datetime('now')),

  primary key (bill_id, due_month)
);

-- Nenhum indice alem da PK: 84 linhas por ano, e as duas consultas sao a PK e uma
-- varredura por message_id.
