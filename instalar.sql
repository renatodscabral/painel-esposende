-- =====================================================================
-- PAINEL DE GESTÃO ESPOSENDE · v15 · instalação do banco no Supabase
-- Cole este arquivo INTEIRO no SQL Editor do projeto e clique em "Run".
-- Pode rodar de novo a qualquer momento (atualiza funções e regras sem apagar dados).
--
-- O que cria:
--   1. Tabela painel_docs (todos os dados do painel, um documento JSON por linha)
--   2. Funções de apoio ao login por CPF e às regras de acesso
--   3. Regras de acesso (RLS) por coleção, espelhando a matriz Ler / Modificar / Excluir
--   4. Tempo real (Realtime) da tabela
--   5. Bucket "anexos" do Storage para os PDFs de contratos e apólices
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------
-- 1. Tabela
-- ---------------------------------------------------------------------
create table if not exists public.painel_docs (
  col            text        not null,               -- coleção: lojas, funcionarios, usuarios, auditoria/<uid>/dias…
  id             text        not null,               -- código do registro
  dados          jsonb       not null default '{}'::jsonb,
  atualizado_em  timestamptz not null default now(),
  atualizado_por uuid        default auth.uid(),
  primary key (col, id)
);
alter table public.painel_docs enable row level security;
-- acesso explícito (projetos novos podem não expor tabelas automaticamente); quem decide o que cada um vê são as regras (RLS) abaixo
grant usage on schema public to anon, authenticated;
revoke all on public.painel_docs from anon;
grant select, insert, update, delete on public.painel_docs to authenticated;

create or replace function public.painel_tocar() returns trigger
language plpgsql set search_path = public as $$
begin
  new.atualizado_em := now();
  new.atualizado_por := auth.uid();
  return new;
end $$;
drop trigger if exists painel_docs_tocar on public.painel_docs;
create trigger painel_docs_tocar before insert or update on public.painel_docs
  for each row execute function public.painel_tocar();

-- ---------------------------------------------------------------------
-- 2. Funções de apoio
-- ---------------------------------------------------------------------

-- Usuário logado, só se puder usar o painel agora (ativo, senha já trocada e não desligado no RH).
create or replace function public.painel_eu() returns jsonb
language sql stable security definer set search_path = public as $$
  select u.dados
  from public.painel_docs u
  left join public.painel_docs f on f.col = 'funcionarios' and f.id = u.dados->>'funcionarioId'
  where u.col = 'usuarios' and u.id = auth.uid()::text
    and coalesce((u.dados->>'ativo')::boolean, true)
    and not coalesce((u.dados->>'trocarSenha')::boolean, false)
    and (nullif(u.dados->>'funcionarioId', '') is null
         or (f.id is not null and upper(coalesce(nullif(trim(f.dados->>'status'), ''), 'ATIVO')) not in ('DESLIGADO', 'INATIVO')))
$$;

-- Nível do usuário num módulo: -1 sem acesso ao painel · 0 nenhum · 1 ler · 2 modificar · 3 excluir · 9 Master
create or replace function public.painel_nivel_de(u jsonb, p_mod text) returns int
language sql immutable as $$
  select case
    when u is null then -1
    when u->>'perfil' = 'MASTER' then 9
    else case u->'permissoes'->>p_mod when 'ler' then 1 when 'modificar' then 2 when 'excluir' then 3 else 0 end
  end
$$;

create or replace function public.painel_nivel(p_mod text) returns int
language sql stable security definer set search_path = public as $$
  select public.painel_nivel_de(public.painel_eu(), p_mod)
$$;

create or replace function public.painel_eh_master() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(public.painel_eu()->>'perfil', '') = 'MASTER'
$$;

