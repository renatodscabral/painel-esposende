/* =====================================================================
   v15 — NUVEM (Supabase) e INTEGRAÇÕES EXTERNAS
   ---------------------------------------------------------------------
   Tomadas prontas para plugar:
     • Banco compartilhado ... SupabaseAdapter (tabela única painel_docs + Realtime)
     • Login ................. IdSupabase (Supabase Auth; usuário = CPF, ver LOGIN_DOMINIO)
     • Arquivos (PDF) ........ Supabase Storage (bucket "anexos", URL pública)
     • CNPJ .................. BrasilAPI (padrão, gratuita) ou ReceitaWS
     • IA .................... OpenAI ou Anthropic (chave salva em Configurações de Integração)
   Configuração da instalação (arquivo config.js, ao lado do index.html):
     window.PAINEL_CONFIG = { SUPABASE_URL: 'https://xxxx.supabase.co', SUPABASE_ANON_KEY: 'eyJ…', LOGIN_DOMINIO: 'esposende.com.br' };
   Sem SUPABASE_URL o painel continua no modo local (dados neste navegador).
   As regras de acesso do banco (RLS) estão em supabase/instalar.sql.
   ===================================================================== */
const PainelConfig = () => window.PAINEL_CONFIG || {};

ICON.tomada = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v4"/></svg>';

/* ------------------------------------------------------------------ */
/*  Banco: SupabaseAdapter                                             */
/* ------------------------------------------------------------------ */
/**
 * Mesma interface do LocalAdapter (get/set/remove/list/watch/watchDoc), sobre UMA tabela:
 *   painel_docs (col text, id text, dados jsonb, atualizado_em, atualizado_por) — PK (col, id)
 * Caminho "a/b/c/d" → col "a/b/c", id "d". Tempo real: um único canal Realtime para a tabela,
 * distribuído por coleção; cada coleção assinada mantém um cache local atualizado pelos eventos.
 */
