-- amount_cents nao tinha CHECK: quem barrava valor <= 0 era uma linha do parser.js, e
-- todo caminho de escrita novo precisaria lembrar da mesma regra. Um gasto de 0 nao
-- aparece em relatorio e um negativo diminui o total do mes.

-- rebuild nao herda nada: confira o schema real, nao a memoria. Os dois CHECKs da 0002 e
-- os indices sao reescritos aqui, senao somem.
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
  created_at text not null default (datetime('now'))
);

-- O filtro no proprio insert-select e o reparo: a tabela antiga vai ser dropada mesmo.
-- Nao ha reparo defensavel pra valor 0 ou negativo, a linha nao diz quanto foi o gasto.
-- Ids explicitos, entao o sqlite_sequence continua de onde parou.
--   select count(*) from transactions where amount_cents <= 0;
insert into transactions_novo
  (id, amount_cents, occurred_on, category_id, method, description,
   raw_message, parser, confidence, tg_update_id, created_at)
select id, amount_cents, occurred_on, category_id, method, description,
       raw_message, parser, confidence, tg_update_id, created_at
  from transactions
 where amount_cents > 0;

drop table transactions;
alter table transactions_novo rename to transactions;

create index idx_tx_data on transactions(occurred_on);
create index idx_tx_cat on transactions(category_id);