-- Situação do próprio login (a tela usa para explicar por que não entrou).
create or replace function public.painel_situacao() returns text
language plpgsql stable security definer set search_path = public as $$
declare u jsonb; f jsonb;
begin
  if auth.uid() is null then return 'revogado'; end if;
  select dados into u from public.painel_docs where col = 'usuarios' and id = auth.uid()::text;
  if u is null then return 'revogado'; end if;
  if not coalesce((u->>'ativo')::boolean, true) then return 'desativado'; end if;
  if nullif(u->>'funcionarioId', '') is not null then
    select dados into f from public.painel_docs where col = 'funcionarios' and id = u->>'funcionarioId';
    if f is null then return 'sem_funcionario'; end if;
    if upper(coalesce(nullif(trim(f->>'status'), ''), 'ATIVO')) in ('DESLIGADO', 'INATIVO') then return 'desligado'; end if;
  end if;
  return 'ok';
end $$;

-- Regra de acesso por coleção. u = usuário logado (painel_eu), calculado uma vez por consulta.
create or replace function public.painel_pode(p_col text, p_id text, p_acao text, u jsonb) returns boolean
language plpgsql stable set search_path = public as $$
declare
  me   text := auth.uid()::text;
  base text := split_part(p_col, '/', 1);
  pdi int; loj int; ctr int; fcx int; ret int;
begin
  if me is null then return false; end if;
  -- o próprio cadastro de acesso é sempre legível (a tela confere desativação/reset ao vivo)
  if p_col = 'usuarios' and p_id = me and p_acao = 'ler' then return true; end if;
  if u is null then return false; end if;                          -- inativo, desligado ou sem trocar a senha
  if u->>'perfil' = 'MASTER' then return true; end if;              -- Master: tudo
  if p_col = 'presenca' then return p_id = me and p_acao <> 'excluir'; end if;
  if base = 'auditoria' then return split_part(p_col, '/', 2) = me and p_acao <> 'excluir'; end if;

  pdi := public.painel_nivel_de(u, 'pdi');        loj := public.painel_nivel_de(u, 'lojas');
  ctr := public.painel_nivel_de(u, 'contratos');  fcx := public.painel_nivel_de(u, 'fcx');
  ret := public.painel_nivel_de(u, 'retaguarda');

  if p_acao = 'ler' then
    return case
      when base in ('funcionarios', 'pdi', 'rh_cargos', 'rh_centros', 'lojas', 'seguros_vigencia', 'config',
                    'credsystem', 'faltas', 'caixas', 'ieo_ocorrencias', 'ieo_fechamentos', 'ieo_laudos', 'alertas') then true
      when base = 'contratos_locacao' then ctr >= 1
      when base = 'aluguel_projecoes' then ctr >= 1 or fcx >= 1
      when base in ('fcx', 'contasBancarias', 'extratos', 'dfc') then fcx >= 1
      when base in ('adq_taxas', 'adq_auditorias', 'adq_excecoes') then ret >= 1
      when base = 'integracoes' then p_id in ('cnpj', 'armazenamento') or (p_id = 'ia' and greatest(loj, ctr, ret) >= 2)
      else false                                                     -- salarios, usuarios, presenca de outros…: só Master
    end;
  end if;

  -- gravar / excluir
  return case
    when base in ('funcionarios', 'pdi') then pdi >= case p_acao when 'excluir' then 3 else 2 end
    when base = 'lojas' then loj >= case p_acao when 'excluir' then 3 else 2 end
    when base = 'seguros_vigencia' then ctr >= 2
    when base = 'contratos_locacao' then ctr >= case p_acao when 'excluir' then 3 else 2 end
    when base = 'aluguel_projecoes' then ctr >= 2 or fcx >= 2
    when base in ('fcx', 'contasBancarias', 'extratos', 'dfc') then fcx >= 2
    when base = 'faltas' then ret >= case p_acao when 'excluir' then 3 else 2 end
    when base in ('credsystem', 'caixas', 'ieo_ocorrencias', 'ieo_fechamentos', 'ieo_laudos', 'alertas',
                  'adq_taxas', 'adq_auditorias', 'adq_excecoes') then ret >= 2
    when base = 'config' then case p_id
        when 'participacao_vendas' then ctr >= 2 or fcx >= 2
        when 'dfc' then fcx >= 2
        when 'fcx_saldos' then fcx >= 2
        when 'ieo' then ret >= 2
        else false end                                              -- folha, permissoes…: só Master
    else false                                                       -- rh_cargos, rh_centros, salarios, usuarios, integracoes: só Master
  end;
