-- Parcelamento no credito, e o dia de fechamento da fatura. '300 sofa 3x credito' vira
-- tres lancamentos de R$ 100, um em cada mes de fatura. Tres linhas e nao uma pq todo
-- relatorio filtra mes por prefixo de occurred_on, e assim nenhuma consulta muda.

-- 1. a unica configuracao global do projeto. Tabela de uma linha com check (id = 1): um
--    settings(key, value) nao expressa "inteiro de 1 a 28". O teto de 28 e o que deixa
--    as parcelas 2..N cairem no fechamento sem clamp.
create table config (
  id integer primary key check (id = 1),
  invoice_closing_day integer not null default 28 check (invoice_closing_day between 1 and 28)
);
insert into config (id) values (1);

-- 2. regras aprendidas que colidem com o token novo do parser: dali em diante 'Nx' e
--    parcelamento. Sem REGEXP no SQLite do D1, sao tres GLOBs.
delete from category_rules
 where keyword glob '[0-9]x'
    or keyword glob '[0-9][0-9]x'
    or keyword glob '[0-9][0-9][0-9]x';

-- 3. o rebuild. installment_group e o update_id da mensagem que criou a compra: unico,
--    monotonico e ja disponivel no insert. Nao cabe em tg_update_id, que e UNIQUE.
--    purchased_on guarda a data real; nas parcelas 2..N o occurred_on e sintetico.
create table transactions_novo (
  id integer primary key autoincrement,
  amount_cents integer not null check (amount_cents > 0),
  occurred_on text not null check (occurred_on is strftime('%Y-%m-%d', occurred_on)),
  category_id integer references categories(id),
  method text check (method is null or method in ('credito', 'debito', 'pix', 'dinheiro')),
  description text,
  raw_message text not null,
  parser text not null,
  confidence real,
  tg_update_id integer unique,

  installment_group integer,
  installment_no integer,
  installment_of integer,
  purchased_on text,

  created_at text not null default (datetime('now')),

  -- Os 'is not null' vem antes dos between, e essa ordem e o CHECK inteiro funcionar.
  -- SQLite avalia CHECK em logica de tres valores, e CHECK que resulta NULL passa. Sem
  -- eles, uma linha com installment_group preenchido e o resto NULL faria
  -- 'NULL between 2 and 24' dar NULL, o AND inteiro dar NULL, e meio grupo entraria.
  -- Com eles o AND da FALSE, porque falso domina o AND mesmo com NULL do outro lado.
  check (
    (installment_group is null and installment_no is null and installment_of is null and purchased_on is null)
    or (installment_group is not null
        and installment_no is not null
        and installment_of is not null
        and purchased_on is not null
        and installment_of between 2 and 24
        and installment_no between 1 and installment_of
        and purchased_on is strftime('%Y-%m-%d', purchased_on))
  )
);

insert into transactions_novo
  (id, amount_cents, occurred_on, category_id, method, description,
   raw_message, parser, confidence, tg_update_id, created_at)
select id, amount_cents, occurred_on, category_id, method, description,
       raw_message, parser, confidence, tg_update_id, created_at
  from transactions;

drop table transactions;
alter table transactions_novo rename to transactions;

-- Os dois indices que existiam, recriados.
create index idx_tx_data on transactions(occurred_on);
create index idx_tx_cat on transactions(category_id);

-- UNIQUE e nao indice comum: e ele o alvo do 'on conflict do nothing' do insert das
-- parcelas. NULL nunca conflita com NULL em indice unico do SQLite, entao as linhas sem
-- parcela convivem aqui sem restricao.
create unique index idx_tx_parcela on transactions(installment_group, installment_no);
