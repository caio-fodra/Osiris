-- Fecha o buraco que deixava a mesma categoria existir duas vezes. categories.name e 'not null
-- unique' com colacao binary (0001_init.sql:10), entao '/categoria Mercado' depois de '/categoria
-- mercado' criava uma segunda linha.

-- 1. a coluna.
alter table categories add column name_norm text;

-- 2. backfill.
update categories
   set name_norm = trim(
     lower(
       replace(replace(replace(replace(replace(replace(replace(replace(
       replace(replace(replace(replace(replace(replace(replace(replace(
       replace(replace(replace(replace(replace(replace(replace(replace(
       replace(replace(replace(replace(replace(replace(replace(replace(
       replace(replace(replace(replace(name,
         'á','a'),'Á','a'),'à','a'),'À','a'),'â','a'),'Â','a'),'ã','a'),'Ã','a'),
         'ä','a'),'Ä','a'),
         'é','e'),'É','e'),'ê','e'),'Ê','e'),'ë','e'),'Ë','e'),
         'í','i'),'Í','i'),'ï','i'),'Ï','i'),
         'ó','o'),'Ó','o'),'ô','o'),'Ô','o'),'õ','o'),'Õ','o'),'ö','o'),'Ö','o'),
         'ú','u'),'Ú','u'),'ü','u'),'Ü','u'),
         'ç','c'),'Ç','c'),'ñ','n'),'Ñ','n')
     )
   );

-- 3. guarda.
create table if not exists _guarda_0004 (ok integer not null check (ok = 1));
delete from _guarda_0004;
insert into _guarda_0004 (ok)
select case when count(*) = 0 then 1 else 0 end
  from categories
 where name_norm is null
    or name_norm glob '*[^a-z0-9 ]*';
drop table _guarda_0004;

-- 4. funde as duplicatas que ja existem, antes do indice unico:

-- 4a. o teto do grupo vai pro sobrevivente:
update categories
   set budget_cents = (select max(d.budget_cents) from categories d where d.name_norm = categories.name_norm)
 where name_norm is not null
   and exists (select 1 from categories d where d.name_norm = categories.name_norm and d.id <> categories.id);

-- 4b. lancamentos e regras passam a apontar pro sobrevivente do grupo.
update transactions
   set category_id = (
         select min(c.id) from categories c
          where c.name_norm = (select p.name_norm from categories p where p.id = transactions.category_id)
       )
 where category_id in (
         select id from categories
          where name_norm is not null
            and id <> (select min(c2.id) from categories c2 where c2.name_norm = categories.name_norm)
       );

update category_rules
   set category_id = (
         select min(c.id) from categories c
          where c.name_norm = (select p.name_norm from categories p where p.id = category_rules.category_id)
       )
 where category_id in (
         select id from categories
          where name_norm is not null
            and id <> (select min(c2.id) from categories c2 where c2.name_norm = categories.name_norm)
       );

-- 4c. as perdedoras saem, agora que nada aponta mais pra elas.
delete from categories
 where name_norm is not null
   and id <> (select min(c2.id) from categories c2 where c2.name_norm = categories.name_norm);

-- 5. a chave de verdade.
create unique index idx_cat_nome_norm on categories(name_norm);