class SupabaseAdapter {
  constructor(client) {
    this.sb = client; this.tipo = 'nuvem'; this.rotulo = 'Supabase'; this.identidade = 'supabase';
    this.cols = new Map();      // col → { mapa: Map(id → doc), cbs: Set, pronto: Promise, t }
    this.docs = new Map();      // "col/id" → Set(cb)   (watchDoc)
    this.canal = null; this.estado = 'desligado';
  }
  _sp(path) { const p = String(path).split('/'); return { col: p.slice(0, -1).join('/'), id: p[p.length - 1] }; }
  _erro(error) {
    const e = new Error(error?.message || 'Erro no banco de dados.');
    if (['42501', 'PGRST301', '401', '403'].includes(String(error?.code || error?.status || ''))) e.code = 'invalid_argument';
    if (/row-level security|permission denied/i.test(error?.message || '')) e.code = 'invalid_argument';
    if (String(error?.status) === '429') e.code = 'resource_exhausted';
    return e;
  }
  async get(path) {
    const { col, id } = this._sp(path);
    const { data, error } = await this.sb.from('painel_docs').select('dados').eq('col', col).eq('id', id).maybeSingle();
    if (error) throw this._erro(error);
    return data ? { id, ...data.dados } : null;
  }
  async set(path, obj) {
    const { col, id } = this._sp(path); const dados = { ...obj }; delete dados.id;
    const { error } = await this.sb.from('painel_docs').upsert({ col, id, dados }, { onConflict: 'col,id' });
    if (error) throw this._erro(error);
  }
  /** Gravação em lote (restauração de backup): até 200 registros por chamada. */
  async setLote(col, docs) {
    for (let i = 0; i < docs.length; i += 200) {
      const linhas = docs.slice(i, i + 200).map(d => { const { id, ...dados } = d; return { col, id: String(id), dados }; });
      const { error } = await this.sb.from('painel_docs').upsert(linhas, { onConflict: 'col,id' });
      if (error) throw this._erro(error);
    }
  }
  async remove(path) {
    const { col, id } = this._sp(path);
    const { error } = await this.sb.from('painel_docs').delete().eq('col', col).eq('id', id);
    if (error) throw this._erro(error);
  }
  async list(col, o = {}) {
    const out = [], PAG = 1000;
    for (let de = 0; ; de += PAG) {
      const { data, error } = await this.sb.from('painel_docs').select('id,dados').eq('col', col).order('id').range(de, de + PAG - 1);
      if (error) throw this._erro(error);
      data.forEach(r => out.push({ id: r.id, ...r.dados }));
      if (data.length < PAG) break;
    }
    if (o.orderBy) out.sort((a, b) => (a[o.orderBy] > b[o.orderBy] ? 1 : -1) * (o.dir === 'desc' ? -1 : 1));
    return o.limit ? out.slice(0, o.limit) : out;
  }
  /* ---- tempo real ---- */
  _ligarCanal() {
    if (this.canal) return;
    this.canal = this.sb.channel('painel-docs-' + uid())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'painel_docs' }, p => this._evento(p))
      .subscribe(status => {
        const antes = this.estado; this.estado = status;
        // reconectou depois de queda: relê as coleções assinadas (eventos perdidos no meio)
        if (status === 'SUBSCRIBED' && antes && antes !== 'SUBSCRIBED' && antes !== 'desligado') this._ressincronizar();
        if (typeof Sync !== 'undefined' && status !== 'SUBSCRIBED') { const t = $('#syncTxt'); if (t && ['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) t.textContent = 'reconectando…'; }
      });
  }
  async _ressincronizar() {
    for (const [col, c] of this.cols) { try { const docs = await this.list(col); c.mapa = new Map(docs.map(d => [d.id, d])); this._avisar(col); } catch { } }
    for (const path of this.docs.keys()) this.get(path).then(d => this.docs.get(path)?.forEach(cb => cb(d))).catch(() => { });
  }
  async _evento(p) {
    const novo = p.new && p.new.col ? p.new : null, velho = p.old || {};
    const col = novo?.col || velho.col, id = novo?.id || velho.id; if (!col || id == null) return;
    let doc = null;
    if (p.eventType !== 'DELETE') {
      doc = novo.dados ? { id, ...novo.dados } : await this.get(col + '/' + id).catch(() => null); // registro grande demais para o evento: busca direto
    }
    const c = this.cols.get(col);
    if (c) { if (doc) c.mapa.set(id, doc); else c.mapa.delete(id); this._avisar(col); }
    this.docs.get(col + '/' + id)?.forEach(cb => cb(doc));
  }
  _avisar(col) {
    const c = this.cols.get(col); if (!c) return;
    clearTimeout(c.t); c.t = setTimeout(() => { const arr = [...c.mapa.values()]; c.cbs.forEach(cb => cb(arr)); }, 40); // junta rajadas (importações)
  }
  watch(col, cb, onErr) {
    this._ligarCanal();
    let c = this.cols.get(col);
    if (!c) {
      c = { mapa: new Map(), cbs: new Set(), t: null };
      c.pronto = this.list(col).then(docs => { docs.forEach(d => c.mapa.set(d.id, d)); }).catch(e => { c.erro = e; });
      this.cols.set(col, c);
    }
    c.cbs.add(cb);
    c.pronto.then(() => { if (!c.cbs.has(cb)) return; if (c.erro && onErr) onErr(c.erro); else cb([...c.mapa.values()]); });
    return () => { c.cbs.delete(cb); if (!c.cbs.size) this.cols.delete(col); };
  }
  watchDoc(path, cb) {
    this._ligarCanal();
    if (!this.docs.has(path)) this.docs.set(path, new Set());
    const s = this.docs.get(path); s.add(cb);
    this.get(path).then(d => s.has(cb) && cb(d)).catch(() => { });
    return () => { s.delete(cb); if (!s.size) this.docs.delete(path); };
  }
  /** Fim da sessão: derruba o canal e os caches (o próximo login abre um canal com o novo token). */
  reset() {
    if (this.canal) { try { this.sb.removeChannel(this.canal); } catch { } }
    this.canal = null; this.estado = 'desligado'; this.cols.clear(); this.docs.clear();
  }
}

const Nuvem = {
  client: null,
  CDN: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js',
  get configurado() { const c = PainelConfig(); return !!(c.SUPABASE_URL && c.SUPABASE_ANON_KEY); },
  /** Chave secreta (sb_secret_… ou JWT service_role) ignora todas as regras: nunca pode ir para o navegador. */
  chaveSecreta(k) { k = String(k || ''); if (/^sb_secret_/.test(k)) return true; try { return JSON.parse(atob(k.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role === 'service_role'; } catch { return false; } },
  async conectar(cfg = PainelConfig()) {
    if (this.chaveSecreta(cfg.SUPABASE_ANON_KEY)) throw new Error('O config.js está com a chave SECRETA do Supabase. Troque pela chave pública (Publishable key / anon) e gere uma nova chave secreta no Supabase');
    await Libs.carregar(Libs.src('supabase.min.js', this.CDN));
    if (!window.supabase?.createClient) throw new Error('Biblioteca do Supabase não carregou.');
    // sessão do login só nesta aba (fecha o navegador = sai), como no modo local
    let armazenamento; try { sessionStorage.setItem('esp-t', '1'); sessionStorage.removeItem('esp-t'); armazenamento = sessionStorage; } catch { armazenamento = undefined; }
    this.client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { storage: armazenamento, storageKey: 'esp-painel-auth', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
    return new SupabaseAdapter(this.client);
  },
  /** Cliente descartável (sem sessão salva): usado pelo Master para criar o login de outra pessoa sem sair da própria sessão. */
  clienteAvulso() {
    const cfg = PainelConfig();
    return window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'esp-painel-tmp-' + uid() } });
  },
  urlMascarada() { const u = PainelConfig().SUPABASE_URL || ''; return u.replace(/^https?:\/\/([^.]{4})[^.]*/, 'https://$1•••'); },
};

/* ------------------------------------------------------------------ */
/*  Login: provedores de identidade                                    */
/* ------------------------------------------------------------------ */
/**
 * Interface comum (Sessao, acessos.js, só fala com ela):
 *   temMaster() · restaurar() → {u,f}|null · autenticar(cpf,senha) → {u,f,sit}|null
 *   salvarSenha(pendente, nova) → u · criarMaster(nome,cpf,senha) → {u,f} · registrarAcesso(u)
 *   criarAcesso(f, dados) → id · resetarSenha(u, cpf) · removerAcesso(u) · situacao() → 'ok'|motivo · sair()
 */
const IdLocal = {
  async base() { const [usuarios, funcionarios] = await Promise.all([Cloud.adapter.list('usuarios'), Cloud.adapter.list('funcionarios')]); return { usuarios, funcionarios }; },
  async temMaster() { const b = await this.base(); return b.usuarios.some(u => u.perfil === 'MASTER' && u.ativo !== false); },
  async restaurar() {
    const s = Sessao.ler(); if (!s || !(s.exp > Date.now())) return null;
    const b = await this.base(), u = b.usuarios.find(x => x.id === s.uid), f = u?.funcionarioId ? b.funcionarios.find(x => x.id === u.funcionarioId) : null;
    return u && !u.trocarSenha && Sessao.situacao(u, f) === 'ok' ? { u, f, s } : null;
  },
  async autenticar(cpf, senha) {
    const b = await this.base(), achado = Sessao.localizar(b, cpf);
    if (!achado || !Senha.confere(String(senha), achado.u.senha)) return null;
    return { ...achado, sit: Sessao.situacao(achado.u, achado.f) };
  },
  async salvarSenha(p, nova) {
    const { id, ...d } = p.u, novo = { ...d, senha: Senha.gerar(nova), trocarSenha: false, senhaAlteradaEm: new Date().toISOString() };
    await Cloud.adapter.set('usuarios/' + id, novo); return { id, ...novo };
  },
  async criarMaster(nome, cpf, senha) {
    const b = await this.base(); if (b.usuarios.some(u => u.perfil === 'MASTER' && u.ativo !== false)) throw new Error('Já existe um Master. Entre com o seu CPF.');
    const f = b.funcionarios.find(x => CPF.limpar(x.cpf) === cpf);
    const id = 'usr-' + uid(), u = { perfil: 'MASTER', ...(f ? { funcionarioId: f.id } : { nome, cpf }), permissoes: {}, ativo: true, senha: Senha.gerar(senha), trocarSenha: false, criadoEm: new Date().toISOString() };
    await Cloud.adapter.set('usuarios/' + id, u); return { u: { id, ...u }, f: f || null };
  },
  async registrarAcesso(u) { const { id, ...d } = u; const em = new Date().toISOString(); await Cloud.adapter.set('usuarios/' + id, { ...d, ultimoAcesso: em }); return { ...u, ultimoAcesso: em }; },
  async criarAcesso(f, dados) {
    const id = 'usr-' + uid();
    await Repo.salvar('usuarios', id, { ...dados, senha: Senha.gerar(CPF.limpar(f.cpf)) }, { modulo: 'acessos', rotulo: `Acesso · ${f.nome}`, detalhe: 'Acesso ativado (senha inicial = CPF)' });
    return id;
  },
  async resetarSenha(u, cpf, rotulo) { const { id, ...d } = u; await Repo.salvar('usuarios', id, { ...d, senha: Senha.gerar(cpf), trocarSenha: true }, { modulo: 'acessos', rotulo, detalhe: 'Senha resetada para o CPF' }); },
  async removerAcesso(u, rotulo) { await Repo.excluir('usuarios', u.id, { modulo: 'acessos', rotulo }); },
  async situacao() { return null; }, // no modo local a vigia já observa usuário e funcionário
  async sair() { },
};

const IdSupabase = {
  get sb() { return Nuvem.client; },
  dominio() { return String(PainelConfig().LOGIN_DOMINIO || 'esposende.com.br').replace(/^@/, '').trim().toLowerCase(); },
  email(cpf) { return CPF.limpar(cpf) + '@' + this.dominio(); },
  async rpc(nome, args = {}) { const { data, error } = await this.sb.rpc(nome, args); if (error) throw this.erro(error); return data; },
  erro(e) {
    const m = String(e?.message || e || ''), c = e?.code || '';
    if (/rate limit|too many/i.test(m) || c === 'over_request_rate_limit') return new Error('Muitas tentativas seguidas. Aguarde um minuto e tente de novo.');
    if (/same_password|different from the old/i.test(m + c)) return new Error('A nova senha precisa ser diferente da atual.');
    if (/weak_password|password should/i.test(m + c)) return new Error('O banco recusou a senha por ser fraca. Use mais caracteres, letras e números.');
    if (/email.*invalid|email_address_invalid/i.test(m + c)) return new Error(`O Supabase recusou o domínio de login "@${this.dominio()}". Ajuste LOGIN_DOMINIO no config.js (veja o LEIA-ME).`);
    if (/signups? not allowed|signup_disabled/i.test(m + c)) return new Error('O cadastro de logins está desligado no Supabase (Authentication → Sign In / Providers → "Allow new users to sign up").');
    if (/Failed to fetch|NetworkError|network/i.test(m)) return new Error('Sem conexão com o banco de dados. Verifique a internet/intranet.');
    if (/ja_existe_master/.test(m)) return new Error('Já existe um Master. Entre com o seu CPF.');
    if (/apenas_master/.test(m)) return new Error('Ação restrita ao Master.');
    if (/cpf_nao_confere/.test(m)) return new Error('O CPF não confere com o login criado. Tente de novo.');
    if (/senha_ainda_e_o_cpf/.test(m)) return new Error('A senha nova não pode ser o CPF.');
    if (/function .* does not exist|Could not find the function|PGRST202/i.test(m + c)) return new Error('O banco ainda não foi preparado: rode o script supabase/instalar.sql no SQL Editor do Supabase.');
    return new Error(m || 'Erro no banco de dados.');
  },
  async temMaster() { return !!(await this.rpc('painel_tem_master')); },
  async _carregar(uidAuth) {
    const u = await Cloud.adapter.get('usuarios/' + uidAuth).catch(() => null);
    if (!u) return { u: null, f: null, sit: 'revogado' };
    const sit = await this.rpc('painel_situacao');
    const f = sit === 'ok' && u.funcionarioId && !u.trocarSenha ? await Cloud.adapter.get('funcionarios/' + u.funcionarioId).catch(() => null) : null;
    return { u, f, sit };
  },
  async restaurar() {
    const s = Sessao.ler(); const { data } = await this.sb.auth.getSession(); const ses = data?.session;
    if (!ses || !s || !(s.exp > Date.now()) || s.uid !== ses.user.id) { if (ses) await this.sb.auth.signOut({ scope: 'local' }).catch(() => { }); return null; }
    const r = await this._carregar(ses.user.id);
    return r.u && r.sit === 'ok' && !r.u.trocarSenha ? { ...r, s } : null;
  },
  async autenticar(cpf, senha) {
    const { data, error } = await this.sb.auth.signInWithPassword({ email: this.email(cpf), password: String(senha) });
    if (error) {
      if (/invalid login|invalid_credentials|email not confirmed/i.test(error.message + (error.code || ''))) return null; // mensagem única (não revela quais CPFs existem)
      throw this.erro(error);
    }
    const r = await this._carregar(data.user.id);
    if (r.sit !== 'ok') await this.sb.auth.signOut({ scope: 'local' }).catch(() => { });
    return r;
  },
  async salvarSenha(p, nova) {
    const { error } = await this.sb.auth.updateUser({ password: nova }); if (error) throw this.erro(error);
    await this.rpc('painel_senha_trocada');
    return (await Cloud.adapter.get('usuarios/' + p.u.id)) || { ...p.u, trocarSenha: false };
  },
  async criarMaster(nome, cpf, senha) {
    if (await this.temMaster()) throw new Error('Já existe um Master. Entre com o seu CPF.');
    let { data, error } = await this.sb.auth.signUp({ email: this.email(cpf), password: senha });
    if (error && /already registered|user_already_exists/i.test(error.message + (error.code || ''))) ({ data, error } = await this.sb.auth.signInWithPassword({ email: this.email(cpf), password: senha }));
    if (error) throw this.erro(error);
    if (!data.session) throw new Error('O Supabase pediu confirmação de e-mail. Desligue "Confirm email" em Authentication → Sign In / Providers → Email e tente de novo.');
    await this.rpc('painel_bootstrap', { p_nome: nome, p_cpf: cpf });
    const r = await this._carregar(data.user.id); if (!r.u) throw new Error('Não foi possível criar o Master.');
    return r;
  },
  async registrarAcesso(u) { await this.rpc('painel_registrar_acesso').catch(() => { }); return { ...u, ultimoAcesso: new Date().toISOString() }; },
  /** Cria o login no Supabase Auth (senha = CPF) com um cliente descartável e grava o vínculo em usuarios/<id do login>. */
  async criarAcesso(f, dados) {
    const cpf = CPF.limpar(f.cpf), tmp = Nuvem.clienteAvulso();
    let id;
    const { data, error } = await tmp.auth.signUp({ email: this.email(cpf), password: cpf });
    if (error && !/already registered|user_already_exists/i.test(error.message + (error.code || ''))) throw this.erro(error);
    if (!error && data?.user?.id && (data.user.identities || []).length) id = data.user.id;
    else { // login já existia (acesso removido antes): reaproveita e volta a senha para o CPF
      id = await this.rpc('painel_uid_por_email', { p_email: this.email(cpf) });
      if (!id) throw new Error('Não foi possível localizar o login deste CPF no Supabase.');
      await this.rpc('painel_resetar_senha', { p_uid: id });
    }
    try { await tmp.auth.signOut({ scope: 'local' }); } catch { }
    await Repo.salvar('usuarios', id, dados, { modulo: 'acessos', rotulo: `Acesso · ${f.nome}`, detalhe: 'Acesso ativado (senha inicial = CPF)' });
    return id;
  },
  async resetarSenha(u, cpf, rotulo) {
    await this.rpc('painel_resetar_senha', { p_uid: u.id });
    const { id, ...d } = u; await Repo.salvar('usuarios', id, { ...d, trocarSenha: true }, { modulo: 'acessos', rotulo, detalhe: 'Senha resetada para o CPF' });
  },
  async removerAcesso(u, rotulo) {
    await Repo.excluir('usuarios', u.id, { modulo: 'acessos', rotulo });
    await this.rpc('painel_remover_login', { p_uid: u.id }).catch(e => console.warn('login não removido do Auth', e));
  },
  async situacao() { return this.rpc('painel_situacao'); },
  async sair() { try { await this.sb.auth.signOut({ scope: 'local' }); } catch { } },
};

/* ------------------------------------------------------------------ */
/*  IA: OpenAI / Anthropic (chamada direta do navegador)               */
/* ------------------------------------------------------------------ */
const IA_PROVEDORES = {
  openai: { rotulo: 'OpenAI', modelo: 'gpt-5.4-mini', dica: 'Chave começa com "sk-". Crie em platform.openai.com → API keys.' },
  anthropic: { rotulo: 'Anthropic (Claude)', modelo: 'claude-sonnet-5', dica: 'Chave começa com "sk-ant-". Crie em console.anthropic.com → API Keys.' },
};
const IAProvedor = {
  blobBase64(b) { return new Promise((ok, err) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = err; r.readAsDataURL(b); }); },
  /** Extrai o primeiro objeto JSON do texto (aceita ```json … ``` e texto em volta). */
  extrairJSON(t) {
    const s = String(t || '').replace(/```(?:json)?/gi, '').trim();
    try { return JSON.parse(s); } catch { }
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i >= 0 && j > i) { try { return JSON.parse(s.slice(i, j + 1)); } catch { } }
    throw new Error('A IA não devolveu um JSON válido. Tente de novo.');
  },
  erroHTTP(status, corpo, rotulo) {
    const msg = corpo?.error?.message || '';
    if (status === 401 || status === 403) return new Error(`Chave de API da ${rotulo} recusada. Confira em Configurações de Integração.`);
    if (status === 429) return new Error(`Limite ou crédito da ${rotulo} esgotado (${msg || 'erro 429'}).`);
    if (status === 404 || /model/i.test(msg)) return new Error(`Modelo não encontrado na ${rotulo}: confira o nome do modelo. ${msg}`);
    return new Error(`${rotulo}: ${msg || 'erro ' + status}`);
  },
  async postar(url, headers, body, rotulo) {
    let r; try { r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }); }
    catch { throw new Error(`Não foi possível conectar à ${rotulo}. Verifique a internet ou se a rede da empresa bloqueia o endereço.`); }
    const j = await r.json().catch(() => null);
    if (!r.ok) throw this.erroHTTP(r.status, j, rotulo);
    return j;
  },
  /** Monta o provedor no formato usado pelo painel (Cloud.caps.sample): fn(texto) → {text}; .json(texto) → objeto; .limits(). */
  criar(cfg) {
    const prov = cfg.provedor === 'anthropic' ? 'anthropic' : 'openai', info = IA_PROVEDORES[prov], modelo = String(cfg.modelo || info.modelo).trim(), chave = String(cfg.chave || '').trim();
    const SISTEMA = 'Você é um assistente de análise de documentos da Esposende. Responda em português do Brasil.';
    const chamar = async (input, opts = {}) => {
      const imgs = await Promise.all((opts.images || []).map(async b => ({ tipo: b.type || 'image/jpeg', dados: await this.blobBase64(b) })));
      const sistema = SISTEMA + (opts.json ? ' Responda APENAS com um objeto JSON válido, sem texto antes ou depois.' : '');
      if (prov === 'openai') {
        const content = imgs.length ? [{ type: 'text', text: input }, ...imgs.map(i => ({ type: 'image_url', image_url: { url: `data:${i.tipo};base64,${i.dados}` } }))] : input;
        const body = { model: modelo, messages: [{ role: 'system', content: sistema }, { role: 'user', content }], max_completion_tokens: 16000 };
        if (opts.json) body.response_format = { type: 'json_object' };
        const j = await this.postar('https://api.openai.com/v1/chat/completions', { authorization: 'Bearer ' + chave }, body, info.rotulo);
        return j?.choices?.[0]?.message?.content || '';
      }
      const content = [...imgs.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.tipo, data: i.dados } })), { type: 'text', text: input }];
      const j = await this.postar('https://api.anthropic.com/v1/messages', { 'x-api-key': chave, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        { model: modelo, max_tokens: 8000, system: sistema, messages: [{ role: 'user', content }] }, info.rotulo);
      return (j?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    };
    const f = async (input, opts = {}) => ({ text: await chamar(input, opts) });
    f.json = async (input, opts = {}) => this.extrairJSON(await chamar(input, { ...opts, json: true }));
    f.limits = async () => ({ maxInputBytes: 300000, images: { maxCount: 8 } });
    f.provedor = prov; f.modelo = modelo;
    return f;
  },
};

/* ------------------------------------------------------------------ */
/*  CNPJ: BrasilAPI (padrão) / ReceitaWS                               */
/* ------------------------------------------------------------------ */
const CNPJ_PROVEDORES = { brasilapi: 'BrasilAPI (gratuita)', receitaws: 'ReceitaWS (gratuita, 3 consultas/min)' };
const CNPJProvedor = {
  async brasilapi(d) {
    let r; try { r = await fetch('https://brasilapi.com.br/api/cnpj/v1/' + d); } catch { throw Object.assign(new Error('BrasilAPI indisponível.'), { tentarOutro: true }); }
    if (r.status === 404) throw new Error('CNPJ não encontrado na Receita Federal.');
    if (!r.ok) throw Object.assign(new Error('BrasilAPI respondeu com erro ' + r.status + '.'), { tentarOutro: true });
    return r.json();
  },
  /** ReceitaWS (API pública) não libera CORS: usa JSONP. Converte para o formato da BrasilAPI. */
  receitaws(d) {
    return new Promise((ok, err) => {
      const cb = 'rws_' + uid(), s = document.createElement('script'); let fim;
      const limpar = () => { clearTimeout(fim); delete window[cb]; s.remove(); };
      window[cb] = j => {
        limpar();
        if (!j || j.status === 'ERROR') return err(new Error(j?.message || 'CNPJ não encontrado na ReceitaWS.'));
        const ab = String(j.abertura || '').split('/');
        ok({ razao_social: j.nome, nome_fantasia: j.fantasia, descricao_situacao_cadastral: j.situacao, logradouro: j.logradouro, numero: j.numero, complemento: j.complemento, bairro: j.bairro,
          municipio: j.municipio, uf: j.uf, cep: String(j.cep || '').replace(/\D/g, ''), cnae_fiscal_descricao: j.atividade_principal?.[0]?.text, data_inicio_atividade: ab.length === 3 ? `${ab[2]}-${ab[1]}-${ab[0]}` : '' });
      };
      s.onerror = () => { limpar(); err(Object.assign(new Error('ReceitaWS indisponível.'), { tentarOutro: true })); };
      fim = setTimeout(() => { limpar(); err(Object.assign(new Error('ReceitaWS não respondeu (limite de 3 consultas por minuto).'), { tentarOutro: true })); }, 12000);
      s.src = `https://receitaws.com.br/v1/cnpj/${d}?callback=${cb}`; document.head.appendChild(s);
    });
  },
  /** Consulta no provedor escolhido; se ele estiver fora do ar, tenta o outro. */
  criar(cfg) {
    const prim = cfg.provedor === 'receitaws' ? 'receitaws' : 'brasilapi', sec = prim === 'brasilapi' ? 'receitaws' : 'brasilapi';
    return async d => { try { return await this[prim](d); } catch (e) { if (!e.tentarOutro) throw e; return this[sec](d); } };
  },
};

