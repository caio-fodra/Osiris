-- Fecha o buraco que deixava '2026-99-99' entrar em occurred_on: a linha nao casa com
-- nenhum prefixo 'YYYY-MM%' e some dos relatorios, mas segue na tabela. SQLite nao tem
-- ALTER TABLE ADD CONSTRAINT, entao o CHECK exige rebuild e reparo dos dados antes.

-- 1. dia inexistente preso no ultimo dia daquele mes. date() cru rolaria '2026-02-31'
--    pra 2026-03-03.
update transactions
   set occurred_on = date(substr(occurred_on, 1, 8) || '01', '+1 month', '-1 day')
 where occurred_on is not strftime('%Y-%m-%d', occurred_on)
   and date(substr(occurred_on, 1, 8) || '01') is not null;

-- 2. lixo sem mes recuperavel ('2026-99-99'): cai pro dia do registro.
update transactions
   set occurred_on = date(created_at)
 where occurred_on is not strftime('%Y-%m-%d', occurred_on);

-- 3. method fora do dominio, que so chegava la por callback_data forjado.
update transactions
   set method = null
 where method is not null
   and method not in ('credito', 'debito', 'pix', 'dinheiro');

-- 4. rules que colidem com o vocabulario do parser: 'cred' aprendido como categoria
--    nunca mais casa com a propria rule.
delete from category_rules where keyword in
  ('credito', 'cred', 'cartao', 'c', 'debito', 'deb', 'd',
   'pix', 'dinheiro', 'din', 'especie', 'ontem', 'anteontem');

-- 5. rebuild. 'is' e nao '=': strftime devolve NULL pra '2026-99-99', e CHECK que
--    resulta NULL conta como satisfeito.
create table transactions_novo (
  id integer primary key autoincrement,
  amount_cents integer not null,
  occurred_on text not null check (occurred_on is strftime('%Y-%m-%d', occurred_on)),
  category_id integer references categories(id),
  method text check (method is null or method in ('credito', 'debito', 'pix', 'dinheiro')),
  description text,
  raw_message text not null,
  parser text not null,
  confidence real,
  tg_update_id integer unique,
  created_at text not null default (datetime('now'))
);

insert into transactions_novo
  (id, amount_cents, occurred_on, category_id, method, description,
   raw_message, parser, confidence, tg_update_id, created_at)
select id, amount_cents, occurred_on, category_id, method, description,
       raw_message, parser, confidence, tg_update_id, created_at
  from transactions;

drop table transactions;
alter table transactions_novo rename to transactions;

create index idx_tx_data on transactions(occurred_on);
create index idx_tx_cat on transactions(category_id);