end $$;

-- ---------------------------------------------------------------------
-- 2b. Funções chamadas pelo painel (login por CPF)
-- ---------------------------------------------------------------------
create or replace function public.painel_tem_master() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.painel_docs
                 where col = 'usuarios' and dados->>'perfil' = 'MASTER' and coalesce((dados->>'ativo')::boolean, true))
$$;

-- Configuração inicial: o primeiro login vira Master (só funciona enquanto não existir nenhum Master ativo).
create or replace function public.painel_bootstrap(p_nome text, p_cpf text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_cpf text := regexp_replace(coalesce(p_cpf, ''), '\D', '', 'g'); v_email text; v_func text;
begin
  if auth.uid() is null then raise exception 'sem_login'; end if;
  perform pg_advisory_xact_lock(hashtext('painel_bootstrap'));
  if public.painel_tem_master() then raise exception 'ja_existe_master'; end if;
  select email into v_email from auth.users where id = auth.uid();
  if length(v_cpf) <> 11 or split_part(v_email, '@', 1) <> v_cpf then raise exception 'cpf_nao_confere'; end if;
  select id into v_func from public.painel_docs
   where col = 'funcionarios' and regexp_replace(coalesce(dados->>'cpf', ''), '\D', '', 'g') = v_cpf limit 1;
  insert into public.painel_docs (col, id, dados) values ('usuarios', auth.uid()::text, jsonb_strip_nulls(jsonb_build_object(
      'perfil', 'MASTER', 'funcionarioId', v_func,
      'nome', case when v_func is null then trim(p_nome) end, 'cpf', case when v_func is null then v_cpf end,
      'permissoes', '{}'::jsonb, 'ativo', true, 'trocarSenha', false,
      'criadoEm', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))))
  on conflict (col, id) do update set dados = excluded.dados;
end $$;