/* ------------------------------------------------------------------ */
/*  Arquivos: Supabase Storage                                         */
/* ------------------------------------------------------------------ */
const ArmazenamentoSupabase = {
  criar(bucket = 'anexos') {
    return {
      bucket,
      async upload(file, pasta = 'documentos') {
        const sb = Nuvem.client; if (!sb) throw new Error('Banco de dados não conectado.');
        const nome = String(file.name || 'arquivo.pdf').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_').slice(-80);
        const id = (crypto.randomUUID ? crypto.randomUUID() : uid() + uid());
        const caminho = `${pasta}/${Datas.hojeISO().slice(0, 7)}/${id}-${nome}`;
        const { error } = await sb.storage.from(bucket).upload(caminho, file, { contentType: file.type || 'application/pdf', upsert: false });
        if (error) throw new Error(/row-level|policy|403|unauthorized/i.test(error.message) ? 'Seu perfil não tem permissão para enviar arquivos.' : /mime|type/i.test(error.message) ? 'Tipo de arquivo não aceito (envie PDF).' : /size|large/i.test(error.message) ? 'Arquivo grande demais (máx. 20 MB).' : 'Falha no envio do arquivo: ' + error.message);
        const { data } = sb.storage.from(bucket).getPublicUrl(caminho);
        return { id: null, url: data.publicUrl, contentType: file.type || 'application/pdf', caminho };
      },
    };
  },
};

