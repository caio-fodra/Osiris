-- A mesma categoria podia existir duas vezes: name e unique com colacao BINARY, entao
-- '/categoria Mercado' depois de 'mercado' criava outra linha. A chave passa a ser
-- name_norm, o mesmo texto que o norm() do parser.js produz. name segue como o usuario
-- digitou.

-- 1. add column em vez de rebuild: categories e o lado referenciado das FKs, e drop table
--    no pai dispara um DELETE FROM implicito. Nullable pq nao ha ADD COLUMN NOT NULL.
alter table categories add column name_norm text;

-- 2. backfill. SQLite nao tem normalize() e lower() so mexe em A-Z, dai a cadeia nas
--    duas caixas. E uma aproximacao do norm(), que derruba todo diacritico Unicode e
--    colapsa espaco interno; quem cobre a diferenca e a guarda do passo 3.
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

-- 3. guarda: linha ruim insere 0 e viola o CHECK, e a migration para antes de criar um
--    indice unico sobre dado que discorda do codigo. Nao checa "so alfanumerico": o
--    norm() preserva pontuacao, e 'Casa & Jardim' esta certo.
drop table if exists _guarda_0004;
create table _guarda_0004 (ok integer not null check (ok = 1));
insert into _guarda_0004 (ok)
select case when count(*) = 0 then 1 else 0 end
  from categories
 where name_norm is null
    or name_norm glob '*[^ -~]*'
    or name_norm <> lower(name_norm)
    or name_norm glob '*  *'
    or name_norm in (select name_norm from categories group by name_norm having count(*) > 1);
drop table _guarda_0004;

-- 4. a chave. nocase nao serviria: o NOCASE do SQLite dobra so ASCII, e 'saude' depois
--    de 'Saúde' continuaria duplicando.
create unique index idx_cat_nome_norm on categories(name_norm);
