-- 'almoço', 'farmácia', 'água' e 'boticário' foram gravadas acentuadas em category_rules
-- pelo antigo seed.mjs, e o norm() tira o acento antes de consultar: eram inalcancaveis.

-- 1. as quatro, por extenso. Conjunto fechado, entao CASE em vez da cadeia da 0004.
update category_rules
   set keyword = case keyword
     when 'almoço' then 'almoco'
     when 'farmácia' then 'farmacia'
     when 'água' then 'agua'
     when 'boticário' then 'boticario'
   end
 where keyword in ('almoço', 'farmácia', 'água', 'boticário');

-- 2. rebuild com o CHECK que teria barrado o insert. GLOB e nao LIKE porque GLOB e
--    sensivel a caixa, e 'Mercado' precisa ser recusado. Rebuild aqui sai barato: nada
--    referencia category_rules, ao contrario de categories na 0004.
create table category_rules_novo (
  keyword text primary key check (keyword not glob '*[^a-z0-9]*' and keyword glob '*[a-z]*'),
  category_id integer not null references categories(id),
  hits integer not null default 0
);

insert into category_rules_novo (keyword, category_id, hits)
select keyword, category_id, hits from category_rules;

drop table category_rules;
alter table category_rules_novo rename to category_rules;