/* ------------------------------------------------------------------ */
/*  Configurações de Integração (só Master)                            */
/* ------------------------------------------------------------------ */
/**
 * Documentos: integracoes/ia {provedor, modelo, chave, ativo} · integracoes/cnpj {provedor, ativo}
 *             integracoes/armazenamento {ativo, bucket}
 * Regras do banco: leitura do CNPJ e do armazenamento por qualquer usuário ativo; da IA só por quem pode
 * modificar Lojas, Contratos ou Retaguarda (eles usam a leitura por IA); gravação só Master.
 */
const Integracoes = {
  COL: 'integracoes', ui: { testes: {} }, _un: null,
  iniciar() {
    this.parar();
    this._un = Cloud.adapter.watch(this.COL, docs => this.aplicar(docs), () => this.aplicar([]));
    Repo._unsubs.push(() => this.parar());
  },
  parar() { if (this._un) { try { this._un(); } catch { } this._un = null; } this.aplicar([]); },
  doc(docs, id) { return docs.find(d => d.id === id) || null; },
  /** Liga ou desliga as tomadas conforme a configuração salva. */
  aplicar(docs) {
    const ia = this.doc(docs, 'ia'), cnpj = this.doc(docs, 'cnpj'), arq = this.doc(docs, 'armazenamento');
    Cloud.caps.sample = ia && ia.ativo !== false && ia.chave ? IAProvedor.criar(ia) : null;
    Receita.provedor = !cnpj || cnpj.ativo !== false ? CNPJProvedor.criar(cnpj || {}) : null; // CNPJ vem ligado por padrão (API gratuita)
    Cloud.caps.assets = Cloud.nuvem && (!arq || arq.ativo !== false) ? ArmazenamentoSupabase.criar(arq?.bucket || 'anexos') : null;
    if (Sessao.ativa) App.agendarRender();
  },
  mascarar(k) { k = String(k || ''); return k.length > 10 ? k.slice(0, k.startsWith('sk-ant') ? 7 : 3) + '•••••' + k.slice(-4) : k ? '•••••' : ''; },

  render() {
    if (!Auth.can('integracoes.gerir')) return '<div class="panel"><div class="empty">As Configurações de Integração são restritas ao perfil Master.</div></div>';
    const head = `<div class="page-head"><div><h1>Configurações de Integração</h1><p>Conexões com serviços externos: banco de dados, consulta de CNPJ, leitura de contratos e apólices por IA e armazenamento dos PDFs. As chaves ficam salvas no banco e só o Master altera.</p></div></div>`;
    if (!Repo.prontas.has(this.COL)) return head + '<div class="panel"><p class="muted" style="margin:0">Carregando…</p></div>';
    const docs = Repo.todos(this.COL), ia = this.doc(docs, 'ia') || {}, cnpj = this.doc(docs, 'cnpj') || {}, arq = this.doc(docs, 'armazenamento') || {};
    const t = this.ui.testes, res = k => t[k] ? `<div class="note ${t[k].ok ? 'ok-note' : 'warn'} int-res" role="status" style="margin-top:10px">${esc(t[k].msg)}</div>` : '';
    const estado = (on, txt) => `<span class="pill ${on ? 'ok' : 'neutral'}">${esc(txt)}</span>`;
    const iaOn = !!Cloud.caps.sample, provIA = ia.provedor || 'openai';

    const banco = `<div class="panel int-card"><div class="int-top"><div class="int-ico">${ICON.backup}</div><div><h2>Banco de dados</h2><p class="sub">Onde ficam todos os dados, usuários e permissões do painel.</p></div>${estado(Cloud.nuvem, Cloud.nuvem ? 'Supabase conectado' : 'Modo local')}</div>
      ${Cloud.nuvem ? `<div class="grid g3 int-kv"><div><span class="lbl">Projeto</span><b class="mono">${esc(Nuvem.urlMascarada())}</b></div><div><span class="lbl">Tempo real</span><b>${Cloud.adapter.estado === 'SUBSCRIBED' ? 'ativo' : esc(Cloud.adapter.estado || '—')}</b></div><div><span class="lbl">Domínio de login</span><b class="mono">@${esc(IdSupabase.dominio())}</b></div></div>
        <p class="hint" style="margin:10px 0 0">A URL e a chave pública do Supabase ficam no arquivo <b>config.js</b> da instalação (ou nas variáveis de ambiente SUPABASE_URL e SUPABASE_ANON_KEY na Vercel).</p>`
        : `<div class="note warn" style="margin-top:6px">Os dados estão só neste navegador. Para conectar o banco compartilhado, preencha SUPABASE_URL e SUPABASE_ANON_KEY no arquivo <b>config.js</b> e rode o script <b>supabase/instalar.sql</b> (passo a passo no LEIA-ME).</div>`}</div>`;

    const cardCnpj = `<div class="panel int-card"><div class="int-top"><div class="int-ico">${ICON.loja}</div><div><h2>Consulta de CNPJ</h2><p class="sub">No cadastro de loja (Módulo 2), ao digitar um CNPJ válido o painel busca razão social, endereço, cidade, UF e CEP na Receita Federal.</p></div>${estado(!!Receita.provedor, Receita.provedor ? 'Ligada' : 'Desligada')}</div>
      <form class="form-grid" data-int-form="cnpj">
        ${campo('Serviço', 'provedor', cnpj.provedor || 'brasilapi', { opcoes: Object.entries(CNPJ_PROVEDORES) })}
        <div class="field"><span class="lbl">Situação</span><label class="check" style="padding-top:8px"><input type="checkbox" name="ativo" ${cnpj.ativo !== false ? 'checked' : ''}> Consulta automática ligada</label></div>
        <p class="hint full" style="margin:0">Não precisa de chave. Se o serviço escolhido estiver fora do ar, o painel tenta o outro automaticamente.</p>
        <div class="field"><label class="lbl" for="intCnpjTeste">CNPJ para teste</label><input id="intCnpjTeste" type="text" inputmode="numeric" placeholder="00.000.000/0000-00" value="${esc(t.cnpjValor || '')}"></div>
        <div class="row full"><button class="btn" type="button" data-a="int-salvar" data-k="cnpj">Salvar</button><button class="btn sec" type="button" data-a="int-testar" data-k="cnpj">Testar consulta</button></div></form>${res('cnpj')}</div>`;

    const cardIA = `<div class="panel int-card"><div class="int-top"><div class="int-ico">${ICON.ia}</div><div><h2>Leitor de contratos e apólices por IA</h2><p class="sub">O texto do PDF é extraído no navegador e enviado à API escolhida, que devolve os dados estruturados: no contrato, locador, vigência, índice e valores; na apólice, coberturas, prêmios, carências e condições de pagamento.</p></div>${estado(iaOn, iaOn ? 'Ligada · ' + (IA_PROVEDORES[provIA]?.rotulo || '') : 'Desligada')}</div>
      <form class="form-grid" data-int-form="ia">
        ${campo('Provedor', 'provedor', provIA, { opcoes: Object.entries(IA_PROVEDORES).map(([k, v]) => [k, v.rotulo]), attrs: 'data-int-prov' })}
        ${campo('Modelo', 'modelo', ia.modelo || IA_PROVEDORES[provIA].modelo, { dica: `Padrão: ${IA_PROVEDORES[provIA].modelo}. Pode trocar por outro modelo disponível na sua conta.` })}
        <div class="field full"><label class="lbl" for="intChave">Chave de API (${provIA === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'})</label><div class="login-senha"><input id="intChave" name="chave" type="password" autocomplete="off" spellcheck="false" placeholder="${ia.chave ? 'Salva: ' + esc(this.mascarar(ia.chave)) + ' · deixe vazio para manter' : 'Cole a chave aqui'}"><button type="button" class="iconbtn" data-ver-senha aria-label="Mostrar chave">${ICON.olho}</button></div><span class="hint" style="margin-top:4px">${esc(IA_PROVEDORES[provIA].dica)}</span></div>
        <div class="field"><span class="lbl">Situação</span><label class="check" style="padding-top:8px"><input type="checkbox" name="ativo" ${ia.ativo !== false ? 'checked' : ''}> Leitura por IA ligada</label></div>
        <div class="row full"><button class="btn" type="button" data-a="int-salvar" data-k="ia">Salvar</button><button class="btn sec" type="button" data-a="int-testar" data-k="ia" ${ia.chave ? '' : 'disabled'}>Testar conexão</button>${ia.chave ? '<button class="btn ghost" type="button" data-a="int-remover-chave">Remover chave</button>' : ''}</div></form>
      <div class="note" style="margin-top:12px">A chamada sai do navegador de quem usa o leitor, então a chave fica acessível a quem pode <b>modificar</b> Lojas, Contratos ou Retaguarda. Crie uma chave só para o painel e defina um <b>limite de gasto mensal</b> no site do provedor.</div>${res('ia')}</div>`;

    const cardArq = `<div class="panel int-card"><div class="int-top"><div class="int-ico">${ICON.pdf}</div><div><h2>Armazenamento de PDFs</h2><p class="sub">Contratos e apólices anexados vão para o Storage do Supabase; o registro guarda a URL do arquivo.</p></div>${estado(!!Cloud.caps.assets, Cloud.caps.assets ? 'Ligado' : Cloud.nuvem ? 'Desligado' : 'Requer o Supabase')}</div>
      ${Cloud.nuvem ? `<form class="form-grid" data-int-form="armazenamento">
        ${campo('Bucket', 'bucket', arq.bucket || 'anexos', { dica: 'Criado pelo script de instalação (público, só PDF, até 20 MB).' })}
        <div class="field"><span class="lbl">Situação</span><label class="check" style="padding-top:8px"><input type="checkbox" name="ativo" ${arq.ativo !== false ? 'checked' : ''}> Envio de PDFs ligado</label></div>
        <div class="row full"><button class="btn" type="button" data-a="int-salvar" data-k="armazenamento">Salvar</button><button class="btn sec" type="button" data-a="int-testar" data-k="armazenamento">Testar envio</button></div></form>
        <p class="hint" style="margin:10px 0 0">O endereço de cada arquivo leva um código aleatório e não aparece em listagens, mas quem tiver o link consegue abrir o PDF.</p>${res('armazenamento')}`
        : '<p class="muted" style="margin:0">Conecte o banco de dados (Supabase) para ligar o armazenamento.</p>'}</div>`;

    return head + banco + `<div class="grid g2 int-grid">${cardCnpj}${cardIA}</div>` + cardArq;
  },
  afterRender() { },
  ler(k) { const f = $(`[data-int-form="${k}"]`); return f ? UI.lerForm(f) : {}; },
  async salvar(k) {
    const atual = Repo.get(this.COL, k) || {}, d = this.ler(k), novo = { ...atual };
    delete novo.id;
    novo.ativo = !!d.ativo;
    if (k === 'cnpj') novo.provedor = d.provedor;
    if (k === 'armazenamento') novo.bucket = String(d.bucket || 'anexos').trim();
    if (k === 'ia') {
      novo.provedor = d.provedor; novo.modelo = String(d.modelo || '').trim() || IA_PROVEDORES[d.provedor].modelo;
      const chave = String(d.chave || '').trim(); if (chave) novo.chave = chave;
      if (novo.ativo && !novo.chave) { UI.toast('Cole a chave de API para ligar a leitura por IA.'); return; }
      if (chave && d.provedor === 'openai' && !/^sk-/.test(chave)) { UI.toast('A chave da OpenAI começa com "sk-".'); return; }
      if (chave && d.provedor === 'anthropic' && !/^sk-ant-/.test(chave)) { UI.toast('A chave da Anthropic começa com "sk-ant-".'); return; }
    }
    // a auditoria registra a mudança, nunca a chave
    const det = k === 'ia' ? `Provedor ${novo.provedor} · modelo ${novo.modelo}${d.chave ? ' · chave trocada' : ''}` : '';
    await Repo.salvar(this.COL, k, novo, { modulo: 'integracoes', rotulo: 'Integração · ' + k, detalhe: det, semAudit: k === 'ia' });
    if (k === 'ia') await Audit.registrar({ modulo: 'integracoes', acao: 'alterou', entidade: this.COL, entidadeId: k, rotulo: 'Integração · IA', mudancas: [], detalhe: det });
    delete this.ui.testes[k]; UI.toast('Configuração salva.'); App.render();
  },
  async testar(k, botao) {
    const t = this.ui.testes; botao && (botao.disabled = true);
    try {
      if (k === 'cnpj') {
        const v = $('#intCnpjTeste')?.value || ''; t.cnpjValor = v;
        if (!CNPJ.valido(v)) throw new Error('Digite um CNPJ válido para testar.');
        const d = this.ler('cnpj'), r = await CNPJProvedor.criar({ provedor: d.provedor })(CNPJ.limpar(v));
        t.cnpj = { ok: true, msg: `OK: ${r.razao_social || '—'} · ${r.municipio || ''}/${r.uf || ''} · ${r.descricao_situacao_cadastral || ''}` };
      }
      if (k === 'ia') {
        const salvo = Repo.get(this.COL, 'ia') || {}, d = this.ler('ia');
        const f = IAProvedor.criar({ provedor: d.provedor, modelo: d.modelo, chave: String(d.chave || '').trim() || salvo.chave });
        const j = await f.json('Teste de conexão. Responda exatamente {"ok":true,"mensagem":"conectado"}');
        t.ia = { ok: !!j.ok, msg: j.ok ? `Conectado à ${IA_PROVEDORES[f.provedor].rotulo} com o modelo ${f.modelo}.` : 'A IA respondeu, mas fora do formato esperado.' };
      }
      if (k === 'armazenamento') {
        const d = this.ler('armazenamento'), st = ArmazenamentoSupabase.criar(d.bucket || 'anexos');
        const pdf = new File(['%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'], 'teste-integracao.pdf', { type: 'application/pdf' });
        const r = await st.upload(pdf, 'teste');
        const ok = (await fetch(r.url).catch(() => null))?.ok;
        await Nuvem.client.storage.from(st.bucket).remove([r.caminho]).catch(() => { });
        t.armazenamento = { ok: !!ok, msg: ok ? 'Envio e leitura do PDF de teste funcionaram (arquivo de teste já apagado).' : 'O envio funcionou, mas a URL pública não abriu: confira se o bucket está marcado como público.' };
      }
    } catch (e) { t[k] = { ok: false, msg: e.message || String(e) }; }
    App.render();
  },
  async acao(a, el) {
    if (a === 'int-salvar') return this.salvar(el.dataset.k);
    if (a === 'int-testar') return this.testar(el.dataset.k, el);
    if (a === 'int-remover-chave') {
      if (!(await UI.confirmar('Remover chave de API', 'A leitura por IA será desligada para todos até uma nova chave ser salva.', 'Remover', true))) return;
      const { id, chave, ...d } = Repo.get(this.COL, 'ia') || {};
      await Repo.salvar(this.COL, 'ia', { ...d, ativo: false }, { modulo: 'integracoes', rotulo: 'Integração · IA', detalhe: 'Chave removida', semAudit: true });
      await Audit.registrar({ modulo: 'integracoes', acao: 'alterou', entidade: this.COL, entidadeId: 'ia', rotulo: 'Integração · IA', mudancas: [], detalhe: 'Chave removida' });
      return App.render();
    }
  },
  mudanca(a, el) { },
};
// troca de provedor de IA: atualiza modelo padrão e dicas sem perder o que foi digitado
document.addEventListener('change', e => {
  if (!e.target.matches?.('[data-int-prov]')) return;
  const f = e.target.closest('form'), prov = e.target.value, mod = f.querySelector('[name="modelo"]');
  if (mod && Object.values(IA_PROVEDORES).some(p => p.modelo === mod.value.trim())) mod.value = IA_PROVEDORES[prov].modelo;
  const lbl = f.querySelector('label[for="intChave"]'); if (lbl) lbl.textContent = `Chave de API (${prov === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'})`;
  const dica = f.querySelector('#intChave')?.closest('.field')?.querySelector('.hint'); if (dica) dica.textContent = IA_PROVEDORES[prov].dica;
});
