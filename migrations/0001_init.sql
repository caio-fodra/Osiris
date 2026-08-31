-- Schema base. 'if not exists' porque o banco de producao foi criado a mao antes de
-- existir controle de migracao: la este arquivo e no-op, num banco novo cria tudo.
-- Nenhum insert: as categorias nascem em runtime, pelo /categoria do bot.

create table if not exists categories (
  id integer primary key autoincrement,
  name text not null unique,
  budget_cents integer
);

create table if not exists category_rules (
  keyword text primary key,
  category_id integer not null references categories(id),
  hits integer not null default 0
);

create table if not exists transactions (
  id integer primary key autoincrement,
  amount_cents integer not null,
  occurred_on text not null,
  category_id integer references categories(id),
  method text,
  description text,
  raw_message text not null,
  parser text not null,
  confidence real,
  tg_update_id integer unique,
  created_at text not null default (datetime('now'))
);

create index if not exists idx_tx_data on transactions(occurred_on);
create index if not exists idx_tx_cat on transactions(category_id);
