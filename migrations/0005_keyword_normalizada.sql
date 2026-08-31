-- Ressuscita as regras que nasceram acentuadas e nunca casaram com nada. scripts/seed.mjs inseria
-- 'almoço', 'farmácia', 'água' e 'boticário' em category_rules.

-- 1. drop antes do create:
drop table if exists _keyword_norm;

-- 2. mapa keyword atual -> keyword normalizada.
create table _keyword_norm as
select keyword as antiga,
       trim(
         lower(
           replace(replace(replace(replace(replace(replace(replace(replace(
           replace(replace(replace(replace(replace(replace(replace(replace(
           replace(replace(replace(replace(replace(replace(replace(replace(
           replace(replace(replace(replace(replace(replace(replace(replace(
           replace(replace(replace(replace(keyword,
             'á','a'),'Á','a'),'à','a'),'À','a'),'â','a'),'Â','a'),'ã','a'),'Ã','a'),
             'ä','a'),'Ä','a'),
             'é','e'),'É','e'),'ê','e'),'Ê','e'),'ë','e'),'Ë','e'),
             'í','i'),'Í','i'),'ï','i'),'Ï','i'),
             'ó','o'),'Ó','o'),'ô','o'),'Ô','o'),'õ','o'),'Õ','o'),'ö','o'),'Ö','o'),
             'ú','u'),'Ú','u'),'ü','u'),'Ü','u'),
             'ç','c'),'Ç','c'),'ñ','n'),'Ñ','n')
         )
       ) as nova
  from category_rules;

-- 3. quando a versao sem acento JA existe, os hits das duas viram um so:
update category_rules
   set hits = hits + coalesce((select sum(r.hits)
                                 from category_rules r
                                 join _keyword_norm m on m.antiga = r.keyword
                                where m.nova = category_rules.keyword
                                  and r.keyword <> category_rules.keyword), 0)
 where keyword in (select nova from _keyword_norm where antiga <> nova);

-- 4. as acentuadas que colidem saem (os hits delas foram somados no passo 3); as que nao colidem
-- com nada sao renomeadas.
delete from category_rules
 where keyword in (select antiga from _keyword_norm
                    where antiga <> nova and nova in (select keyword from category_rules));

update category_rules
   set keyword = (select m.nova from _keyword_norm m where m.antiga = category_rules.keyword)
 where keyword in (select antiga from _keyword_norm where antiga <> nova);

drop table _keyword_norm;

-- 5. rebuild com o CHECK que teria matado o bug no insert.
create table category_rules_novo (
  keyword text primary key check (keyword not glob '*[^a-z0-9]*' and keyword glob '*[a-z]*'),
  category_id integer not null references categories(id),
  hits integer not null default 0
);

insert into category_rules_novo (keyword, category_id, hits)
select keyword, category_id, hits from category_rules;

drop table category_rules;
alter table category_rules_novo rename to category_rules;
