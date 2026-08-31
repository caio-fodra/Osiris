-- Dois fechamentos num rebuild so de transactions.

-- 1. reparo antes da constraint:
delete from transactions where amount_cents <= 0;

-- 2. rebuild.
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
  tg_message_id integer,
  created_at text not null default (datetime('now'))
);

-- tg_message_id fica de fora da lista: a coluna e nova e as linhas antigas nao tem esse dado.
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
-- Indice novo: onEdit procura por tg_message_id em toda edicao de mensagem.
create index idx_tx_msg on transactions(tg_message_id);