create or replace function public.painel_registrar_acesso() returns void
language sql security definer set search_path = public as $$
  update public.painel_docs
     set dados = dados || jsonb_build_object('ultimoAcesso', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
   where col = 'usuarios' and id = auth.uid()::text
$$;

-- Depois da troca obrigatória: libera o acesso. O banco confere que a senha deixou de ser o CPF.
create or replace function public.painel_senha_trocada() returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text; v_email text;
begin
  select encrypted_password, email into v_hash, v_email from auth.users where id = auth.uid();
  if v_hash is null then raise exception 'sem_login'; end if;
  if v_hash = extensions.crypt(split_part(v_email, '@', 1), v_hash) then raise exception 'senha_ainda_e_o_cpf'; end if;
  update public.painel_docs
     set dados = dados || jsonb_build_object('trocarSenha', false, 'senhaAlteradaEm', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
   where col = 'usuarios' and id = auth.uid()::text;
end $$;

-- Master: volta a senha de um login para o CPF (troca obrigatória no próximo acesso) e derruba as sessões abertas.
create or replace function public.painel_resetar_senha(p_uid uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_email text;
begin
  if not public.painel_eh_master() then raise exception 'apenas_master'; end if;
  select email into v_email from auth.users where id = p_uid;
  if v_email is null then raise exception 'login_inexistente'; end if;
  update auth.users set encrypted_password = extensions.crypt(split_part(v_email, '@', 1), extensions.gen_salt('bf', 10)), updated_at = now()
   where id = p_uid;
  update public.painel_docs set dados = dados || '{"trocarSenha": true}'::jsonb where col = 'usuarios' and id = p_uid::text;
  begin
    delete from auth.sessions where user_id = p_uid;
  exception when others then null;
  end;
end $$;

-- Master: localiza o login de um CPF que já existia (reativação de um acesso removido).
create or replace function public.painel_uid_por_email(p_email text) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v uuid;
begin
  if not public.painel_eh_master() then raise exception 'apenas_master'; end if;
  select id into v from auth.users where email = lower(trim(p_email));
  return v;
end $$;

-- Master: apaga o login (Supabase Auth) de um acesso removido.
create or replace function public.painel_remover_login(p_uid uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.painel_eh_master() then raise exception 'apenas_master'; end if;
  if p_uid = auth.uid() then raise exception 'nao_pode_remover_a_si_mesmo'; end if;
  delete from auth.users where id = p_uid;
end $$;

-- Quem pode chamar o quê
revoke execute on function public.painel_eu(), public.painel_nivel(text), public.painel_eh_master(), public.painel_situacao(),
  public.painel_bootstrap(text, text), public.painel_registrar_acesso(), public.painel_senha_trocada(),
  public.painel_resetar_senha(uuid), public.painel_uid_por_email(text), public.painel_remover_login(uuid) from public, anon;
grant execute on function public.painel_eu(), public.painel_nivel(text), public.painel_eh_master(), public.painel_situacao(),
  public.painel_bootstrap(text, text), public.painel_registrar_acesso(), public.painel_senha_trocada(),
  public.painel_resetar_senha(uuid), public.painel_uid_por_email(text), public.painel_remover_login(uuid) to authenticated;
grant execute on function public.painel_tem_master() to anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Regras de acesso (RLS). Visitante sem login não lê nada.
-- ---------------------------------------------------------------------
drop policy if exists painel_ler on public.painel_docs;
drop policy if exists painel_inserir on public.painel_docs;
drop policy if exists painel_alterar on public.painel_docs;
drop policy if exists painel_excluir on public.painel_docs;
create policy painel_ler on public.painel_docs for select to authenticated
  using (public.painel_pode(col, id, 'ler', (select public.painel_eu())));
create policy painel_inserir on public.painel_docs for insert to authenticated
  with check (public.painel_pode(col, id, 'gravar', (select public.painel_eu())));
create policy painel_alterar on public.painel_docs for update to authenticated
  using (public.painel_pode(col, id, 'gravar', (select public.painel_eu())))
  with check (public.painel_pode(col, id, 'gravar', (select public.painel_eu())));
create policy painel_excluir on public.painel_docs for delete to authenticated
  using (public.painel_pode(col, id, 'excluir', (select public.painel_eu())));

-- ---------------------------------------------------------------------
-- 4. Tempo real
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'painel_docs') then
    alter publication supabase_realtime add table public.painel_docs;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 5. Storage: PDFs de contratos e apólices (bucket público, só PDF, até 20 MB)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('anexos', 'anexos', true, 20971520, array['application/pdf'])
on conflict (id) do update set public = true, file_size_limit = 20971520, allowed_mime_types = array['application/pdf'];

drop policy if exists painel_anexos_enviar on storage.objects;
drop policy if exists painel_anexos_ler_master on storage.objects;
drop policy if exists painel_anexos_excluir on storage.objects;
create policy painel_anexos_enviar on storage.objects for insert to authenticated
  with check (bucket_id = 'anexos' and greatest(public.painel_nivel('lojas'), public.painel_nivel('contratos')) >= 2);
create policy painel_anexos_ler_master on storage.objects for select to authenticated
  using (bucket_id = 'anexos' and public.painel_eh_master());
create policy painel_anexos_excluir on storage.objects for delete to authenticated
  using (bucket_id = 'anexos' and public.painel_eh_master());

-- Pronto. Volte ao painel e faça a Configuração inicial (primeiro Master).
